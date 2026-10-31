import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  PermanentOutboxError,
  enqueueOutbox,
  outboxBacklog,
  purgeOutbox,
  relayOutbox,
  type OutboxPublisher,
  type OutboxRow,
} from './outbox.js';
import { createTestDatabase, type TestDatabase } from './testing.js';

// The transactional outbox on the real Postgres from docker compose: what the api writes inside its
// transaction, and what the relay in apps/worker does with it.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
let app: Pool;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 6 });
});

afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.owner.pool.query('TRUNCATE outbox');
});

const job = (jobId: string, payload: Record<string, unknown> = { to: 'a@example.com' }) => ({
  queue: 'email',
  jobName: 'send',
  jobId,
  payload,
  options: { attempts: 5 },
});

async function statusOf(jobId: string) {
  const { rows } = await testDb.owner.pool.query<{
    status: string;
    attempts: number;
    payload: Record<string, unknown>;
    last_error: string | null;
    locked_until: Date | null;
    next_attempt_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT status, attempts, payload, last_error, locked_until, next_attempt_at, finished_at
     FROM outbox WHERE job_id = $1`,
    [jobId],
  );
  const row = rows[0];
  if (!row) throw new Error(`no outbox row ${jobId}`);
  return row;
}

/** Makes a row due now, as if its backoff had passed. */
async function makeDue(jobId: string): Promise<void> {
  await testDb.owner.pool.query(
    `UPDATE outbox SET next_attempt_at = now() - interval '1 second' WHERE job_id = $1`,
    [jobId],
  );
}

describe('enqueueOutbox', () => {
  it('stores a pending row and ignores the same job id again', async () => {
    const db = testDb.owner.db;
    expect(await enqueueOutbox(db, job('once'))).toBe(true);
    expect(await enqueueOutbox(db, job('once', { to: 'other@example.com' }))).toBe(false);
    const row = await statusOf('once');
    expect(row.status).toBe('pending');
    expect(row.payload).toEqual({ to: 'a@example.com' });
    // The same id in another queue is a different job.
    expect(await enqueueOutbox(db, { ...job('once'), queue: 'system' })).toBe(true);
  });

  it('commits and rolls back with the transaction it is written in', async () => {
    const db = testDb.owner.db;
    await expect(
      db.transaction(async (tx) => {
        await enqueueOutbox(tx, job('rolled-back'));
        throw new Error('the business change failed');
      }),
    ).rejects.toThrow('business change');
    const missing = await testDb.owner.pool.query(
      `SELECT 1 FROM outbox WHERE job_id = 'rolled-back'`,
    );
    expect(missing.rowCount).toBe(0);

    await db.transaction(async (tx) => {
      await enqueueOutbox(tx, job('committed'));
    });
    expect((await statusOf('committed')).status).toBe('pending');
  });
});

describe('relayOutbox', () => {
  it('hands pending rows to the publisher in creation order, marks them sent and blanks the payload', async () => {
    const db = testDb.owner.db;
    await enqueueOutbox(db, job('first', { secret: 'one-time-link-1' }));
    await enqueueOutbox(db, job('second', { secret: 'one-time-link-2' }));
    const seen: OutboxRow[] = [];
    const result = await relayOutbox(testDb.owner, (row) => {
      seen.push(row);
      return Promise.resolve();
    });
    expect(result).toMatchObject({ claimed: 2, sent: 2, retried: 0, dead: 0 });
    expect(seen.map((row) => row.jobId)).toEqual(['first', 'second']);
    expect(seen[0]).toMatchObject({
      queue: 'email',
      jobName: 'send',
      payload: { secret: 'one-time-link-1' },
      options: { attempts: 5 },
      attempts: 0,
    });
    for (const id of ['first', 'second']) {
      const row = await statusOf(id);
      expect(row.status).toBe('sent');
      expect(row.finished_at).not.toBeNull();
      expect(row.locked_until).toBeNull();
      // The one-time secret does not stay in the database once it was handed over.
      expect(row.payload).toEqual({});
    }
    // Nothing left to do.
    expect(await relayOutbox(testDb.owner, () => Promise.resolve())).toMatchObject({ claimed: 0 });
  });

  it('keeps a row pending when the publisher fails, backs off, and delivers it later', async () => {
    await enqueueOutbox(testDb.owner.db, job('redis-down'));
    let redisUp = false;
    const delivered: string[] = [];
    const publish: OutboxPublisher = (row) => {
      if (!redisUp) return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
      delivered.push(row.jobId);
      return Promise.resolve();
    };

    const failed = await relayOutbox(testDb.owner, publish, { baseDelaySeconds: 30 });
    expect(failed).toMatchObject({ claimed: 1, sent: 0, retried: 1, dead: 0 });
    expect(failed.firstError).toContain('ECONNREFUSED');
    const waiting = await statusOf('redis-down');
    expect(waiting.status).toBe('pending');
    expect(waiting.attempts).toBe(1);
    expect(waiting.last_error).toContain('ECONNREFUSED');
    expect(waiting.locked_until).toBeNull();
    expect(waiting.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(waiting.payload).toEqual({ to: 'a@example.com' });

    // Backed off: an immediate pass does not even try.
    redisUp = true;
    expect(await relayOutbox(testDb.owner, publish)).toMatchObject({ claimed: 0 });
    expect(delivered).toEqual([]);

    // Redis is back and the backoff has passed.
    await makeDue('redis-down');
    expect(await relayOutbox(testDb.owner, publish)).toMatchObject({ claimed: 1, sent: 1 });
    expect(delivered).toEqual(['redis-down']);
    const sent = await statusOf('redis-down');
    expect(sent).toMatchObject({ status: 'sent', last_error: null });
  });

  it('doubles the delay with each failure up to a cap', async () => {
    await enqueueOutbox(testDb.owner.db, job('backoff'));
    const fail: OutboxPublisher = () => Promise.reject(new Error('down'));
    const delays: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await makeDue('backoff');
      await relayOutbox(testDb.owner, fail, { baseDelaySeconds: 10, maxDelaySeconds: 100 });
      const row = await statusOf('backoff');
      delays.push(Math.round((row.next_attempt_at.getTime() - Date.now()) / 1000));
    }
    // 10, 20, 40, 80, then capped at 100 (a second of test time may pass).
    expect(delays.map((delay) => Math.round(delay / 10) * 10)).toEqual([10, 20, 40, 80, 100]);
  });

  it('stops the pass at the first failure and releases the rest untouched', async () => {
    const db = testDb.owner.db;
    for (const id of ['a', 'b', 'c']) await enqueueOutbox(db, job(id));
    const calls: string[] = [];
    const result = await relayOutbox(testDb.owner, (row) => {
      calls.push(row.jobId);
      return row.jobId === 'a' ? Promise.resolve() : Promise.reject(new Error('timeout'));
    });
    expect(calls).toEqual(['a', 'b']);
    expect(result).toMatchObject({ sent: 1, retried: 1 });
    const c = await statusOf('c');
    expect(c).toMatchObject({ status: 'pending', attempts: 0, locked_until: null });
  });

  it('declares a row dead after maxAttempts and blanks its payload', async () => {
    await enqueueOutbox(testDb.owner.db, job('doomed', { secret: 'link' }));
    const fail: OutboxPublisher = () => Promise.reject(new Error('still down'));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await makeDue('doomed');
      await relayOutbox(testDb.owner, fail, { maxAttempts: 3 });
    }
    const row = await statusOf('doomed');
    expect(row).toMatchObject({ status: 'dead', attempts: 3, payload: {} });
    expect(row.finished_at).not.toBeNull();
    expect(await outboxBacklog(testDb.owner)).toMatchObject({ pending: 0, dead: 1 });
  });

  it('declares a row dead at once on a permanent error, and goes on with the next row', async () => {
    const db = testDb.owner.db;
    await enqueueOutbox(db, { ...job('bad'), queue: 'no-such-queue' });
    await enqueueOutbox(db, job('good'));
    const result = await relayOutbox(testDb.owner, (row) =>
      row.queue === 'email'
        ? Promise.resolve()
        : Promise.reject(new PermanentOutboxError('unknown queue')),
    );
    expect(result).toMatchObject({ dead: 1, sent: 1, retried: 0 });
    expect((await statusOf('bad')).status).toBe('dead');
    expect((await statusOf('good')).status).toBe('sent');
  });

  it('lets two relays run side by side without publishing a row twice', async () => {
    const db = testDb.owner.db;
    for (let n = 0; n < 40; n += 1) await enqueueOutbox(db, job(`parallel-${String(n)}`));
    const published: string[] = [];
    const publish: OutboxPublisher = async (row) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      published.push(row.jobId);
    };
    const results = await Promise.all([
      relayOutbox(testDb.owner, publish, { batchSize: 10 }),
      relayOutbox(testDb.owner, publish, { batchSize: 10 }),
      relayOutbox(testDb.owner, publish, { batchSize: 10 }),
      relayOutbox(testDb.owner, publish, { batchSize: 10 }),
    ]);
    expect(results.reduce((total, result) => total + result.sent, 0)).toBe(40);
    expect(new Set(published).size).toBe(40);
    expect(published).toHaveLength(40);
  });

  it('takes over a row whose relay crashed once the lease has run out', async () => {
    await enqueueOutbox(testDb.owner.db, job('crashed'));
    // A relay claims the row (lease 1 s) and dies before publishing.
    await testDb.owner.pool.query(
      `UPDATE outbox SET locked_until = now() + interval '1 second' WHERE job_id = 'crashed'`,
    );
    expect(await relayOutbox(testDb.owner, () => Promise.resolve())).toMatchObject({ claimed: 0 });
    await testDb.owner.pool.query(
      `UPDATE outbox SET locked_until = now() - interval '1 second' WHERE job_id = 'crashed'`,
    );
    expect(await relayOutbox(testDb.owner, () => Promise.resolve())).toMatchObject({ sent: 1 });
  });

  it('dead-letters a row past expires_at and blanks its payload instead of relaying it', async () => {
    const db = testDb.owner.db;
    await enqueueOutbox(db, {
      ...job('stale', { secret: 'sealed-ciphertext' }),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await enqueueOutbox(db, {
      ...job('fresh', { secret: 'sealed-ciphertext' }),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await enqueueOutbox(db, job('never-expires'));
    // Time passes: the first row's lifetime is over before the relay got to it.
    await testDb.owner.pool.query(
      `UPDATE outbox SET expires_at = now() - interval '1 second' WHERE job_id = 'stale'`,
    );
    const seen: OutboxRow[] = [];
    const result = await relayOutbox(testDb.owner, (row) => {
      seen.push(row);
      return Promise.resolve();
    });
    expect(result).toMatchObject({ claimed: 2, sent: 2, expired: 1 });
    expect(seen.map((row) => row.jobId).toSorted()).toEqual(['fresh', 'never-expires']);
    expect(seen.find((row) => row.jobId === 'fresh')?.expiresAt).toBeInstanceOf(Date);
    expect(seen.find((row) => row.jobId === 'never-expires')?.expiresAt).toBeNull();
    const stale = await statusOf('stale');
    expect(stale.status).toBe('dead');
    expect(stale.payload).toEqual({});
    expect(stale.last_error).toContain('expired');
    expect(stale.finished_at).not.toBeNull();
  });

  it('works as the restricted application role', async () => {
    await enqueueOutbox(testDb.owner.db, job('as-app'));
    const result = await relayOutbox({ pool: app }, () => Promise.resolve());
    expect(result.sent).toBe(1);
  });
});

describe('purgeOutbox and outboxBacklog', () => {
  it('deletes finished rows older than the retention and keeps pending ones', async () => {
    const db = testDb.owner.db;
    for (const id of ['old-sent', 'new-sent', 'pending']) await enqueueOutbox(db, job(id));
    await testDb.owner.pool.query(
      `UPDATE outbox SET status = 'sent', finished_at = now() - interval '8 days' WHERE job_id = 'old-sent'`,
    );
    await testDb.owner.pool.query(
      `UPDATE outbox SET status = 'sent', finished_at = now() WHERE job_id = 'new-sent'`,
    );
    expect(await outboxBacklog(testDb.owner)).toMatchObject({ pending: 1, dead: 0 });
    expect(await purgeOutbox(testDb.owner, 7)).toBe(1);
    const left = await testDb.owner.pool.query<{ job_id: string }>(
      'SELECT job_id FROM outbox ORDER BY job_id',
    );
    expect(left.rows.map((row) => row.job_id)).toEqual(['new-sent', 'pending']);
  });
});
