import { createRedactor } from '@watchtower/ai';
import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

import { gmail } from '@watchtower/channels';
import { enqueueOutbox, schema } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import {
  AUDIT_ACTIONS,
  INBOUND_QUEUES,
  INGEST_JOBS,
  INGEST_OUTBOX_JOB_OPTIONS,
  QUEUE_NAMES,
  parseRedisUrl,
  realtimeEventSchema,
  type OutboxJobOptions,
  type RealtimeEvent,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { startWorker, type RunningWorker } from '../worker.js';
import type { InboundClassifierHook } from './classifier.js';
import { createS3ObjectStore, type ObjectStore } from './object-store.js';

// Event -> ticket through the real worker: Postgres (restricted application role), Redis (outbox
// relay, BullMQ, pub/sub) and MinIO (raw payloads) from docker compose. Nothing leaves the machine:
// disableNetConnect allows loopback only.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const prefix = `wt-ingest-${randomBytes(4).toString('hex')}`;
const realtimeChannel = `watchtower:realtime:${prefix}`;

const net = disableNetConnect();

let testDb: TestDatabase;
let worker: RunningWorker;
let config: ReturnType<typeof testConfig>;
let store: ObjectStore;
let subscriber: Redis;
let gmailId = '';
let lineId = '';
let portalId = '';
const received: RealtimeEvent[] = [];
const storedKeys = new Set<string>();

/** What a test changes between cases: how the storage and the classifier behave. */
const behaviour = {
  storeFailures: 0,
  classifier: 'none' as 'none' | 'slow' | 'internal',
  classifierSeen: [] as { subject: string; body: string }[],
};

const owner = () => testDb.owner.db;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  config = {
    ...testConfig({
      DATABASE_URL: testDb.appUrl,
      OUTBOX_POLL_INTERVAL_MS: '100',
      INGEST_CLASSIFIER_TIMEOUT_MS: '300',
    }),
    listenPort: 0,
  };
  const real = createS3ObjectStore({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET,
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
  });
  // The real MinIO, with failures on demand and a record of what was written (for cleanup).
  store = {
    async put(key, body, contentType) {
      if (behaviour.storeFailures > 0) {
        behaviour.storeFailures -= 1;
        throw new Error('simulated storage outage');
      }
      storedKeys.add(key);
      await real.put(key, body, contentType);
    },
    get: (key) => real.get(key),
    getStream: (key) => real.getStream(key),
    delete: (key) => real.delete(key),
  };
  const hook: InboundClassifierHook = {
    redact: (text) => createRedactor().session({ scope: 'ingest-test' }).redact(text),
    classify: (input, signal) => {
      behaviour.classifierSeen.push({ subject: input.subject, body: input.body });
      if (behaviour.classifier === 'slow') {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });
      }
      return Promise.resolve({
        type: 'internal_or_machine',
        intentKey: null,
        confidence: 0.8,
        source: 'ai',
        aiRunId: null,
      });
    },
  };
  worker = await startWorker(config, createLogger(config), {
    queuePrefix: prefix,
    realtimeChannel,
    overrides: {
      ingest: {
        store,
        // T-182: small limits so a test bomb is a few hundred bytes.
        archiveLimits: { maxMemberBytes: 100_000, maxTotalBytes: 300_000, maxMembers: 10 },
        // Resolved per event: 'none' behaves like production today (no classifier registered).
        classifier: () => ({
          redact: (text) => hook.redact(text),
          classify: (input, signal) =>
            behaviour.classifier === 'none'
              ? Promise.reject(new Error('no classifier configured in this case'))
              : hook.classify(input, signal),
        }),
      },
    },
  });

  subscriber = new Redis({ ...parseRedisUrl(config.REDIS_URL), maxRetriesPerRequest: 2 });
  await subscriber.subscribe(realtimeChannel);
  subscriber.on('message', (_channel: string, payload: string) => {
    received.push(realtimeEventSchema.parse(JSON.parse(payload)));
  });

  const accounts = await owner()
    .insert(schema.channelAccount)
    .values([
      { type: 'gmail', name: 'Support mailbox' },
      { type: 'line', name: 'Support LINE OA' },
    ])
    .returning();
  // The client portal account exists from migration 0002: a channel nobody ingests from.
  const [portal] = await owner()
    .select({ id: schema.channelAccount.id })
    .from(schema.channelAccount)
    .where(eq(schema.channelAccount.type, 'portal'));
  gmailId = accounts.find((account) => account.type === 'gmail')?.id ?? '';
  lineId = accounts.find((account) => account.type === 'line')?.id ?? '';
  portalId = portal?.id ?? '';
});

