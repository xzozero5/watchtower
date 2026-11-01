import { randomBytes, randomUUID } from 'node:crypto';

import type { gmail } from '@watchtower/channels';
import { createDatabase, enqueueOutbox, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import {
  GMAIL_JOBS,
  GMAIL_QUEUES,
  GMAIL_SYNC_OUTBOX_JOB_OPTIONS,
  QUEUE_NAMES,
  parseRedisUrl,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createS3ObjectStore, type ObjectStore } from '../ingest/index.js';
import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { startWorker, type RunningWorker } from '../worker.js';
import { createMockGmailRuntime, type MockGmailRuntime } from './runtime.js';

// The whole path through the real worker, with the in-memory Gmail: an outbox row (what the push
// receiver writes) -> relay -> `gmail` consumer (history sync) -> `inbound_event` + `ingest` outbox
// job -> relay -> `ingest` consumer -> ticket, raw mail and attachment in MinIO. Postgres (restricted
// application role), Redis and MinIO are the compose services on localhost; disableNetConnect
// allows loopback only, so a transport that tried to reach Google would fail the run.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const prefix = `wt-gmail-${randomBytes(4).toString('hex')}`;
const net = disableNetConnect();

let testDb: TestDatabase;
let database: Database;
let worker: RunningWorker;
let runtime: MockGmailRuntime;
let store: ObjectStore;
let config: ReturnType<typeof testConfig>;
let accountId = '';
let fake: gmail.FakeGmailTransport;
const storedKeys = new Set<string>();

const owner = () => testDb.owner.db;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  database = createDatabase({ url: testDb.appUrl, max: 3, applicationName: 'wt-gmail-e2e' });
  config = {
    ...testConfig({ DATABASE_URL: testDb.appUrl, OUTBOX_POLL_INTERVAL_MS: '100' }),
    listenPort: 0,
  };
  const real = createS3ObjectStore({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET,
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
  });
  store = {
    async put(key, body, contentType) {
      storedKeys.add(key);
      await real.put(key, body, contentType);
    },
    get: (key) => real.get(key),
    delete: (key) => real.delete(key),
  };
  runtime = createMockGmailRuntime({ database });
  worker = await startWorker(config, createLogger(config), {
    queuePrefix: prefix,
    realtimeChannel: `watchtower:realtime:${prefix}`,
    overrides: { gmail: { runtime }, ingest: { store } },
  });
  const [account] = await owner()
    .insert(schema.channelAccount)
    .values({ type: 'gmail', name: 'Support mailbox' })
    .returning({ id: schema.channelAccount.id });
  accountId = account?.id ?? '';
  await owner()
    .insert(schema.gmailAccountState)
    .values({ channelAccountId: accountId, emailAddress: 'support@desk.example.test' });
  fake = runtime.fakeFor(accountId);
});

