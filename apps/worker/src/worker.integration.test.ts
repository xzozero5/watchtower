import { randomBytes } from 'node:crypto';

import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import {
  DEFAULT_JOB_OPTIONS,
  EMAIL_JOBS,
  MAINTENANCE_JOBS,
  QUEUE_NAMES,
  SYSTEM_JOBS,
  parseRedisUrl,
  type EmailJob,
} from '@watchtower/shared';
import { Queue, QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from './logger.js';
import { pingResultSchema } from './processors/system.js';
import { testConfig } from './testing/support.js';
import { startWorker, type RunningWorker } from './worker.js';

// Real Postgres, Redis and Mailpit from docker compose
// (`docker compose up -d --wait postgres redis mailpit`). Postgres is a throwaway database with
// the real migrations applied, reached through the restricted application role like in compose.
// A unique key prefix keeps this run away from any other BullMQ data in the same Redis.
const prefix = `wt-test-${randomBytes(4).toString('hex')}`;
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const mailpit = process.env.MAILPIT_URL ?? 'http://localhost:8025';

let testDb: TestDatabase;
let config: ReturnType<typeof testConfig>;
let worker: RunningWorker;
let queue: Queue;
let emailQueue: Queue;
let maintenanceQueue: Queue;
let events: QueueEvents;
let emailEvents: QueueEvents;
let maintenanceEvents: QueueEvents;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  // listenPort 0: let the OS pick a free port for the health server.
  config = { ...testConfig({ DATABASE_URL: testDb.appUrl }), listenPort: 0 };
  worker = await startWorker(config, createLogger(config), { queuePrefix: prefix });
  const connection = parseRedisUrl(config.REDIS_URL);
  queue = new Queue(QUEUE_NAMES.system, { connection, prefix });
  emailQueue = new Queue(QUEUE_NAMES.email, { connection, prefix });
  maintenanceQueue = new Queue(QUEUE_NAMES.maintenance, { connection, prefix });
  events = new QueueEvents(QUEUE_NAMES.system, { connection, prefix });
  emailEvents = new QueueEvents(QUEUE_NAMES.email, { connection, prefix });
  maintenanceEvents = new QueueEvents(QUEUE_NAMES.maintenance, { connection, prefix });
  await Promise.all([
    events.waitUntilReady(),
    emailEvents.waitUntilReady(),
    maintenanceEvents.waitUntilReady(),
  ]);
});

afterAll(async () => {
  await Promise.all([events.close(), emailEvents.close(), maintenanceEvents.close()]);
  await worker.close();
  for (const q of [queue, emailQueue, maintenanceQueue]) {
    await q.obliterate({ force: true });
    await q.close();
  }
  await testDb.cleanup();
});

