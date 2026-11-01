import { randomBytes } from 'node:crypto';

import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { CLEANUP_JOBS, QUEUE_NAMES, parseRedisUrl } from '@watchtower/shared';
import { Queue, QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from './logger.js';
import { testConfig } from './testing/support.js';
import { startWorker, type RunningWorker } from './worker.js';

// T-117: the cleanup job through the real worker, BullMQ and Postgres (restricted application role).
const prefix = `wt-test-${randomBytes(4).toString('hex')}`;
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
let worker: RunningWorker;
let queue: Queue;
let events: QueueEvents;
let userId: string;
const owner = () => testDb.owner.pool;

async function count(table: string): Promise<number> {
  const result = await owner().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return result.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  const config = {
    ...testConfig({
      DATABASE_URL: testDb.appUrl,
      CLEANUP_AUTH_RETENTION_DAYS: '3',
      CLEANUP_BREAK_GLASS_RETENTION_DAYS: '10',
    }),
    listenPort: 0,
  };
  worker = await startWorker(config, createLogger(config), { queuePrefix: prefix });
  const connection = parseRedisUrl(config.REDIS_URL);
  queue = new Queue(QUEUE_NAMES.cleanup, { connection, prefix });
  events = new QueueEvents(QUEUE_NAMES.cleanup, { connection, prefix });
  await events.waitUntilReady();
  const user = await owner().query<{ id: string }>(
    `INSERT INTO users (email, name, role) VALUES ('cleanup-worker@example.com', 'W', 'agent') RETURNING id`,
  );
  userId = user.rows[0]?.id ?? '';
});

afterAll(async () => {
  await events.close();
  await worker.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await testDb.cleanup();
});

describe('cleanup queue', () => {
  it('has the daily purge scheduled', async () => {
    const schedulers = await queue.getJobSchedulers();
    const purge = schedulers.find((scheduler) => scheduler.key === CLEANUP_JOBS.purgeExpired);
    expect(purge).toMatchObject({
      name: CLEANUP_JOBS.purgeExpired,
      pattern: '30 3 * * *',
      tz: 'UTC',
    });
  });

  it('deletes expired rows with the configured retention and keeps the rest', async () => {
    await owner().query(
      `INSERT INTO sessions (user_id, auth_method, expires_at) VALUES
         ($1, 'dev', now() - interval '5 days'),   -- past the 3-day retention
         ($1, 'dev', now() - interval '1 day'),    -- expired, still inside it
         ($1, 'dev', now() + interval '1 day')`,
      [userId],
    );
    await owner().query(
      `INSERT INTO magic_link_tokens (user_id, token_hash, created_at, expires_at) VALUES
         ($1, 'a' || gen_random_uuid(), now() - interval '9 days', now() - interval '8 days'),
         ($1, 'b' || gen_random_uuid(), now() - interval '1 hour', now() + interval '14 minutes')`,
      [userId],
    );

    const job = await queue.add(CLEANUP_JOBS.purgeExpired, {}, { jobId: 'cleanup-it-1' });
    const result = (await job.waitUntilFinished(events, 10_000)) as Record<string, unknown>;
    expect(result).toMatchObject({ sessions: 1, magic_link_tokens: 1, more: false });
    expect(await count('sessions')).toBe(2);
    expect(await count('magic_link_tokens')).toBe(1);
  });

  it('ends an unknown job without retrying it', async () => {
    const job = await queue.add('mystery', {}, { attempts: 3 });
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(/unknown cleanup job/);
    const failed = await queue.getJob(job.id ?? '');
    expect(failed?.attemptsMade).toBe(1);
  });
});
