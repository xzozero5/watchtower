import type { Database } from './client.js';
import { outbox } from './schema/ticketing.js';

/**
 * Transactional outbox (ADR-006, PRD section 8.3). Business code calls `enqueueOutbox` inside the
 * transaction that changes the data, so a job exists if and only if the change committed. A relay
 * (apps/worker) calls `relayOutbox` on a timer to hand pending rows to BullMQ.
 *
 * This module knows Postgres only. How a row reaches Redis is the `OutboxPublisher` the relay's
 * owner passes in, which keeps BullMQ out of this package (docs/04-ARCHITECTURE.md section 3).
 *
 * Guarantees: at-least-once, never lost while the row exists; the BullMQ `jobId` (= `job_id`) is the
 * idempotency key, so a row relayed twice (a crash between the Redis add and the database update)
 * is one job unless the first copy already finished and was removed.
 */

/** A transaction or the database handle: anything that can insert. */
export type OutboxWriter = Pick<Database['db'], 'insert'>;

export interface OutboxJob {
  readonly queue: string;
  readonly jobName: string;
  /** Idempotency key within a queue: the same `(queue, jobId)` is stored once. */
  readonly jobId: string;
  readonly payload: Record<string, unknown>;
  /** BullMQ job options; the relay validates them before use. */
  readonly options?: Record<string, unknown>;
}

/**
 * Writes one pending row. Returns false when the same `(queue, jobId)` was already enqueued, which
 * is how a retried request avoids sending twice.
 */
export async function enqueueOutbox(writer: OutboxWriter, job: OutboxJob): Promise<boolean> {
  const rows = await writer
    .insert(outbox)
    .values({
      queue: job.queue,
      jobName: job.jobName,
      jobId: job.jobId,
      payload: job.payload,
      options: job.options ?? {},
    })
    .onConflictDoNothing({ target: [outbox.queue, outbox.jobId] })
    .returning({ id: outbox.id });
  return rows.length > 0;
}

/** What the publisher gets. `payload` is the application's own JSON; validate it before use. */
export interface OutboxRow {
  readonly id: string;
  readonly queue: string;
  readonly jobName: string;
  readonly jobId: string;
  readonly payload: Record<string, unknown>;
  readonly options: Record<string, unknown>;
  /** Failed hand-overs so far. */
  readonly attempts: number;
}

/** Hands one row to the queue. Throws when it cannot; resolving means the job is in Redis. */
export type OutboxPublisher = (row: OutboxRow) => Promise<void>;

/**
 * A publisher throws this when retrying can never help (an unknown queue, options that do not
 * validate). The row is marked dead at once instead of being retried until `maxAttempts`.
 */
export class PermanentOutboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentOutboxError';
  }
}

export interface RelayOptions {
  /** Rows claimed per round trip. Default 50. */
  readonly batchSize?: number;
  /** How long a claim holds a row before another relay may take it (a crashed relay). Default 60 s. */
  readonly leaseSeconds?: number;
  /** Failed hand-overs before the row is dead. With the default backoff cap about 2.5 hours. Default 30. */
  readonly maxAttempts?: number;
  /** First retry delay; doubles per attempt. Default 1 s. */
  readonly baseDelaySeconds?: number;
  /** Retry delay cap. Default 300 s. */
  readonly maxDelaySeconds?: number;
}

export interface RelayResult {
  readonly claimed: number;
  readonly sent: number;
  /** Rows that failed and will be retried later. */
  readonly retried: number;
  /** Rows given up on (too many attempts, or a permanent error). */
  readonly dead: number;
  /** The first failure of this run, for the log (never contains a payload). */
  readonly firstError?: string;
}

interface ClaimedRow {
  id: string;
  queue: string;
  job_name: string;
  job_id: string;
  payload: Record<string, unknown>;
  options: Record<string, unknown>;
  attempts: number;
  created_at: Date;
}

const MAX_ERROR_LENGTH = 500;

/** The text of an error for `last_error`: short, one line, never the job payload. */
function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.replace(/\s+/g, ' ').slice(0, MAX_ERROR_LENGTH);
}

/**
 * One relay pass: claims due pending rows (`FOR UPDATE SKIP LOCKED`, so any number of relays can run
 * without taking the same row), publishes them one by one in creation order, and records the outcome.
 *
 * A failure that is not permanent stops the pass: Redis is probably down, so the rest of the batch is
 * released untouched rather than spending a timeout on each row. The failed row waits
 * `min(base * 2^attempts, max)` seconds before its next try.
 *
 * The caller decides how often to run it and must not run two passes concurrently in one process
 * unless it wants to (rows are safe either way).
 */
