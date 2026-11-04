import { schema, type Database } from '@watchtower/db';
import {
  AI_OUTBOX_JOB_OPTIONS,
  AUTONOMY_JOBS,
  QUEUE_NAMES,
  type RealtimeEvent,
} from '@watchtower/shared';
import { and, desc, eq, sql } from 'drizzle-orm';

import { enqueueJob } from '../outbox.js';
import { notifyIn } from '../notifications.js';
import { Effects, type DbTransaction, type DomainContext } from '../types.js';

/**
 * The automatic rollback of stage 3 (ADR-025 section 7, owner decision 4). `findRollbackReason` looks at one
 * intent that is at stage 3 and says which rule, if any, asks for a rollback; the worker (`autonomy-watch`)
 * then calls `rollbackIntentAutonomy` (idempotent) and `notifyAutonomyRollback`. Only tickets that are not seed
 * data count, and only what happened after the promotion.
 *
 *  1. `violation`: a policy or data-leak violation (the grader's verdict on a resolved ticket an automatic reply
 *     handled, or on a sampled grade): immediately, one is enough.
 *  2. `reopen_or_csat`: among the last 20 automatic replies of the intent, at least 2 were followed by a reopen
 *     or answered with CSAT 2 or less.
 *  3. `pre_send_fail`: 3 or more of the last 20 pre-send grades of the intent did not pass.
 *  4. `gate_red`: the latest gate report of the intent since the promotion is red.
 * Changing the model, the prompt or the procedure without a passing replay suspends auto-send instead of rolling
 * back (a later task).
 */

export const ROLLBACK_RULES = ['violation', 'reopen_or_csat', 'pre_send_fail', 'gate_red'] as const;
export type RollbackRule = (typeof ROLLBACK_RULES)[number];

/** The window of the count rules (the last N automatic replies / grades). */
export const WATCH_LAST_N = 20;
export const WATCH_REOPEN_OR_CSAT_MIN = 2;
export const WATCH_PRE_SEND_FAIL_MIN = 3;
export const WATCH_CSAT_LOW = 2;
/** Criteria whose failure suspends auto-send but never rolls an intent back. */
const REPLAY_CRITERIA: ReadonlySet<string> = new Set(['eval_replay_violations', 'redaction_eval']);

export interface RollbackFinding {
  readonly rule: RollbackRule;
  /** A short sentence for the history row and the audit log (3 to 500 characters). */
  readonly reason: string;
  /** Counts only. */
  readonly evidence: Readonly<Record<string, unknown>>;
}

type WatchDb = Pick<Database['db'], 'select' | 'execute'>;

interface CountRow extends Record<string, unknown> {
  n: string;
  bad: string;
}

/** Why the intent should go back to stage 2, or null. Reads only; the caller acts. */
export async function findRollbackReason(
  db: WatchDb,
  intentId: string,
): Promise<RollbackFinding | null> {
  const [promoted] = await db
    .select({ at: schema.intentAutonomyHistory.changedAt })
    .from(schema.intentAutonomyHistory)
    .where(
      and(
        eq(schema.intentAutonomyHistory.intentId, intentId),
        eq(schema.intentAutonomyHistory.change, 'promotion'),
      ),
    )
    .orderBy(desc(schema.intentAutonomyHistory.changedAt))
    .limit(1);
  const since = (promoted?.at ?? new Date(0)).toISOString();

  // 1. A violation: one is enough.
  const violations = await db.execute<{ n: string } & Record<string, unknown>>(sql`
    SELECT (
      (SELECT count(*) FROM ai_resolution_grade g
         JOIN ticket t ON t.id = g.ticket_id AND t.intent_id = ${intentId}::uuid
                      AND t.seed_batch_id IS NULL AND t.ai_handled
        WHERE g.violation_count > 0 AND NOT g.mock AND g.graded_at >= ${since}::timestamptz)
      +
      (SELECT count(*) FROM ai_grade ag
         JOIN ticket t ON t.id = ag.ticket_id AND t.intent_id = ${intentId}::uuid
                      AND t.seed_batch_id IS NULL AND t.ai_handled
        WHERE ag.phase = 'sampled' AND ag.violation_count > 0 AND NOT ag.mock
          AND ag.graded_at >= ${since}::timestamptz)
    ) AS n
  `);
  const violationCount = Number(violations.rows[0]?.n ?? 0);
  if (violationCount > 0) {
    return {
      rule: 'violation',
      reason: `The grader found ${String(violationCount)} policy violation(s) in automatic replies since the promotion`,
      evidence: { violations: violationCount },
    };
  }

  // 2. Reopened, or CSAT 2 or less, among the last 20 automatic replies.
  const replies = await db.execute<CountRow>(sql`
    WITH last AS (
      SELECT od.ticket_id, od.sent_at
        FROM outbound_delivery od
        JOIN ticket t ON t.id = od.ticket_id AND t.intent_id = ${intentId}::uuid AND t.seed_batch_id IS NULL
       WHERE od.origin = 'ai_auto' AND od.state = 'sent' AND od.sent_at >= ${since}::timestamptz
       ORDER BY od.sent_at DESC
       LIMIT ${WATCH_LAST_N}
    )
    SELECT count(*) AS n,
           count(*) FILTER (WHERE
             EXISTS (SELECT 1 FROM ticket_event te WHERE te.ticket_id = l.ticket_id
                       AND te.type = 'ticket.reopened' AND te.created_at > l.sent_at)
             OR EXISTS (SELECT 1 FROM csat_survey cs WHERE cs.ticket_id = l.ticket_id
                          AND cs.status = 'answered' AND cs.score <= ${WATCH_CSAT_LOW})
           ) AS bad
      FROM last l
  `);
  const sent = Number(replies.rows[0]?.n ?? 0);
  const bad = Number(replies.rows[0]?.bad ?? 0);
  if (bad >= WATCH_REOPEN_OR_CSAT_MIN) {
    return {
      rule: 'reopen_or_csat',
      reason: `${String(bad)} of the last ${String(sent)} automatic replies were reopened or rated ${String(WATCH_CSAT_LOW)} or less`,
      evidence: { bad, lastSent: sent, csatAtMost: WATCH_CSAT_LOW },
    };
  }

  // 3. Pre-send grades that did not pass.
  const grades = await db.execute<CountRow>(sql`
    WITH last AS (
      SELECT ag.passed, ag.violation_count
        FROM ai_grade ag
        JOIN ticket t ON t.id = ag.ticket_id AND t.intent_id = ${intentId}::uuid AND t.seed_batch_id IS NULL
       WHERE ag.phase = 'pre_send' AND NOT ag.mock AND ag.graded_at >= ${since}::timestamptz
       ORDER BY ag.graded_at DESC
       LIMIT ${WATCH_LAST_N}
    )
    SELECT count(*) AS n, count(*) FILTER (WHERE NOT passed OR violation_count > 0) AS bad FROM last
  `);
  const graded = Number(grades.rows[0]?.n ?? 0);
  const failed = Number(grades.rows[0]?.bad ?? 0);
  if (failed >= WATCH_PRE_SEND_FAIL_MIN) {
    return {
      rule: 'pre_send_fail',
      reason: `${String(failed)} of the last ${String(graded)} pre-send grades did not pass`,
      evidence: { failed, lastGraded: graded },
    };
  }

  // 4. The latest gate report since the promotion is red.
  const [report] = await db
    .select({
      id: schema.autonomyGateReport.id,
      status: schema.autonomyGateReport.status,
      criteria: schema.autonomyGateReport.criteria,
    })
    .from(schema.autonomyGateReport)
    .where(
      and(
        eq(schema.autonomyGateReport.intentId, intentId),
        sql`${schema.autonomyGateReport.generatedAt} >= ${since}::timestamptz`,
      ),
    )
    .orderBy(desc(schema.autonomyGateReport.generatedAt))
    .limit(1);
  // A failed replay or redaction eval makes the report red, but it only suspends auto-send (replay_missing, ADR-025
  // section 7, T-306e C-4): it never rolls an intent back. A red that has any other failing criterion does.
  const failing = report?.criteria.filter((criterion) => criterion.pass === false) ?? [];
  const replayOnly =
    failing.length > 0 && failing.every((criterion) => REPLAY_CRITERIA.has(criterion.key));
  if (report?.status === 'red' && !replayOnly) {
    return {
      rule: 'gate_red',
      reason: 'The latest gate report of this intent is red',
      evidence: { reportId: report.id },
    };
  }
  return null;
}

