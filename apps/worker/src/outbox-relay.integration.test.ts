import { randomBytes } from 'node:crypto';

import { createDatabase, enqueueOutbox, type Database, type OutboxPublisher } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import {
  EMAIL_JOBS,
  EMAIL_OUTBOX_JOB_OPTIONS,
  QUEUE_NAMES,
  parseRedisUrl,
  type EmailJob,
} from '@watchtower/shared';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from './logger.js';
import { createBullmqPublisher } from './outbox-relay.js';
import { testConfig } from './testing/support.js';
import { startWorker, type RunningWorker } from './worker.js';

// The relay of the transactional outbox (ADR-006) in the worker, on real Postgres, Redis and
// Mailpit. The api writes the rows (here: the same `enqueueOutbox` it calls, as the restricted app
// role); the relay moves them to BullMQ; the email processor sends them over SMTP.
const prefix = `wt-test-${randomBytes(4).toString('hex')}`;
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const mailpit = process.env.MAILPIT_URL ?? 'http://localhost:8025';

let testDb: TestDatabase;
let config: ReturnType<typeof testConfig>;
let worker: RunningWorker;
let emailQueue: Queue;
/** The api's connection: the restricted application role, like in compose. */
let apiDb: Database;
/** What the injected publisher does: Redis "down" until the test flips it. */
let redisUp = true;
const handedOver: string[] = [];

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  apiDb = createDatabase({ url: testDb.appUrl, max: 2 });
  config = {
    ...testConfig({ DATABASE_URL: testDb.appUrl, OUTBOX_POLL_INTERVAL_MS: '100' }),
    listenPort: 0,
  };
  const connection = parseRedisUrl(config.REDIS_URL);
  emailQueue = new Queue(QUEUE_NAMES.email, { connection, prefix });
  // The "network": a publisher that fails exactly like ioredis does while Redis is unreachable.
  const publish: OutboxPublisher = async (row) => {
    if (!redisUp) throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    await emailQueue.add(row.jobName, row.payload, {
      ...EMAIL_OUTBOX_JOB_OPTIONS,
      jobId: row.jobId,
    });
    handedOver.push(row.jobId);
  };
  worker = await startWorker(config, createLogger(config), {
    queuePrefix: prefix,
    outboxPublisher: publish,
  });
});

afterAll(async () => {
  await worker.close();
  await emailQueue.obliterate({ force: true });
  await emailQueue.close();
  await apiDb.close();
  await testDb.cleanup();
});

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function mailFor(recipient: string): Promise<{ ID: string; Subject: string } | undefined> {
  const response = await fetch(
    `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`,
  );
  const body = (await response.json()) as { messages: { ID: string; Subject: string }[] };
  return body.messages[0];
}

async function rowStatus(jobId: string): Promise<{ status: string; attempts: number } | undefined> {
  const { rows } = await testDb.owner.pool.query<{ status: string; attempts: number }>(
    'SELECT status, attempts FROM outbox WHERE job_id = $1',
    [jobId],
  );
  return rows[0];
}

/** What the api does inside its transaction: one outbox row for one email. */
async function apiWritesEmail(recipient: string, jobId: string): Promise<void> {
  const job: EmailJob = {
    kind: 'magic_link',
    to: recipient,
    link: `http://localhost:3000/login/magic#token=${randomBytes(16).toString('hex')}`,
    expiresInMinutes: 15,
  };
  await apiDb.db.transaction(async (tx) => {
    await enqueueOutbox(tx, {
      queue: QUEUE_NAMES.email,
      jobName: EMAIL_JOBS.send,
      jobId,
      payload: job,
      options: EMAIL_OUTBOX_JOB_OPTIONS,
    });
  });
}

