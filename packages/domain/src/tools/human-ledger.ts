import { schema, type Database } from '@watchtower/db';
import { rateBudgetFor, type RateActor } from '@watchtower/shared';
import { and, eq, sql } from 'drizzle-orm';

import { acquireRateBudget, type RateRefusal } from './rate-budget.js';

/**
 * The audit and the budget of a tool run that a person (or the system, for the status panel)
 * started, in the same `tool_execution` table the AI's ledger writes (T-203d, N2): one row per call,
 * the input as a keyed hash, never the input or the result. A person is not held to the per-run and
 * per-ticket limits of the AI; the shared minute window and the role of the person are the limits.
 */

export interface HumanToolEntry {
  readonly runKey: string;
  readonly ticketId: string | null;
  /** `human` for a person at a ticket, `status_panel` for the ops view. */
  readonly agent: string;
  readonly tool: string;
  readonly inputHash: string;
  /** The answer came from a fake or a sandbox, not the real system. */
  readonly mock: boolean;
  readonly actor: Exclude<RateActor, 'ai'>;
  /** The person pressing the button: one person's share of the minute is capped. Absent for the system. */
  readonly personId?: string | undefined;
}

export type HumanToolDecision =
  | { readonly allowed: true; readonly id: string }
  | { readonly allowed: false; readonly retryAfterMs: number; readonly reason: RateRefusal };

export interface HumanToolLedger {
  begin(entry: HumanToolEntry): Promise<HumanToolDecision>;
  finish(
    id: string,
    result: {
      readonly status: 'ok' | 'error';
      readonly errorCode: string | null;
      readonly latencyMs: number;
      readonly resultCount: number | null;
    },
  ): Promise<void>;
}

const safeCode = (code: string | null): string | null =>
  code === null ? null : code.replaceAll(/[^A-Za-z0-9_]/g, '').slice(0, 60) || 'Error';

export function createHumanToolLedger(options: {
  readonly db: Pick<Database['db'], 'insert' | 'update' | 'transaction'>;
  readonly project?: string;
}): HumanToolLedger {
  const { db } = options;
  return {
    async begin(entry) {
      return db.transaction(async (tx): Promise<HumanToolDecision> => {
        const decision = await acquireRateBudget(tx, {
          ...rateBudgetFor(entry.tool, options.project === undefined ? {} : { project: options.project }),
          actor: entry.actor,
          personId: entry.personId,
        });
        const base = {
          ticketId: entry.ticketId,
          runKey: entry.runKey,
          agent: entry.agent,
          tool: entry.tool,
          intent: null,
          stage: null,
          inputHash: entry.inputHash,
          mock: entry.mock,
        };
        if (!decision.granted) {
          await tx.insert(schema.toolExecution).values({
            ...base,
            status: 'denied',
            errorCode: decision.reason === 'person' ? 'person_rate' : 'tool_rate',
            finishedAt: sql`now()`,
          });
          return { allowed: false, retryAfterMs: decision.retryAfterMs, reason: decision.reason };
        }
        const [created] = await tx
          .insert(schema.toolExecution)
          .values({ ...base, status: 'running' })
          .returning({ id: schema.toolExecution.id });
        if (created === undefined) throw new Error('tool_execution insert returned no row');
        return { allowed: true, id: created.id };
      });
    },

    async finish(id, result) {
      await db
        .update(schema.toolExecution)
        .set({
          status: result.status,
          errorCode: safeCode(result.errorCode),
          latencyMs: Math.max(0, Math.trunc(result.latencyMs)),
          resultCount: result.resultCount,
          finishedAt: sql`now()`,
        })
        .where(and(eq(schema.toolExecution.id, id), eq(schema.toolExecution.status, 'running')));
    },
  };
}
