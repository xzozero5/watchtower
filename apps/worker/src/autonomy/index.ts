import type { Database } from '@watchtower/db';
import {
  findRollbackReason,
  generateGateReport,
  intentsAtStage3,
  notifyAutonomyRollback,
  type Domain,
  type RollbackRule,
} from '@watchtower/domain';
import { AUTONOMY_JOBS } from '@watchtower/shared';
import { schema } from '@watchtower/db';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { WorkerLogger } from '../logger.js';
import type { ProcessorContext } from '../processors/index.js';
import type { RealtimeSink } from '../realtime.js';

/**
 * `autonomy-watch` (T-304e, ADR-025 section 7) and the weekly gate reports (T-304f). The watch looks at the
 * intents at stage 3 for the rollback conditions of the owner's decision 4 and, when one holds, moves the
 * intent back to stage 2 (`rollback_intent_autonomy()`, idempotent) and tells the heads. It runs on an event
 * (a grade was recorded, a ticket was reopened, a CSAT answer came: one job per intent per minute) and every
 * 15 minutes, which also covers an event that was missed. It only ever lowers a stage.
 */

export interface AutonomyDeps {
  readonly database: Pick<Database, 'db'>;
  readonly domain: Domain;
  readonly realtime: RealtimeSink;
  readonly logger: WorkerLogger;
}

export interface WatchResult {
  readonly checked: number;
  readonly rolledBack: readonly { readonly intent: string; readonly rule: RollbackRule }[];
}

const SYSTEM = { type: 'system', id: null } as const;

export async function runAutonomyWatch(deps: AutonomyDeps, onlyIntentId?: string): Promise<WatchResult> {
  const { database, domain, logger } = deps;
  const db = database.db;
  const intents =
    onlyIntentId === undefined
      ? await intentsAtStage3(db)
      : await db
          .select({ id: schema.intent.id, key: schema.intent.key })
          .from(schema.intent)
          .where(and(eq(schema.intent.id, onlyIntentId), eq(schema.intent.autonomyStage, 3)));
  const rolledBack: { intent: string; rule: RollbackRule }[] = [];
  for (const intent of intents) {
    try {
      const finding = await findRollbackReason(db, intent.id);
      if (finding === null) continue;
      const ctx = domain.context({ actor: SYSTEM });
      const result = await db.transaction((tx) =>
        domain.autonomy.rollbackIntent(tx, ctx, {
          intentId: intent.id,
          reason: finding.reason.slice(0, 500),
          evidence: { rule: finding.rule, ...finding.evidence },
        }),
      );
      // Idempotent: a second run (or a second worker) finds the intent already at stage 2 and writes nothing.
      if (!result.value.rolledBack) continue;
      for (const event of result.events) await deps.realtime.publish(event).catch(() => undefined);
      rolledBack.push({ intent: intent.key, rule: finding.rule });
      logger.warn({ intent: intent.key, rule: finding.rule }, 'intent rolled back from stage 3 to 2');
      const notice = await notifyAutonomyRollback(db, ctx, {
        intentId: intent.id,
        intentKey: intent.key,
        rule: finding.rule,
      });
      for (const event of notice.events) {
        await deps.realtime.publish(event).catch((error: unknown) => {
          logger.warn({ err: error, eventType: event.type }, 'realtime publish failed');
        });
      }
    } catch (error) {
      // One intent failing must not stop the others; the next run looks again.
      logger.error({ err: error, intent: intent.key }, 'autonomy watch failed for an intent');
    }
  }
  return { checked: intents.length, rolledBack };
}

/** A weekly report for every active intent at stage 2 or 3, then the watch (a red report is a rollback rule). */
export async function runWeeklyReports(deps: AutonomyDeps): Promise<{ readonly reports: number } & WatchResult> {
  const db = deps.database.db;
  const intents = await db
    .select({ id: schema.intent.id, key: schema.intent.key })
    .from(schema.intent)
    .where(and(eq(schema.intent.isActive, true), inArray(schema.intent.autonomyStage, [2, 3])));
  let reports = 0;
  for (const intent of intents) {
    try {
      const ctx = deps.domain.context({ actor: SYSTEM });
      await generateGateReport(db, ctx, {
        intentId: intent.id,
        trigger: 'weekly',
        generatedBy: null,
      });
      reports += 1;
    } catch (error) {
      deps.logger.error({ err: error, intent: intent.key }, 'weekly gate report failed for an intent');
    }
  }
  return { reports, ...(await runAutonomyWatch(deps)) };
}

const watchJobSchema = z.object({ intentId: z.uuid().optional() });

export function createAutonomyRegistration(context: ProcessorContext): Processor {
  const deps: AutonomyDeps = {
    database: context.database,
    domain: context.domain,
    realtime: context.realtime,
    logger: context.logger,
  };
  return async (job: Job): Promise<unknown> => {
    switch (job.name) {
      case AUTONOMY_JOBS.watch: {
        const parsed = watchJobSchema.safeParse(job.data);
        if (!parsed.success) throw new UnrecoverableError('autonomy job payload is invalid');
        const result = await runAutonomyWatch(deps, parsed.data.intentId);
        if (result.rolledBack.length > 0) deps.logger.warn(result, 'autonomy watch');
        return result;
      }
      case AUTONOMY_JOBS.weeklyReports:
        return runWeeklyReports(deps);
      default:
        throw new UnrecoverableError(`unknown autonomy job "${job.name}"`);
    }
  };
}
