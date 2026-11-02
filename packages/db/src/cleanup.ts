import type { Database } from './client.js';

/** The tables `purgeExpired` empties of rows nobody can use any more (T-117). */
export const CLEANUP_TARGETS = [
  'refresh_tokens',
  'sessions',
  'magic_link_tokens',
  'portal_access_token',
  'break_glass_attempt',
  'status_subscription',
  'assistant_conversation',
  'ai_summary',
] as const;
export type CleanupTarget = (typeof CLEANUP_TARGETS)[number];

export interface CleanupOptions {
  /**
   * How long an expired, revoked or used session, refresh token, magic link or tracking link is
   * kept after it stopped working. Short, because none of them can be used again; long enough
   * that support can still see why someone was signed out. `[ASSUMED]` 7 days (the same grace the
   * portal already uses when it issues a new link).
   */
  readonly authRetentionDays?: number;
  /**
   * How long a break-glass lockout counter is kept after its last failed sign-in, unless it is
   * still locked. The lockout itself resets after a quiet day (ADR-005); the extra time is for
   * incident review. `[ASSUMED]` 30 days.
   */
  readonly breakGlassRetentionDays?: number;
  /**
   * How long a conversation with the assistant (with its messages and proposals, which go with it) and a
   * cached AI summary are kept after they were last used (T-134, ADR-017 section 8). They hold redacted
   * text and the summaries of a person's own screens. `[ASSUMED]` 30 days.
   */
  readonly assistantRetentionDays?: number;
  /** Rows deleted per statement, so a large backlog never holds a long lock. */
  readonly batchSize?: number;
  /** Statements per table per run; a backlog bigger than `batchSize * maxBatches` finishes on the next run. */
  readonly maxBatches?: number;
}

export type CleanupResult = Record<CleanupTarget, number> & {
  /** True when a table still had expired rows after `maxBatches` statements. */
  readonly more: boolean;
};

export const DEFAULT_AUTH_RETENTION_DAYS = 7;
export const DEFAULT_BREAK_GLASS_RETENTION_DAYS = 30;
export const DEFAULT_ASSISTANT_RETENTION_DAYS = 30;
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_MAX_BATCHES = 100;

interface Statement {
  readonly table: CleanupTarget;
  /** `$1` = retention days, `$2` = batch size. The row locator is `id`, or `ctid` where there is none. */
  readonly sql: string;
  readonly retention: 'auth' | 'breakGlass' | 'assistant';
}

const batch = (table: string, locator: string, condition: string): string =>
  `DELETE FROM ${table} WHERE ${locator} IN (
     SELECT ${locator} FROM ${table} WHERE ${condition} LIMIT $2 FOR UPDATE SKIP LOCKED
   )`;

