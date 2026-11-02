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
 *
 * Who may take what:
 *  - the AI at most `aiPerMinute`, and only while the total is not used;
 *  - people and the system together never take the last `aiFloorPerMinute` units of the total, so a
 *    busy minute of clicking cannot leave the AI with nothing;
 *  - one person (`personId`) at most `personPerMinute`, kept as a window of their own under the same
 *    lock, so one agent cannot use up what their colleagues share.
 */

export type RateTx = Pick<Database['db'], 'execute'>;

export type RateRefusal = 'total' | 'ai' | 'people' | 'person';

export type RateDecision =
  | { readonly granted: true; readonly total: number; readonly ai: number }
  | {
      readonly granted: false;
      /**
       * `total`: the whole budget is used. `ai`: the AI's share is used. `people`: what is left is the
       * AI's floor. `person`: this person has taken their share of the minute.
       */
      readonly reason: RateRefusal;
      readonly retryAfterMs: number;
      readonly total: number;
      readonly ai: number;
    };

export interface AcquireInput extends RateBudgetSpec {
  readonly actor: RateActor;
  /** The person asking, for the personal cap. Absent for the AI and the system. */
  readonly personId?: string | undefined;
}

interface WindowRow extends Record<string, unknown> {
  total: number | string;
  ai: number | string;
  oldest_ms: number | string | null;
  now_ms: number | string;
}

/** Slots older than this are of no use to any decision and are removed. */
const KEEP_SECONDS = 120;

const WINDOW = sql`slot >= date_trunc('second', clock_timestamp()) - interval '60 seconds'`;

/** The resource of one person's own window: `person_logging:<user id>`. */
export function personResource(resource: string, personId: string): string {
  return `person_${resource.slice(0, resource.indexOf(':'))}:${personId}`;
}

async function read(tx: RateTx, resource: string): Promise<WindowRow | undefined> {
  const used = await tx.execute<WindowRow>(sql`
    SELECT COALESCE(sum(total), 0)::int AS total,
           COALESCE(sum(ai), 0)::int AS ai,
           (extract(epoch FROM min(slot)) * 1000)::bigint AS oldest_ms,
           (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
    FROM rate_budget_window
    WHERE resource = ${resource} AND ${WINDOW}
  `);
  return used.rows[0];
}

const waitFor = (row: WindowRow | undefined): number => {
  const oldest = row?.oldest_ms === null || row?.oldest_ms === undefined ? null : Number(row.oldest_ms);
  const now = Number(row?.now_ms ?? 0);
  return oldest === null ? 1000 : Math.max(1, oldest + 61_000 - now);
};

/**
 * Takes one unit from the window of `input.resource` or says why not. Call it inside a transaction:
 * the advisory lock lives until that transaction ends, and the unit is only kept if it commits.
 */
export async function acquireRateBudget(tx: RateTx, input: AcquireInput): Promise<RateDecision> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.resource}, 3))`);
  // Old slots of this resource, and of every person's window (those are only ever written under a
  // resource lock, so sweeping them here cannot race a reader that matters).
  await tx.execute(sql`
    DELETE FROM rate_budget_window
    WHERE (resource = ${input.resource} OR resource LIKE 'person%')
      AND slot < date_trunc('second', clock_timestamp()) - make_interval(secs => ${KEEP_SECONDS})
  `);
  const row = await read(tx, input.resource);
  const total = Number(row?.total ?? 0);
  const ai = Number(row?.ai ?? 0);
  const wait = waitFor(row);
  const refuse = (reason: RateRefusal, retryAfterMs = wait): RateDecision => ({
    granted: false,
    reason,
    retryAfterMs,
    total,
    ai,
  });

  if (total >= input.totalPerMinute) return refuse('total');
  if (input.actor === 'ai') {
    if (ai >= input.aiPerMinute) return refuse('ai');
  } else if (total - ai >= input.totalPerMinute - input.aiFloorPerMinute) {
    // Everything people may take is taken: the rest is held for the AI.
    return refuse('people');
  }

  const personal =
    input.actor !== 'ai' && input.personId !== undefined && input.personPerMinute > 0
      ? personResource(input.resource, input.personId)
      : null;
  if (personal !== null) {
    const mine = await read(tx, personal);
    if (Number(mine?.total ?? 0) >= input.personPerMinute) return refuse('person', waitFor(mine));
  }

  const aiUnit = input.actor === 'ai' ? 1 : 0;
  await tx.execute(sql`
    INSERT INTO rate_budget_window (resource, slot, total, ai)
    VALUES (${input.resource}, date_trunc('second', clock_timestamp()), 1, ${aiUnit})
    ON CONFLICT (resource, slot) DO UPDATE
      SET total = rate_budget_window.total + 1, ai = rate_budget_window.ai + ${aiUnit}
  `);
  if (personal !== null) {
    await tx.execute(sql`
      INSERT INTO rate_budget_window (resource, slot, total, ai)
      VALUES (${personal}, date_trunc('second', clock_timestamp()), 1, 0)
      ON CONFLICT (resource, slot) DO UPDATE SET total = rate_budget_window.total + 1
    `);
  }
  return { granted: true, total: total + 1, ai: ai + aiUnit };
}

/** The same, in a transaction of its own. */
export async function takeRateBudget(
  db: Pick<Database['db'], 'transaction'>,
  input: AcquireInput,
): Promise<RateDecision> {
  return db.transaction((tx) => acquireRateBudget(tx, input));
}