describe('worker against real Postgres and Redis', () => {
  it('GET /health and /health/ready answer 200', async () => {
    const base = `http://127.0.0.1:${String(worker.healthPort)}`;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      status: 'ok',
      checks: { database: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  it('consumes a job enqueued by a producer through Redis', async () => {
    const job = await queue.add(
      SYSTEM_JOBS.ping,
      {},
      { ...DEFAULT_JOB_OPTIONS, jobId: 'ping-roundtrip' },
    );
    const result: unknown = await job.waitUntilFinished(events, 10_000);
    expect(pingResultSchema.parse(result).pong).toBe(true);
  });

  it('is idempotent per jobId: the same key does not enqueue twice', async () => {
    const first = await queue.add(SYSTEM_JOBS.ping, {}, { jobId: 'ping-once' });
    const second = await queue.add(SYSTEM_JOBS.ping, {}, { jobId: 'ping-once' });
    expect(second.id).toBe(first.id);
    await first.waitUntilFinished(events, 10_000);
    expect(await queue.getJobCounts('waiting', 'active', 'delayed')).toEqual({
      waiting: 0,
      active: 0,
      delayed: 0,
    });
  });

  it('retries a failing job and then keeps it as failed', async () => {
    const job = await queue.add(
      'mystery',
      {},
      { attempts: 2, backoff: { type: 'fixed', delay: 50 } },
    );
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(/unknown system job/);
    const failed = await queue.getJob(job.id ?? '');
    expect(failed?.attemptsMade).toBe(2);
  });
});

interface MailpitSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

async function findMail(recipient: string): Promise<MailpitSummary | undefined> {
  const response = await fetch(
    `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`,
  );
  const body = (await response.json()) as { messages: MailpitSummary[] };
  return body.messages[0];
}

async function waitForMail(recipient: string): Promise<MailpitSummary> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const mail = await findMail(recipient);
    if (mail) return mail;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`no mail for ${recipient} reached Mailpit`);
}

describe('email queue to Mailpit over SMTP', () => {
  it('delivers a magic-link email and removes the job (it held a secret)', async () => {
    const recipient = `client-${randomBytes(4).toString('hex')}@example.com`;
    const link = `http://localhost:3000/login/magic#token=${randomBytes(16).toString('hex')}`;
    const payload: EmailJob = { kind: 'magic_link', to: recipient, link, expiresInMinutes: 15 };
    const jobId = `magic-${randomBytes(4).toString('hex')}`;
    await emailQueue.add(EMAIL_JOBS.send, payload, { jobId, removeOnComplete: true });

    const summary = await waitForMail(recipient);
    expect(summary.Subject).toBe('Your Watchtower sign-in link');
    const detail = (await (await fetch(`${mailpit}/api/v1/message/${summary.ID}`)).json()) as {
      Text: string;
      From: { Address: string };
    };
    expect(detail.Text).toContain(link);
    expect(detail.From.Address).toBe('no-reply@example.com');

    // The successful job is gone from Redis: the link must not linger there.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await emailQueue.getJob(jobId)).toBeUndefined();
    await fetch(`${mailpit}/api/v1/messages`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ IDs: [summary.ID] }),
    });
  });

  it('fails a malformed email job once, without retrying', async () => {
    const job = await emailQueue.add(
      EMAIL_JOBS.send,
      { kind: 'magic_link', to: 'x' },
      { attempts: 5, backoff: { type: 'fixed', delay: 50 } },
    );
    await expect(job.waitUntilFinished(emailEvents, 10_000)).rejects.toThrow(/payload is invalid/);
    expect((await emailQueue.getJob(job.id ?? ''))?.attemptsMade).toBe(1);
  });
});

describe('maintenance queue creates audit_log partitions', () => {
  const partitions = async (): Promise<string[]> => {
    const result = await testDb.owner.pool.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'audit_log'::regclass ORDER BY c.relname`,
    );
    return result.rows.map((row) => row.name);
  };

  it('re-creates a missing partition, append-only, as the restricted app role', async () => {
    const now = new Date();
    const month = `${String(now.getUTCFullYear())}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const current = `audit_log_p${month}`;
    expect(await partitions()).toContain(current);
    await testDb.owner.pool.query(`DROP TABLE ${current}`);
    expect(await partitions()).not.toContain(current);

    const job = await maintenanceQueue.add(
      MAINTENANCE_JOBS.ensurePartitions,
      {},
      { jobId: `ensure-test-${randomBytes(3).toString('hex')}` },
    );
    const result = (await job.waitUntilFinished(maintenanceEvents, 10_000)) as { created: number };
    expect(result.created).toBe(1);
    expect(await partitions()).toContain(current);

    const role = new URL(testDb.appUrl).username;
    const privileges = await testDb.owner.pool.query<{ update: boolean; insert: boolean }>(
      `SELECT has_table_privilege($1, $2::regclass, 'UPDATE') AS update,
              has_table_privilege($1, $2::regclass, 'INSERT') AS insert`,
      [role, current],
    );
    expect(privileges.rows[0]).toEqual({ update: false, insert: true });
  });

  it('created the partitions on boot: current month and the three after it', async () => {
    const names = await partitions();
    const now = new Date();
    for (let offset = 0; offset <= 3; offset += 1) {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
      const suffix = `${String(date.getUTCFullYear())}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
      expect(names).toContain(`audit_log_p${suffix}`);
    }
  });
});

describe('readiness when Postgres is unreachable', () => {
  it('returns 503 naming the database', async () => {
    const broken = {
      ...testConfig({ DATABASE_URL: 'postgres://watchtower:watchtower@127.0.0.1:1/watchtower' }),
      listenPort: 0,
    };
    const running = await startWorker(broken, createLogger(broken), {
      queuePrefix: `${prefix}-broken`,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${String(running.healthPort)}/health/ready`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        checks: { database: { status: 'down' }, redis: { status: 'up' } },
      });
    } finally {
      await running.close();
      for (const name of [QUEUE_NAMES.system, QUEUE_NAMES.email, QUEUE_NAMES.maintenance]) {
        const cleanup = new Queue(name, {
          connection: parseRedisUrl(broken.REDIS_URL),
          prefix: `${prefix}-broken`,
        });
        await cleanup.obliterate({ force: true });
        await cleanup.close();
      }
    }
  });
});