describe('outbox relay in the worker', () => {
  it('moves a row the api wrote to BullMQ and the email reaches Mailpit', async () => {
    redisUp = true;
    const recipient = `outbox-${randomBytes(4).toString('hex')}@example.com`;
    const jobId = `outbox-e2e-${randomBytes(4).toString('hex')}`;
    await apiWritesEmail(recipient, jobId);

    const mail = await waitFor(() => mailFor(recipient), 'the email in Mailpit');
    expect(mail.Subject).toBe('Your Watchtower sign-in link');
    const row = await waitFor(async () => {
      const status = await rowStatus(jobId);
      return status?.status === 'sent' ? status : undefined;
    }, 'the row to be marked sent');
    expect(row.attempts).toBe(0);
    const payload = await testDb.owner.pool.query<{ payload: unknown }>(
      'SELECT payload FROM outbox WHERE job_id = $1',
      [jobId],
    );
    // The link was a one-time secret: it does not stay in the outbox.
    expect(payload.rows[0]?.payload).toEqual({});
    await fetch(`${mailpit}/api/v1/messages`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ IDs: [mail.ID] }),
    });
  });

  it('delivers a portal confirmation the api wrote: rendered in Thai, link intact, payload blanked', async () => {
    redisUp = true;
    const recipient = `portal-${randomBytes(4).toString('hex')}@example.com`;
    const jobId = `portal-confirm-${randomBytes(4).toString('hex')}`;
    const trackingUrl = `http://localhost:3000/portal/tickets/OPS-77#token=wtp1.${randomBytes(8).toString('hex')}`;
    const job: EmailJob = {
      kind: 'portal_confirmation',
      to: recipient,
      locale: 'th',
      ticketKey: 'OPS-77',
      subject: 'Webhook ไม่เข้า',
      trackingUrl,
      expectedFirstResponseAt: null,
    };
    await apiDb.db.transaction(async (tx) => {
      await enqueueOutbox(tx, {
        queue: QUEUE_NAMES.email,
        jobName: EMAIL_JOBS.send,
        jobId,
        payload: job,
        options: EMAIL_OUTBOX_JOB_OPTIONS,
      });
    });
    const mail = await waitFor(() => mailFor(recipient), 'the portal email in Mailpit');
    expect(mail.Subject).toBe('เราได้รับคำขอ OPS-77 แล้ว');
    const full = (await (await fetch(`${mailpit}/api/v1/message/${mail.ID}`)).json()) as {
      Text: string;
      HTML: string;
    };
    expect(full.Text).toContain(trackingUrl);
    expect(full.HTML).not.toMatch(/<img|<script/i);
    await waitFor(async () => {
      const status = await rowStatus(jobId);
      return status?.status === 'sent' ? status : undefined;
    }, 'the row to be marked sent');
    const payload = await testDb.owner.pool.query<{ payload: unknown }>(
      'SELECT payload FROM outbox WHERE job_id = $1',
      [jobId],
    );
    expect(payload.rows[0]?.payload).toEqual({});
    await fetch(`${mailpit}/api/v1/messages`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ IDs: [mail.ID] }),
    });
  });

  it('keeps the row while Redis is unreachable and delivers it once Redis is back', async () => {
    redisUp = false;
    const recipient = `outbox-down-${randomBytes(4).toString('hex')}@example.com`;
    const jobId = `outbox-down-${randomBytes(4).toString('hex')}`;
    await apiWritesEmail(recipient, jobId);

    // The relay tries and fails (attempts goes up), the row stays pending, nothing is mailed.
    const failing = await waitFor(async () => {
      const status = await rowStatus(jobId);
      return status !== undefined && status.attempts >= 1 ? status : undefined;
    }, 'a failed hand-over');
    expect(failing.status).toBe('pending');
    expect(handedOver).not.toContain(jobId);
    expect(await mailFor(recipient)).toBeUndefined();

    // Redis comes back; the backoff (about a second) passes and the relay delivers.
    redisUp = true;
    const mail = await waitFor(() => mailFor(recipient), 'the email after Redis came back', 20_000);
    expect(mail.Subject).toBe('Your Watchtower sign-in link');
    const done = await waitFor(async () => {
      const status = await rowStatus(jobId);
      return status?.status === 'sent' ? status : undefined;
    }, 'the row to be marked sent');
    expect(done.attempts).toBeGreaterThanOrEqual(1);
    expect(handedOver).toContain(jobId);
    await fetch(`${mailpit}/api/v1/messages`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ IDs: [mail.ID] }),
    });
  });

  it('sends one email when the same job id is written twice', async () => {
    redisUp = true;
    const recipient = `outbox-dup-${randomBytes(4).toString('hex')}@example.com`;
    const jobId = `outbox-dup-${randomBytes(4).toString('hex')}`;
    await apiWritesEmail(recipient, jobId);
    await apiWritesEmail(recipient, jobId);
    const mail = await waitFor(() => mailFor(recipient), 'the email');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const response = await fetch(
      `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`,
    );
    expect(((await response.json()) as { messages: unknown[] }).messages).toHaveLength(1);
    await fetch(`${mailpit}/api/v1/messages`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ IDs: [mail.ID] }),
    });
  });
});

describe('createBullmqPublisher', () => {
  it('fails within its timeout when Redis cannot be reached, instead of hanging the relay', async () => {
    const publisher = createBullmqPublisher(
      { host: '127.0.0.1', port: 1, maxRetriesPerRequest: null },
      createLogger({ ...config, LOG_LEVEL: 'silent' }),
      { prefix, timeoutMs: 300 },
    );
    const started = Date.now();
    await expect(
      publisher.publish({
        id: 'x',
        queue: QUEUE_NAMES.email,
        jobName: EMAIL_JOBS.send,
        jobId: 'unreachable',
        payload: {},
        options: {},
        attempts: 0,
      }),
    ).rejects.toThrow(/did not accept the job within 300 ms/);
    expect(Date.now() - started).toBeLessThan(3000);
    await publisher.close();
  });

  it('treats an unknown queue and unreviewed options as permanent errors', async () => {
    const publisher = createBullmqPublisher(parseRedisUrl(config.REDIS_URL), createLogger(config), {
      prefix,
    });
    const row = {
      id: 'x',
      queue: QUEUE_NAMES.email,
      jobName: EMAIL_JOBS.send,
      jobId: 'permanent',
      payload: {},
      options: {},
      attempts: 0,
    };
    await expect(publisher.publish({ ...row, queue: 'nope' })).rejects.toMatchObject({
      name: 'PermanentOutboxError',
    });
    await expect(
      publisher.publish({ ...row, options: { repeat: { every: 1 } } }),
    ).rejects.toMatchObject({ name: 'PermanentOutboxError' });
    await publisher.close();
  });
});