/** Intents at stage 3 (the only ones the watch looks at). */
export async function intentsAtStage3(
  db: Pick<Database['db'], 'select'>,
): Promise<{ id: string; key: string }[]> {
  return db
    .select({ id: schema.intent.id, key: schema.intent.key })
    .from(schema.intent)
    .where(eq(schema.intent.autonomyStage, 3));
}

/**
 * Tells the heads that an intent went back to stage 2 (`autonomy.rollback`, T-304e). One notification per head
 * per rollback; the data holds the intent key and the rule, never customer text. Returns the realtime events for
 * the caller to publish after the commit.
 */
export async function notifyAutonomyRollback(
  db: Pick<Database['db'], 'transaction'>,
  ctx: DomainContext,
  input: { readonly intentId: string; readonly intentKey: string; readonly rule: RollbackRule },
): Promise<{ readonly created: number; readonly events: RealtimeEvent[] }> {
  const fx = new Effects();
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: schema.intentAutonomyHistory.id })
      .from(schema.intentAutonomyHistory)
      .where(
        and(
          eq(schema.intentAutonomyHistory.intentId, input.intentId),
          eq(schema.intentAutonomyHistory.change, 'auto_rollback'),
        ),
      )
      .orderBy(desc(schema.intentAutonomyHistory.changedAt))
      .limit(1);
    const heads = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.role, 'head'), eq(schema.users.status, 'active')));
    return notifyIn(tx, ctx, fx, {
      kind: 'autonomy.rollback',
      severity: 'high',
      recipients: heads.map((head) => head.id),
      dedupeKey: `autonomy.rollback:${input.intentId}:${row?.id ?? ctx.now().getTime().toString()}`,
      data: { intent: input.intentKey, rule: input.rule },
    });
  });
  return { created, events: fx.events };
}

/**
 * Asks the worker to look at an intent now (an event: a grade was recorded, a ticket was reopened, a CSAT
 * answer came). Only for an intent at stage 3, and at most one job per intent per minute; the periodic run
 * every 15 minutes covers a trigger that was missed.
 */
export async function enqueueAutonomyWatch(
  tx: DbTransaction,
  ctx: Pick<DomainContext, 'config' | 'now'>,
  intentId: string | null,
  reason: 'grade_recorded' | 'ticket_reopened' | 'csat_responded',
): Promise<void> {
  if (intentId === null) return;
  const [intent] = await tx
    .select({ stage: schema.intent.autonomyStage })
    .from(schema.intent)
    .where(eq(schema.intent.id, intentId))
    .limit(1);
  if (intent === undefined || intent.stage < 3) return;
  const minute = Math.floor(ctx.now().getTime() / 60_000);
  await enqueueJob(tx, ctx.config, {
    queue: QUEUE_NAMES.autonomy,
    name: AUTONOMY_JOBS.watch,
    jobId: `autonomy-watch-${intentId}-${String(minute)}`,
    payload: { intentId, reason },
    options: AI_OUTBOX_JOB_OPTIONS,
  });
}