afterAll(async () => {
  await subscriber.quit();
  await worker.close();
  for (const key of storedKeys) await store.delete(key).catch(() => undefined);
  const connection = parseRedisUrl(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAMES.ingest, { connection, prefix });
  await queue.obliterate({ force: true });
  await queue.close();
  await testDb.cleanup();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** What a webhook receiver does: the event and its outbox job in one transaction. */
async function receive(
  accountId: string,
  providerEventId: string,
  payload: Record<string, unknown>,
  options: OutboxJobOptions = INGEST_OUTBOX_JOB_OPTIONS,
): Promise<string> {
  return owner().transaction(async (tx) => {
    const [event] = await tx
      .insert(schema.inboundEvent)
      .values({ channelAccountId: accountId, providerEventId, payload })
      .returning({ id: schema.inboundEvent.id });
    if (!event) throw new Error('no event row');
    await enqueueOutbox(tx, {
      queue: INBOUND_QUEUES.ingest,
      jobName: INGEST_JOBS.process,
      jobId: event.id,
      payload: { inboundEventId: event.id },
      options: { ...options },
    });
    return event.id;
  });
}

async function eventRow(id: string) {
  const [row] = await owner()
    .select()
    .from(schema.inboundEvent)
    .where(eq(schema.inboundEvent.id, id));
  if (!row) throw new Error('no event');
  return row;
}

const settled = (id: string) =>
  waitFor('the event to be finished', async () => {
    const row = await eventRow(id);
    return row.status === 'pending' ? undefined : row;
  });

let sequence = 0;
function mailPayload(
  options: Partial<Parameters<typeof gmail.buildFakeMime>[0]> = {},
  extra: Record<string, unknown> = {},
) {
  sequence += 1;
  const from = options.from ?? `somchai${String(sequence)}@customer.example.test`;
  const mime = gmail.buildFakeMime({
    fromName: 'สมชาย ใจดี',
    subject: 'ระบบรายงานเปิดไม่ได้',
    body: 'สวัสดีครับ เปิดรายงานไม่ได้ตั้งแต่เช้า',
    messageId: `m${String(sequence)}-${randomBytes(3).toString('hex')}@customer.example.test`,
    ...options,
    from,
  });
  return {
    from,
    mime,
    payload: {
      id: `g-${prefix}-${String(sequence)}`,
      threadId: `thread-${prefix}-${String(sequence)}`,
      labelIds: ['INBOX', 'UNREAD'],
      raw: mime.rawBase64Url,
      ...extra,
    },
  };
}

/** One-member zip (central directory and all), for a test bomb. */
function tinyZip(name: string, data: Buffer): Buffer {
  const body = deflateRawSync(data);
  const fileName = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  const directoryOffset = 30 + fileName.length + body.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + fileName.length, 12);
  end.writeUInt32LE(directoryOffset, 16);
  return Buffer.concat([local, fileName, body, central, fileName, end]);
}

/** A mail with attachments: `buildFakeMime` has none, so the multipart is written here. */
function mailWithAttachments(files: readonly { name: string; type: string; data: Buffer }[]) {
  sequence += 1;
  const from = `sender${String(sequence)}@customer.example.test`;
  const messageId = `att${String(sequence)}-${randomBytes(3).toString('hex')}@customer.example.test`;
  const boundary = `b-${randomBytes(6).toString('hex')}`;
  const crlf = '\r\n';
  const parts = [
    [`--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', '', 'see attached', ''].join(crlf),
    ...files.map((file) =>
      [
        `--${boundary}`,
        `Content-Type: ${file.type}; name="${file.name}"`,
        `Content-Disposition: attachment; filename="${file.name}"`,
        'Content-Transfer-Encoding: base64',
        '',
        file.data.toString('base64').replace(/.{1,76}/g, `$&${crlf}`),
      ].join(crlf),
    ),
    `--${boundary}--${crlf}`,
  ];
  const head = [
    `From: ${from}`,
    'To: support@fake.example.test',
    'Subject: files',
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].join(crlf);
  const raw = Buffer.from(`${head}${crlf}${crlf}${parts.join('')}`);
  return {
    id: `g-${prefix}-${String(sequence)}`,
    threadId: `thread-${prefix}-${String(sequence)}`,
    labelIds: ['INBOX', 'UNREAD'],
    raw: raw.toString('base64url'),
  };
}

async function messageFor(eventId: string) {
  const [row] = await owner()
    .select()
    .from(schema.inboundMessage)
    .where(eq(schema.inboundMessage.inboundEventId, eventId));
  return row;
}

async function ticketCount(): Promise<number> {
  return (await owner().select({ id: schema.ticket.id }).from(schema.ticket)).length;
}

describe('ingest queue: an event becomes a ticket', () => {
  it('turns a Gmail event into a ticket, keeps the raw mail in MinIO and publishes after commit', async () => {
    const { mime, payload } = mailPayload();
    const eventId = await receive(gmailId, payload.id, payload);
    const event = await settled(eventId);

    expect(event).toMatchObject({ status: 'processed', errorCode: null, payload: {} });
    expect(event.processedAt).not.toBeNull();
    const inbound = await messageFor(eventId);
    expect(inbound).toMatchObject({
      disposition: 'ticket',
      providerMessageId: payload.id,
      subject: 'ระบบรายงานเปิดไม่ได้',
      threadKey: `gmail:${payload.threadId}`,
    });
    const [ticket] = await owner()
      .select()
      .from(schema.ticket)
      .where(eq(schema.ticket.id, inbound?.ticketId ?? ''));
    expect(ticket).toMatchObject({
      channel: 'gmail',
      subject: 'ระบบรายงานเปิดไม่ได้',
      status: 'new',
    });

    // The raw mail is in object storage, and both rows point at it.
    expect(inbound?.rawObjectKey).toMatch(
      new RegExp(`^raw/gmail/${gmailId}/\\d{4}/\\d{2}/g-${prefix}-\\d+\\.eml$`),
    );
    expect(event.rawObjectKey).toBe(inbound?.rawObjectKey);
    const stored = await store.get(inbound?.rawObjectKey ?? '');
    expect(Buffer.from(stored ?? []).equals(Buffer.from(mime.raw))).toBe(true);

    // Realtime events go out after the commit, with ids only.
    const realtime = await waitFor('realtime events', () => {
      const mine = received.filter(
        (candidate) =>
          candidate.type !== 'notification.created' &&
          candidate.type !== 'alert.updated' &&
          candidate.ticketId === ticket?.id &&
          !(candidate.type === 'ticket.updated' && candidate.data.changed.join() === 'ai'),
      );
      return mine.length >= 2 ? mine : undefined;
    });
    expect(realtime.map((candidate) => candidate.type).toSorted()).toEqual([
      'message.created',
      'ticket.created',
    ]);
    // One system audit row says what became of the message.
    const audit = (await owner().select().from(schema.auditLog)).filter(
      (row) => row.action === AUDIT_ACTIONS.inboundIngest && row.targetId === inbound?.id,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: 'system', metadata: { disposition: 'ticket' } });
  });

  it('blocks an archive clamd could not scan in full: metadata and a blocked label, no object (T-182)', async () => {
    const bomb = tinyZip('big.bin', Buffer.alloc(500_000));
    expect(bomb.length).toBeLessThan(2000);
    const payload = mailWithAttachments([
      { name: 'notes.txt', type: 'text/plain', data: Buffer.from('plain notes') },
      { name: 'bomb.zip', type: 'application/zip', data: bomb },
      { name: 'ok.zip', type: 'application/zip', data: tinyZip('a.txt', Buffer.alloc(1000, 97)) },
    ]);
    const eventId = await receive(gmailId, payload.id, payload);
    expect(await settled(eventId)).toMatchObject({ status: 'processed' });
    const inbound = await messageFor(eventId);
    const files = (inbound?.attachments ?? []) as {
      filename: string;
      objectKey: string | null;
      blocked?: string;
      size: number;
    }[];
    const byName = new Map(files.map((file) => [file.filename, file]));
    expect(byName.get('bomb.zip')).toMatchObject({
      objectKey: null,
      blocked: 'archive_member_too_large',
    });
    expect(byName.get('bomb.zip')?.size).toBeGreaterThan(0);
    expect(byName.get('notes.txt')?.objectKey).toMatch(/^attachments\//);
    expect(byName.get('notes.txt')?.blocked).toBeUndefined();
    expect(byName.get('ok.zip')?.objectKey).toMatch(/^attachments\//);
    // Nothing was written for the blocked part.
    const keys = [...storedKeys].filter((key) => key.includes(`g-${prefix}-`));
    expect(keys.filter((key) => key.startsWith('attachments/'))).toHaveLength(2);
  });

  it('is idempotent on replay: a second job for a finished event, and a re-run of an unfinished one', async () => {
    const { payload } = mailPayload();
    const eventId = await receive(gmailId, payload.id, payload);
    await settled(eventId);
    // Count only what belongs to this event: earlier cases leave retries and realtime events in flight
    // that may land in the middle of this one, so database-wide counts made this test flaky.
    const ticketId = (await messageFor(eventId))?.ticketId ?? '';
    const own = async () => ({
      inboundMessages: (
        await owner()
          .select({ id: schema.inboundMessage.id })
          .from(schema.inboundMessage)
          .where(eq(schema.inboundMessage.inboundEventId, eventId))
      ).length,
      messages: (
        await owner()
          .select({ id: schema.message.id })
          .from(schema.message)
          .where(eq(schema.message.ticketId, ticketId))
      ).length,
      // The AI keeps working on the ticket after ingestion (T-108) and tells the web with a
      // `changed: ['ai']` event; that is not ingestion replaying.
      events: received.filter(
        (event) =>
          JSON.stringify(event).includes(ticketId) &&
          !(event.type === 'ticket.updated' && event.data.changed.join() === 'ai'),
      ).length,
    });
    const before = await own();
    expect(ticketId).not.toBe('');

    // 1. BullMQ delivers the job again: the event is not pending any more, so nothing happens.
    const queue = new Queue(QUEUE_NAMES.ingest, {
      connection: parseRedisUrl(config.REDIS_URL),
      prefix,
    });
    try {
      const job = await queue.add(
        INGEST_JOBS.process,
        { inboundEventId: eventId },
        { jobId: `replay-${eventId}` },
      );
      await waitFor('the replayed job', async () => (await job.isCompleted()) || undefined);
      expect((await queue.getJob(job.id ?? ''))?.returnvalue).toMatchObject({
        status: 'skipped',
        messages: 0,
      });
    } finally {
      await queue.close();
    }

    // 2. A crash after the commit but before the event was marked: simulate by resetting the event.
    //    The message row is already decided, so the domain writes nothing and publishes nothing.
    await owner()
      .update(schema.inboundEvent)
      .set({ status: 'pending', payload, processedAt: null })
      .where(eq(schema.inboundEvent.id, eventId));
    const queue2 = new Queue(QUEUE_NAMES.ingest, {
      connection: parseRedisUrl(config.REDIS_URL),
      prefix,
    });
    try {
      const job = await queue2.add(
        INGEST_JOBS.process,
        { inboundEventId: eventId },
        { jobId: `rerun-${eventId}` },
      );
      await waitFor('the re-run', async () => (await job.isCompleted()) || undefined);
      expect((await queue2.getJob(job.id ?? ''))?.returnvalue).toMatchObject({
        status: 'processed',
        dispositions: ['ticket'],
      });
    } finally {
      await queue2.close();
    }
    expect((await eventRow(eventId)).status).toBe('processed');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await own()).toEqual(before);
    expect((await messageFor(eventId))?.ticketId).toBe(ticketId);
  });

  it('appends a reply from the same thread to the ticket and reopens one waiting on the customer', async () => {
    const first = mailPayload();
    const firstEvent = await receive(gmailId, first.payload.id, first.payload);
    await settled(firstEvent);
    const ticketId = (await messageFor(firstEvent))?.ticketId ?? '';
    await owner()
      .update(schema.ticket)
      .set({ status: 'waiting_on_customer', slaPausedAt: new Date() })
      .where(eq(schema.ticket.id, ticketId));

    // Same sender as the first mail, so the organization check passes.
    const fromFirst = mailPayload(
      {
        from: first.from,
        subject: 'Re: ระบบรายงานเปิดไม่ได้',
        body: 'ยังเปิดไม่ได้ครับ',
        inReplyTo: first.mime.messageId,
      },
      { threadId: first.payload.threadId },
    );
    const replyEvent = await receive(gmailId, fromFirst.payload.id, fromFirst.payload);
    await settled(replyEvent);

    const inbound = await messageFor(replyEvent);
    expect(inbound).toMatchObject({ disposition: 'appended', ticketId });
    const [ticket] = await owner()
      .select()
      .from(schema.ticket)
      .where(eq(schema.ticket.id, ticketId));
    expect(ticket).toMatchObject({ status: 'open', slaPausedAt: null });
    const messages = await owner()
      .select()
      .from(schema.message)
      .where(eq(schema.message.ticketId, ticketId));
    expect(messages.map((message) => message.bodyText).toSorted()).toEqual([
      'ยังเปิดไม่ได้ครับ',
      'สวัสดีครับ เปิดรายงานไม่ได้ตั้งแต่เช้า',
    ]);
  });

  it('keeps a newsletter and an out-of-office reply out of the ticket flow but stores them raw', async () => {
    const tickets = await ticketCount();
    const newsletter = mailPayload({
      headers: { 'List-Unsubscribe': '<mailto:u@vendor.example.test>' },
    });
    const away = mailPayload({
      headers: { 'Auto-Submitted': 'auto-replied' },
      subject: 'Automatic reply',
    });
    const newsEvent = await receive(gmailId, newsletter.payload.id, newsletter.payload);
    const awayEvent = await receive(gmailId, away.payload.id, away.payload);
    await settled(newsEvent);
    await settled(awayEvent);

    const news = await messageFor(newsEvent);
    const auto = await messageFor(awayEvent);
    expect(news).toMatchObject({ disposition: 'noise', ticketId: null });
    expect(auto).toMatchObject({ disposition: 'auto_reply', ticketId: null });
    expect(await ticketCount()).toBe(tickets);
    expect(await store.get(news?.rawObjectKey ?? '')).not.toBeNull();
    expect(await store.get(auto?.rawObjectKey ?? '')).not.toBeNull();
  });

  it('turns a LINE message into a ticket of an unverified contact, then keeps the chat on it', async () => {
    const userId = `U${randomBytes(8).toString('hex')}`;
    const lineEvent = (text: string, id: string) => ({
      type: 'message',
      mode: 'active',
      timestamp: Date.now(),
      webhookEventId: `01${id}`,
      deliveryContext: { isRedelivery: false },
      source: { type: 'user', userId },
      replyToken: `reply-${id}`,
      message: { type: 'text', id: `line-${prefix}-${id}`, text },
    });
    const first = await receive(lineId, `01a-${prefix}`, lineEvent('ระบบล่มครับ ช่วยด้วย', 'a'));
    await settled(first);
    const firstMessage = await messageFor(first);
    expect(firstMessage).toMatchObject({ disposition: 'ticket', lineUserId: userId, subject: '' });
    expect(firstMessage?.rawObjectKey).toMatch(
      new RegExp(`^raw/line/${lineId}/\\d{4}/\\d{2}/line-${prefix}-a\\.json$`),
    );
    const [ticket] = await owner()
      .select()
      .from(schema.ticket)
      .where(eq(schema.ticket.id, firstMessage?.ticketId ?? ''));
    expect(ticket).toMatchObject({ channel: 'line', subject: 'ระบบล่มครับ ช่วยด้วย' });
    const [contact] = await owner()
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.id, ticket?.requesterContactId ?? ''));
    expect(contact).toMatchObject({ lineUserId: userId, verifiedAt: null });

    const second = await receive(lineId, `01b-${prefix}`, lineEvent('ยังไม่ได้เลยครับ', 'b'));
    await settled(second);
    expect(await messageFor(second)).toMatchObject({
      disposition: 'appended',
      ticketId: ticket?.id,
    });
  });
});

describe('ingest queue: failures', () => {
  it('marks an event it can never process as failed, with a code, and does not retry it', async () => {
    const garbage = await receive(gmailId, `garbage-${prefix}`, { hello: 'world' });
    const unsupported = await receive(portalId, `portal-${prefix}`, { anything: true });
    expect(await settled(garbage)).toMatchObject({
      status: 'failed',
      errorCode: 'gmail_payload_invalid',
    });
    expect(await settled(unsupported)).toMatchObject({
      status: 'failed',
      errorCode: 'channel_not_supported',
    });
  });

  it('keeps no LINE reply token on an event that failed, whichever way it failed (N-6)', async () => {
    const userId = `U${randomBytes(8).toString('hex')}`;
    const event = (id: string) => ({
      type: 'message',
      mode: 'active',
      timestamp: Date.now(),
      webhookEventId: `01${id}`,
      deliveryContext: { isRedelivery: false },
      source: { type: 'user', userId },
      replyToken: `reply-secret-${id}`,
      message: { type: 'text', id: `line-${prefix}-${id}`, text: 'hello' },
    });
    // Permanent: the payload cannot be read as a LINE event.
    const broken = await receive(lineId, `01x-${prefix}`, {
      type: 'message',
      replyToken: 'reply-secret-x',
      message: 'not an object',
    });
    const brokenEvent = await settled(broken);
    expect(brokenEvent.status).toBe('failed');
    expect(JSON.stringify(brokenEvent.payload)).not.toContain('reply-secret');
    // Transient, then out of attempts.
    behaviour.storeFailures = 100;
    try {
      const exhausted = await receive(lineId, `01y-${prefix}`, event('y'), {
        attempts: 2,
        backoff: { type: 'fixed', delay: 100 },
      });
      const row = await settled(exhausted);
      expect(row).toMatchObject({ status: 'failed', errorCode: 'ingest_error' });
      expect(JSON.stringify(row.payload)).not.toContain('reply-secret');
      // The rest of the event stays for whoever investigates.
      expect(row.payload).toMatchObject({ webhookEventId: '01y', source: { userId } });
    } finally {
      behaviour.storeFailures = 0;
    }
  });

  it('retries a storage outage and finishes the event once storage is back', async () => {
    const { payload } = mailPayload();
    behaviour.storeFailures = 2;
    const eventId = await receive(gmailId, payload.id, payload, {
      attempts: 5,
      backoff: { type: 'fixed', delay: 100 },
    });
    const event = await settled(eventId);
    expect(event).toMatchObject({ status: 'processed' });
    expect(behaviour.storeFailures).toBe(0);
    const tickets = (await owner().select().from(schema.inboundMessage)).filter(
      (row) => row.providerMessageId === payload.id,
    );
    expect(tickets).toHaveLength(1);
  });

  it('marks the event failed when the last attempt is used up, and writes nothing', async () => {
    const { payload } = mailPayload();
    const before = await ticketCount();
    behaviour.storeFailures = 100;
    try {
      const eventId = await receive(gmailId, payload.id, payload, {
        attempts: 2,
        backoff: { type: 'fixed', delay: 100 },
      });
      expect(await settled(eventId)).toMatchObject({ status: 'failed', errorCode: 'ingest_error' });
      expect(await messageFor(eventId)).toBeUndefined();
      expect(await ticketCount()).toBe(before);
    } finally {
      behaviour.storeFailures = 0;
    }
  });
});

describe('ingest queue: classifier hook', () => {
  it('uses the rules when the classifier is too slow, and never shows it unredacted text', async () => {
    behaviour.classifier = 'slow';
    behaviour.classifierSeen = [];
    try {
      const { payload } = mailPayload({
        subject: 'โทรกลับ 081-234-5678',
        body: 'เลขบัตร 1-2345-67890-12-1',
      });
      const started = Date.now();
      const eventId = await receive(gmailId, payload.id, payload);
      await settled(eventId);
      expect(Date.now() - started).toBeLessThan(5000);
      const inbound = await messageFor(eventId);
      expect(inbound).toMatchObject({
        disposition: 'ticket',
        classification: { type: 'triage', source: 'rules' },
      });
      expect(behaviour.classifierSeen).toHaveLength(1);
      expect(JSON.stringify(behaviour.classifierSeen)).not.toMatch(/081|5678|2345|67890/);
    } finally {
      behaviour.classifier = 'none';
    }
  });

  it('applies what the classifier says when it answers in time', async () => {
    behaviour.classifier = 'internal';
    try {
      const { payload } = mailPayload();
      const tickets = await ticketCount();
      const eventId = await receive(gmailId, payload.id, payload);
      await settled(eventId);
      expect(await messageFor(eventId)).toMatchObject({
        disposition: 'internal',
        ticketId: null,
        classification: { type: 'internal_or_machine', source: 'ai', confidence: 0.8 },
      });
      expect(await ticketCount()).toBe(tickets);
    } finally {
      behaviour.classifier = 'none';
    }
  });
});