// Every condition uses an indexed column (migrations 0001, 0004, 0005, 0011). Table names are
// constants of this file, never input. Refresh tokens go first; deleting a session also deletes the
// refresh tokens still attached to it (ON DELETE CASCADE).
const STATEMENTS: readonly Statement[] = [
  {
    table: 'refresh_tokens',
    retention: 'auth',
    sql: batch('refresh_tokens', 'id', `expires_at < now() - make_interval(days => $1::int)`),
  },
  {
    table: 'sessions',
    retention: 'auth',
    sql: batch(
      'sessions',
      'id',
      `(expires_at < now() - make_interval(days => $1::int)
        OR (revoked_at IS NOT NULL AND revoked_at < now() - make_interval(days => $1::int)))`,
    ),
  },
  {
    table: 'magic_link_tokens',
    retention: 'auth',
    sql: batch(
      'magic_link_tokens',
      'id',
      `(expires_at < now() - make_interval(days => $1::int)
        OR (consumed_at IS NOT NULL AND consumed_at < now() - make_interval(days => $1::int)))`,
    ),
  },
  {
    table: 'portal_access_token',
    retention: 'auth',
    sql: batch(
      'portal_access_token',
      'id',
      `(expires_at < now() - make_interval(days => $1::int)
        OR (revoked_at IS NOT NULL AND revoked_at < now() - make_interval(days => $1::int)))`,
    ),
  },
  {
    table: 'break_glass_attempt',
    retention: 'breakGlass',
    // A counter that still locks someone out is kept whatever its age.
    sql: batch(
      'break_glass_attempt',
      'ctid',
      `last_failed_at < now() - make_interval(days => $1::int)
         AND (locked_until IS NULL OR locked_until < now())`,
    ),
  },
  {
    table: 'status_subscription',
    retention: 'auth',
    // A subscription nobody confirmed: its link is dead after the window, and the address (personal data)
    // is not kept for a reader who never opted in. Confirmed and unsubscribed rows stay (the latter is the
    // record that this address asked to stop).
    sql: batch(
      'status_subscription',
      'id',
      `state = 'pending' AND confirm_expires_at < now() - make_interval(days => $1::int)`,
    ),
  },
  {
    table: 'assistant_conversation',
    retention: 'assistant',
    // Messages and proposals go with it (ON DELETE CASCADE). The audit log of what was pressed stays.
    sql: batch(
      'assistant_conversation',
      'id',
      `updated_at < now() - make_interval(days => $1::int)`,
    ),
  },
  {
    table: 'ai_summary',
    retention: 'assistant',
    sql: batch('ai_summary', 'ctid', `generated_at < now() - make_interval(days => $1::int)`),
  },
];

function assertCount(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${String(min)} to ${String(max)}`);
  }
  return value;
}

/**
 * Deletes, in small batches, what has passed its expiry (T-117, ADR-005): sessions, refresh tokens,
 * magic-link tokens, portal tracking links and old break-glass lockout counters. Idempotent and safe
 * to run concurrently with the api (`FOR UPDATE SKIP LOCKED`; none of these rows is usable once
 * expired, so nothing a request needs is removed).
 *
 * Not included on purpose: the outbox. The relay already marks a pending row whose `expires_at` has
 * passed as dead and `purgeOutbox` deletes finished rows (ADR-006), so this job would only repeat it.
 * Also not included: the audit log, which is append-only and kept by partition (docs/09-SECURITY.md).
 * Runs as the restricted application role: it already holds DELETE on these tables (migration 0001
 * default privileges); nothing is granted for this job.
 */
export async function purgeExpired(
  database: Pick<Database, 'pool'>,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const authDays = assertCount(
    'authRetentionDays',
    options.authRetentionDays ?? DEFAULT_AUTH_RETENTION_DAYS,
    0,
    3650,
  );
  const breakGlassDays = assertCount(
    'breakGlassRetentionDays',
    options.breakGlassRetentionDays ?? DEFAULT_BREAK_GLASS_RETENTION_DAYS,
    0,
    3650,
  );
  const assistantDays = assertCount(
    'assistantRetentionDays',
    options.assistantRetentionDays ?? DEFAULT_ASSISTANT_RETENTION_DAYS,
    0,
    3650,
  );
  const batchSize = assertCount('batchSize', options.batchSize ?? DEFAULT_BATCH_SIZE, 1, 100_000);
  const maxBatches = assertCount(
    'maxBatches',
    options.maxBatches ?? DEFAULT_MAX_BATCHES,
    1,
    10_000,
  );

  const deleted: Record<CleanupTarget, number> = {
    refresh_tokens: 0,
    sessions: 0,
    magic_link_tokens: 0,
    portal_access_token: 0,
    break_glass_attempt: 0,
    status_subscription: 0,
    assistant_conversation: 0,
    ai_summary: 0,
  };
  let more = false;
  for (const statement of STATEMENTS) {
    const days =
      statement.retention === 'auth'
        ? authDays
        : statement.retention === 'assistant'
          ? assistantDays
          : breakGlassDays;
    for (let run = 0; run < maxBatches; run += 1) {
      const result = await database.pool.query(statement.sql, [days, batchSize]);
      const count = result.rowCount ?? 0;
      deleted[statement.table] += count;
      if (count < batchSize) break;
      if (run === maxBatches - 1) more = true;
    }
  }
  return { ...deleted, more };
}
