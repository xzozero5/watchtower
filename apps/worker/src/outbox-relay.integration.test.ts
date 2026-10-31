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
import { createBullmqPublisher, withNotAfter } from './outbox-relay.js';
import { sealedEmailPayload, testConfig, testSealKey } from './testing/support.js';
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
    await emailQueue.add(row.jobName, withNotAfter(row.payload, row.expiresAt), {
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

/**
 * What the api does inside its transaction: one outbox row for one email, the link sealed and an
 * expiry set. Returns the link, to assert it never shows up where it should not.
 */
async function apiWritesEmail(recipient: string, jobId: string, ttlSeconds = 900): Promise<string> {
  const link = `http://localhost:3000/login/magic#token=${randomBytes(16).toString('hex')}`;
  const job: EmailJob = { kind: 'magic_link', to: recipient, link, expiresInMinutes: 15 };
  await apiDb.db.transaction(async (tx) => {
    await enqueueOutbox(tx, {
      queue: QUEUE_NAMES.email,
      jobName: EMAIL_JOBS.send,
      jobId,
      payload: sealedEmailPayload(job, jobId, testSealKey(config)),
      options: EMAIL_OUTBOX_JOB_OPTIONS,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    });
  });
  return link;
}

describe('outbox relay in the worker', () => {
  it('moves a row the api wrote to BullMQ and the email reaches Mailpit', async () => {
    redisUp = true;
    const recipient = `outbox-${randomBytes(4).toString('hex')}@example.com`;
    const jobId = `outbox-e2e-${randomBytes(4).toString('hex')}`;
    const link = await apiWritesEmail(recipient, jobId);

    // At rest the link is ciphertext: neither the pending row nor the queue ever holds it.
    const pending = await testDb.owner.pool.query<{ payload: unknown }>(
      'SELECT payload FROM outbox WHERE job_id = $1',
      [jobId],
    );
    expect(JSON.stringify(pending.rows[0]?.payload ?? 'sent already')).not.toContain('token=');

    const mail = await waitFor(() => mailFor(recipient), 'the email in Mailpit');
    expect(mail.Subject).toBe('Your Watchtower sign-in link');
    const sent = (await (await fetch(`${mailpit}/api/v1/message/${mail.ID}`)).json()) as {
      Text: string;
    };
    expect(sent.Text, 'the worker opened the link just before SMTP').toContain(link);
    for (const job of await emailQueue.getJobs([
      'waiting',
      'delayed',
      'active',
      'completed',
      'failed',
    ])) {
      expect(JSON.stringify(job.data), 'Redis never holds the link').not.toContain(link);
    }
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
      trackingUrl,
      expectedFirstResponseAt: null,
    };
    await apiDb.db.transaction(async (tx) => {
      await enqueueOutbox(tx, {
        queue: QUEUE_NAMES.email,
        jobName: EMAIL_JOBS.send,
        jobId,
        payload: sealedEmailPayload(job, jobId, testSealKey(config)),
        options: EMAIL_OUTBOX_JOB_OPTIONS,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
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

  it('never relays a row past its expiry: it is dead-lettered, blanked and nothing is mailed', async () => {
    redisUp = true;
    const recipient = `outbox-expired-${randomBytes(4).toString('hex')}@example.com`;
    const jobId = `outbox-expired-${randomBytes(4).toString('hex')}`;
    // Written with a lifetime that is already over, as if the worker had been down for a while.
    await apiWritesEmail(recipient, jobId, -5);
    const done = await waitFor(async () => {
      const { rows } = await testDb.owner.pool.query<{
        status: string;
        payload: unknown;
        last_error: string | null;
      }>('SELECT status, payload, last_error FROM outbox WHERE job_id = $1', [jobId]);
      return rows[0]?.status === 'dead' ? rows[0] : undefined;
    }, 'the expired row to be dead-lettered');
    expect(done.payload).toEqual({});
    expect(done.last_error).toContain('expired');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(handedOver).not.toContain(jobId);
    expect(await mailFor(recipient)).toBeUndefined();
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
        expiresAt: null,
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
      expiresAt: null,
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

describe('withNotAfter', () => {
  it('adds the row expiry to the job data, and leaves a row without expiry alone', () => {
    const at = new Date('2026-11-03T08:30:00.000Z');
    expect(withNotAfter({ to: 'a@example.com', secret: 'v1.x' }, at)).toEqual({
      to: 'a@example.com',
      secret: 'v1.x',
      notAfter: at.getTime(),
    });
    const payload = { to: 'a@example.com' };
    expect(withNotAfter(payload, null)).toBe(payload);
  });
});
