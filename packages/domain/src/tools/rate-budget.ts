import { sql } from 'drizzle-orm';
import type { Database } from '@watchtower/db';
import type { RateActor, RateBudgetSpec } from '@watchtower/shared';

/**
 * The shared rate budget (T-203b, ADR-015 section 3). Every caller of a quota-limited API takes one
 * unit here before it calls: the AI's investigator, a person pressing a button, the status panel.
 *
 * The window is the last 60 seconds in one-second slots of `rate_budget_window`. The sum of the
 * window is read, and the decision made, under an advisory lock of the resource inside the caller's
 * transaction, so two processes cannot both take the last unit. The only clock is the database's
 * (`clock_timestamp()`); a process clock never decides (ADR-015 section 2, lesson of T-122). The
 * window includes the current second and the 60 before it, so the count is never lower than what a
 * provider counting any 60-second span would see.
 */

export type RateTx = Pick<Database['db'], 'execute'>;

export type RateDecision =
  | { readonly granted: true; readonly total: number; readonly ai: number }
  | {
      readonly granted: false;
      /** `total`: the whole budget is used. `ai`: the AI's share is used. */
      readonly reason: 'total' | 'ai';
      readonly retryAfterMs: number;
      readonly total: number;
      readonly ai: number;
    };

export interface AcquireInput extends RateBudgetSpec {
  readonly actor: RateActor;
}

interface WindowRow extends Record<string, unknown> {
  total: number | string;
  ai: number | string;
  oldest_ms: number | string | null;
  now_ms: number | string;
}

/** Slots older than this are of no use to any decision and are removed. */
const KEEP_SECONDS = 120;

/**
 * Takes one unit from the window of `input.resource` or says why not. Call it inside a transaction:
 * the advisory lock lives until that transaction ends, and the unit is only kept if it commits.
 */
export async function acquireRateBudget(tx: RateTx, input: AcquireInput): Promise<RateDecision> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.resource}, 3))`);
  await tx.execute(sql`
    DELETE FROM rate_budget_window
    WHERE resource = ${input.resource}
      AND slot < date_trunc('second', clock_timestamp()) - make_interval(secs => ${KEEP_SECONDS})
  `);
  const used = await tx.execute<WindowRow>(sql`
    SELECT COALESCE(sum(total), 0)::int AS total,
           COALESCE(sum(ai), 0)::int AS ai,
           (extract(epoch FROM min(slot)) * 1000)::bigint AS oldest_ms,
           (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
    FROM rate_budget_window
    WHERE resource = ${input.resource}
      AND slot >= date_trunc('second', clock_timestamp()) - interval '60 seconds'
  `);
  const row = used.rows[0];
  const total = Number(row?.total ?? 0);
  const ai = Number(row?.ai ?? 0);
  const oldest = row?.oldest_ms === null || row?.oldest_ms === undefined ? null : Number(row.oldest_ms);
  const now = Number(row?.now_ms ?? 0);
  const wait = oldest === null ? 1000 : Math.max(1, oldest + 61_000 - now);

  if (total >= input.totalPerMinute) {
    return { granted: false, reason: 'total', retryAfterMs: wait, total, ai };
  }
  if (input.actor === 'ai' && ai >= input.aiPerMinute) {
    return { granted: false, reason: 'ai', retryAfterMs: wait, total, ai };
  }
  const aiUnit = input.actor === 'ai' ? 1 : 0;
  await tx.execute(sql`
    INSERT INTO rate_budget_window (resource, slot, total, ai)
    VALUES (${input.resource}, date_trunc('second', clock_timestamp()), 1, ${aiUnit})
    ON CONFLICT (resource, slot) DO UPDATE
      SET total = rate_budget_window.total + 1, ai = rate_budget_window.ai + ${aiUnit}
  `);
  return { granted: true, total: total + 1, ai: ai + aiUnit };
}

/** The same, in a transaction of its own. */
export async function takeRateBudget(
  db: Pick<Database['db'], 'transaction'>,
  input: AcquireInput,
): Promise<RateDecision> {
  return db.transaction((tx) => acquireRateBudget(tx, input));
}