export async function relayOutbox(
  database: Pick<Database, 'pool'>,
  publish: OutboxPublisher,
  options: RelayOptions = {},
): Promise<RelayResult> {
  const batchSize = options.batchSize ?? 50;
  const leaseSeconds = options.leaseSeconds ?? 60;
  const maxAttempts = options.maxAttempts ?? 30;
  const baseDelay = options.baseDelaySeconds ?? 1;
  const maxDelay = options.maxDelaySeconds ?? 300;
  const { pool } = database;

  const claimed = await pool.query<ClaimedRow>(
    `UPDATE outbox SET locked_until = now() + make_interval(secs => $2)
     WHERE id IN (
       SELECT id FROM outbox
       WHERE status = 'pending'
         AND next_attempt_at <= now()
         AND (locked_until IS NULL OR locked_until < now())
       ORDER BY next_attempt_at, created_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, queue, job_name, job_id, payload, options, attempts, created_at`,
    [batchSize, leaseSeconds],
  );
  const rows = claimed.rows.toSorted((a, b) => a.created_at.getTime() - b.created_at.getTime());

  let sent = 0;
  let retried = 0;
  let dead = 0;
  let firstError: string | undefined;
  let stopAt = rows.length;

  for (const [index, row] of rows.entries()) {
    try {
      await publish({
        id: row.id,
        queue: row.queue,
        jobName: row.job_name,
        jobId: row.job_id,
        payload: row.payload,
        options: row.options,
        attempts: row.attempts,
      });
    } catch (error) {
      const message = describeError(error);
      firstError ??= message;
      const permanent = error instanceof PermanentOutboxError;
      const attempts = row.attempts + 1;
      if (permanent || attempts >= maxAttempts) {
        await pool.query(
          `UPDATE outbox SET status = 'dead', attempts = $2, last_error = $3, payload = '{}'::jsonb,
                  locked_until = NULL, finished_at = now()
           WHERE id = $1`,
          [row.id, attempts, message],
        );
        dead += 1;
      } else {
        const delay = Math.min(baseDelay * 2 ** row.attempts, maxDelay);
        await pool.query(
          `UPDATE outbox SET attempts = $2, last_error = $3, locked_until = NULL,
                  next_attempt_at = now() + make_interval(secs => $4)
           WHERE id = $1`,
          [row.id, attempts, message, delay],
        );
        retried += 1;
      }
      if (!permanent) {
        stopAt = index + 1;
        break;
      }
      continue;
    }
    await pool.query(
      `UPDATE outbox SET status = 'sent', payload = '{}'::jsonb, locked_until = NULL,
              last_error = NULL, finished_at = now()
       WHERE id = $1`,
      [row.id],
    );
    sent += 1;
  }

  if (stopAt < rows.length) {
    await pool.query(`UPDATE outbox SET locked_until = NULL WHERE id = ANY($1::uuid[])`, [
      rows.slice(stopAt).map((row) => row.id),
    ]);
  }
  return {
    claimed: rows.length,
    sent,
    retried,
    dead,
    ...(firstError === undefined ? {} : { firstError }),
  };
}

/** Deletes finished rows (sent or dead) older than `olderThanDays`. Returns how many. */
export async function purgeOutbox(
  database: Pick<Database, 'pool'>,
  olderThanDays = 7,
): Promise<number> {
  const result = await database.pool.query(
    `DELETE FROM outbox
     WHERE status <> 'pending' AND finished_at < now() - make_interval(days => $1::int)`,
    [olderThanDays],
  );
  return result.rowCount ?? 0;
}

export interface OutboxBacklog {
  readonly pending: number;
  readonly dead: number;
  /** Age in seconds of the oldest pending row; 0 when none. */
  readonly oldestPendingSeconds: number;
}

/** What is waiting, for the relay's log line and a future health check. */
export async function outboxBacklog(database: Pick<Database, 'pool'>): Promise<OutboxBacklog> {
  const result = await database.pool.query<{ pending: string; dead: string; oldest: number }>(
    `SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
            count(*) FILTER (WHERE status = 'dead') AS dead,
            coalesce(extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'pending')), 0)::float AS oldest
     FROM outbox`,
  );
  const row = result.rows[0];
  return {
    pending: Number(row?.pending ?? 0),
    dead: Number(row?.dead ?? 0),
    oldestPendingSeconds: Math.round(row?.oldest ?? 0),
  };
}