afterAll(async () => {
  await worker.close();
  await database.close();
  for (const key of storedKeys) await store.delete(key).catch(() => undefined);
  const queue = new Queue(QUEUE_NAMES.gmail, {
    connection: parseRedisUrl(config.REDIS_URL),
    prefix,
  });
  await queue.obliterate({ force: true });
  await queue.close();
  const ingestQueue = new Queue(QUEUE_NAMES.ingest, {
    connection: parseRedisUrl(config.REDIS_URL),
    prefix,
  });
  await ingestQueue.obliterate({ force: true });
  await ingestQueue.close();
  await testDb.cleanup();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function pushRow(jobId: string, payload: Record<string, unknown>) {
  return enqueueOutbox(owner(), {
    queue: GMAIL_QUEUES.gmail,
    jobName: GMAIL_JOBS.sync,
    jobId,
    payload,
    options: { ...GMAIL_SYNC_OUTBOX_JOB_OPTIONS },
  });
}

describe('the gmail queue through the real worker', () => {
  it('turns a push into a ticket: sync, ingest, raw mail and attachment in MinIO', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(1500)]);
    const messageId = `${randomUUID()}@customer.example.com`;
    const boundary = 'BOUNDARY-E2E';
    const raw = [
      'From: somchai@customer.example.com',
      'To: support@desk.example.test',
      `Subject: =?UTF-8?B?${Buffer.from('ใบแจ้งหนี้เดือนนี้', 'utf8').toString('base64')}?=`,
      `Message-ID: <${messageId}>`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('ส่งไฟล์แนบมาให้ครับ', 'utf8').toString('base64'),
      `--${boundary}`,
      'Content-Type: application/pdf; name="invoice.pdf"',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      pdf.toString('base64').replace(/.{1,76}/g, '$&\r\n'),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const delivered = fake.deliver(raw, { labelIds: ['INBOX', 'UNREAD'] });

    // What the receiver writes for one push (the api test covers the receiver itself).
    await pushRow(`push-${accountId}-1001`, {
      channelAccountId: accountId,
      reason: 'push',
      pushHistoryId: delivered.historyId,
    });

    const message = await waitFor('the message to become a ticket', async () => {
      const [row] = await owner()
        .select()
        .from(schema.inboundMessage)
        .where(eq(schema.inboundMessage.channelAccountId, accountId));
      return row?.disposition === 'pending' ? undefined : row;
    });
    expect(message).toMatchObject({
      providerMessageId: delivered.id,
      subject: 'ใบแจ้งหนี้เดือนนี้',
      disposition: 'ticket',
    });
    const attachments = message.attachments as { objectKey: string | null; filename: string }[];
    expect(attachments[0]?.filename).toBe('invoice.pdf');
    const saved = await store.get(attachments[0]?.objectKey ?? '');
    expect(Buffer.from(saved ?? [])).toEqual(pdf);
    expect(await store.get(message.rawObjectKey ?? '')).not.toBeNull();

    const [state] = await owner()
      .select()
      .from(schema.gmailAccountState)
      .where(eq(schema.gmailAccountState.channelAccountId, accountId));
    expect(state).toMatchObject({ historyId: fake.currentHistoryId, lastErrorCode: null });

    // A second push for the same mail (Pub/Sub is at-least-once): nothing new.
    await pushRow(`push-${accountId}-1002`, { channelAccountId: accountId, reason: 'push' });
    await waitFor('the second sync to finish', async () => {
      const [again] = await owner()
        .select()
        .from(schema.gmailAccountState)
        .where(eq(schema.gmailAccountState.channelAccountId, accountId));
      return (again?.lastSyncAt?.getTime() ?? 0) > (state?.lastSyncAt?.getTime() ?? 0)
        ? again
        : undefined;
    });
    expect(
      await owner()
        .select({ id: schema.inboundMessage.id })
        .from(schema.inboundMessage)
        .where(eq(schema.inboundMessage.channelAccountId, accountId)),
    ).toHaveLength(1);
  });

  it('keeps a job it can never process in the failed set (dead letter) instead of retrying it', async () => {
    await pushRow(`bad-${randomUUID()}`, { not: 'a sync job' });
    const queue = new Queue(QUEUE_NAMES.gmail, {
      connection: parseRedisUrl(config.REDIS_URL),
      prefix,
    });
    try {
      const failed = await waitFor('the invalid job to fail', async () => {
        const jobs = await queue.getFailed();
        return jobs.length > 0 ? jobs : undefined;
      });
      expect(failed[0]?.failedReason).toBe('gmail sync payload is invalid');
      expect(failed[0]?.attemptsMade).toBe(1);
    } finally {
      await queue.close();
    }
  });

  it('registers the daily watch renewal and the heartbeat as repeating jobs on the gmail queue', async () => {
    const queue = new Queue(QUEUE_NAMES.gmail, {
      connection: parseRedisUrl(config.REDIS_URL),
      prefix,
    });
    try {
      const schedulers = await queue.getJobSchedulers();
      expect(schedulers.map((scheduler) => scheduler.key).toSorted()).toEqual(
        [GMAIL_JOBS.heartbeat, GMAIL_JOBS.renewWatch].toSorted(),
      );
      const renew = schedulers.find((scheduler) => scheduler.key === GMAIL_JOBS.renewWatch);
      expect(renew?.pattern).toBe('15 2 * * *');
    } finally {
      await queue.close();
    }
  });
});
