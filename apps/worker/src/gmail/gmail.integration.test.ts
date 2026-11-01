import { randomBytes, randomUUID } from 'node:crypto';

import { ChannelError, gmail } from '@watchtower/channels';
import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { createDomain, createPolicyGate, type Domain } from '@watchtower/domain';
import {
  AUDIT_ACTIONS,
  GMAIL_JOBS,
  GMAIL_QUEUES,
  INBOUND_QUEUES,
  gmailSyncJobSchema,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import type { Job } from 'bullmq';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createIngestProcessor, createMemoryObjectStore } from '../ingest/index.js';
import { createGmailIngestor } from '../ingest/channels.js';
import { createLogger } from '../logger.js';
import { createOutboundDispatcher } from '../outbound/dispatcher.js';
import { NO_CHANNELS } from '../outbound/channels.js';
import { testConfig } from '../testing/support.js';
import { createGmailRuntime, createMockGmailRuntime, type MockGmailRuntime } from './runtime.js';
import { createGmailSync, type GmailSync, type SyncSettings } from './sync.js';

// History sync (T-102c), the ingest it feeds, and the in-thread send (T-102d), on the real
// database (restricted application role, real policy gate) with the in-memory Gmail. The only
// objects that exist are rows in a throwaway database, an in-memory object store and fakes;
// disableNetConnect allows loopback only and the last case shows that nothing tried to leave.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const net = disableNetConnect();

const T0 = new Date('2030-01-07T10:00:00.000Z');
const HOST = 'desk.example.test';
const MAILBOX = 'support@desk.example.test';
const clock = { now: T0 };
const logger = createLogger(testConfig());

let testDb: TestDatabase;
let database: Database;
let domain: Domain;
let runtime: MockGmailRuntime;
let accountId: string;
let fake: gmail.FakeGmailTransport;

const owner = () => testDb.owner.db;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  database = createDatabase({ url: testDb.appUrl, max: 8, applicationName: 'wt-gmail-test' });
  domain = createDomain({
    ticketKeyPrefix: 'OPS',
    sealKey: randomBytes(32),
    portalUrl: 'https://desk.example.test/portal',
    policyGate: createPolicyGate({ db: database.db }),
    now: () => clock.now,
  });
  runtime = createMockGmailRuntime({ database, now: () => clock.now });
  await owner()
    .insert(schema.slaPolicy)
    .values({
      name: 'standard',
      tier: 'standard',
      targets: { P3: { first_response_min: 60, resolution_min: 240, calendar: '24x7' } },
    });
});

afterAll(async () => {
  await database.close();
  await testDb.cleanup();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

beforeEach(async () => {
  clock.now = T0;
  // A fresh mailbox per case: the fake numbers its messages from 1 and the cursor belongs to it.
  const [account] = await owner()
    .insert(schema.channelAccount)
    .values({ type: 'gmail', name: `Support mailbox ${randomUUID().slice(0, 8)}` })
    .returning({ id: schema.channelAccount.id });
  accountId = account?.id ?? '';
  await owner()
    .insert(schema.gmailAccountState)
    .values({
      channelAccountId: accountId,
      emailAddress: `${randomUUID().slice(0, 8)}-${MAILBOX}`,
    });
  fake = runtime.fakeFor(accountId);
});

function makeSync(settings: Partial<SyncSettings> = {}, overrideRuntime = runtime): GmailSync {
  return createGmailSync({
    database,
    domain,
    runtime: overrideRuntime,
    logger,
    now: () => clock.now,
    settings: { fullSyncDays: 7, fullSyncMaxMessages: 50, topicName: undefined, ...settings },
  });
}

let sequence = 0;
function deliver(
  labelIds: readonly string[] = ['INBOX', 'UNREAD'],
  options: Partial<Parameters<typeof gmail.buildFakeMime>[0]> = {},
  threadId?: string,
): gmail.GmailMessage {
  sequence += 1;
  const mime = gmail.buildFakeMime({
    from: `customer${String(sequence)}@customer.example.com`,
    fromName: 'สมชาย ใจดี',
    subject: `ระบบรายงานเปิดไม่ได้ ${String(sequence)}`,
    body: 'สวัสดีครับ เปิดรายงานไม่ได้ตั้งแต่เช้า',
    messageId: `m${String(sequence)}-${randomBytes(3).toString('hex')}@customer.example.com`,
    ...options,
  });
  return fake.deliver(mime.raw, { labelIds, ...(threadId === undefined ? {} : { threadId }) });
}

async function state() {
  const [row] = await owner()
    .select()
    .from(schema.gmailAccountState)
    .where(eq(schema.gmailAccountState.channelAccountId, accountId));
  if (!row) throw new Error('no state');
  return row;
}
async function events() {
  return owner()
    .select()
    .from(schema.inboundEvent)
    .where(eq(schema.inboundEvent.channelAccountId, accountId))
    .orderBy(asc(schema.inboundEvent.providerEventId));
}
async function jobsIn(queue: string) {
  const rows = await owner().select().from(schema.outbox).where(eq(schema.outbox.queue, queue));
  const events_ = await events();
  const ids = new Set(events_.map((event) => event.id));
  return queue === INBOUND_QUEUES.ingest ? rows.filter((row) => ids.has(row.jobId)) : rows;
}
async function auditOf(action: string) {
  const rows = await owner()
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, action));
  return rows.filter((row) => row.targetId === accountId);
}

describe('history sync', () => {
  it('runs a bounded full sync for a mailbox with no cursor and keeps sent, draft and spam mail out', async () => {
    deliver(['INBOX', 'UNREAD']);
    deliver(['INBOX']);
    deliver(['SENT']);
    deliver(['DRAFT']);
    deliver(['SPAM']);
    const last = deliver(['INBOX', 'UNREAD']);

    const result = await makeSync().syncAccount(accountId, 'push');
    expect(result).toMatchObject({
      status: 'synced',
      queued: 3,
      fullSync: 'no_cursor',
      truncated: false,
    });
    const rows = await events();
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.status === 'pending')).toBe(true);
    expect(rows.map((row) => row.payload)).toEqual(
      rows.map((row) => ({ messageId: row.providerEventId })),
    );
    const jobs = await jobsIn(INBOUND_QUEUES.ingest);
    expect(jobs).toHaveLength(3);
    expect(jobs.every((job) => job.status === 'pending' && job.jobName === 'process')).toBe(true);

    const after = await state();
    expect(after.historyId).toBe(last.historyId);
    expect(after.lastFullSyncAt).toEqual(T0);
    expect(after.lastSyncAt).toEqual(T0);
    expect(after.lastErrorCode).toBeNull();
    const [audit] = await auditOf(AUDIT_ACTIONS.gmailFullSync);
    expect(audit?.metadata).toMatchObject({
      reason: 'no_cursor',
      listed: 3,
      queued: 3,
      truncated: false,
    });
  });

  it('then reads only what is new from the cursor, and a repeat finds nothing', async () => {
    deliver();
    const sync = makeSync();
    await sync.syncAccount(accountId, 'push');
    const second = deliver();
    const third = deliver(['INBOX', 'IMPORTANT']);

    const result = await sync.syncAccount(accountId, 'push');
    expect(result).toMatchObject({ status: 'synced', queued: 2, pages: 1 });
    expect(result.fullSync).toBeUndefined();
    expect((await events()).map((row) => row.providerEventId)).toEqual(
      expect.arrayContaining([second.id, third.id]),
    );
    expect(await jobsIn(INBOUND_QUEUES.ingest)).toHaveLength(3);
    expect((await state()).historyId).toBe(fake.currentHistoryId);

    expect(await sync.syncAccount(accountId, 'push')).toMatchObject({ queued: 0 });
    expect(await events()).toHaveLength(3);
    // The second sync used history.list, not a listing of the whole mailbox.
    expect(fake.calls.filter((call) => call.op === 'listHistory').length).toBeGreaterThanOrEqual(2);
  });

  it('queues a message once however often it is seen: full sync after incremental, concurrent syncs', async () => {
    for (let index = 0; index < 4; index += 1) deliver();
    const sync = makeSync();
    await sync.syncAccount(accountId, 'push');
    await owner()
      .update(schema.gmailAccountState)
      .set({ historyId: null })
      .where(eq(schema.gmailAccountState.channelAccountId, accountId));
    expect(await sync.syncAccount(accountId, 'manual')).toMatchObject({
      fullSync: 'no_cursor',
      queued: 0,
    });

    for (let index = 0; index < 6; index += 1) deliver();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => makeSync().syncAccount(accountId, 'push')),
    );
    expect(results.reduce((sum, result) => sum + result.queued, 0)).toBe(6);
    expect(await events()).toHaveLength(10);
    expect(await jobsIn(INBOUND_QUEUES.ingest)).toHaveLength(10);
    expect((await state()).historyId).toBe(fake.currentHistoryId);
  });

  it('answers a 404 from history.list with a bounded full sync, audited, and says when the bound cut it', async () => {
    for (let index = 0; index < 5; index += 1) deliver();
    const sync = makeSync({ fullSyncMaxMessages: 10 });
    await sync.syncAccount(accountId, 'push');
    const cursorBefore = (await state()).historyId;
    for (let index = 0; index < 3; index += 1) deliver();
    fake.expireHistoryBefore(String(Number(fake.currentHistoryId) + 1));

    // Bounded to 4 messages: the three new ones and the newest old one.
    const bounded = makeSync({ fullSyncMaxMessages: 4 });
    const result = await bounded.syncAccount(accountId, 'push');
    expect(result).toMatchObject({
      status: 'synced',
      fullSync: 'history_expired',
      truncated: true,
    });
    expect(result.queued).toBe(3);
    expect(await events()).toHaveLength(8);
    const audits = await auditOf(AUDIT_ACTIONS.gmailFullSync);
    expect(audits).toHaveLength(2);
    expect(
      audits.find((row) => (row.metadata as { reason?: string }).reason === 'history_expired')
        ?.metadata,
    ).toMatchObject({
      reason: 'history_expired',
      listed: 4,
      truncated: true,
      maxMessages: 4,
    });
    const cursorAfter = (await state()).historyId;
    expect(Number(cursorAfter)).toBeGreaterThan(Number(cursorBefore));

    // The next push is an ordinary incremental sync again.
    const next = deliver();
    fake.expireHistoryBefore('0');
    expect(await bounded.syncAccount(accountId, 'push')).toMatchObject({ queued: 1 });
    expect((await events()).map((row) => row.providerEventId)).toContain(next.id);
  });

  it('reads long histories in pages and hands the rest to a continuation job', async () => {
    deliver();
    const sync = makeSync({ pageSize: 2, maxPagesPerRun: 2 });
    await sync.syncAccount(accountId, 'push');
    const sent = Array.from({ length: 7 }, () => deliver());

    const first = await sync.syncAccount(accountId, 'push');
    expect(first).toMatchObject({ queued: 4, pages: 2, continued: true });
    const [continuation] = (await jobsIn(GMAIL_QUEUES.gmail)).filter((job) =>
      job.jobId.startsWith('continuation-'),
    );
    expect(continuation).toMatchObject({ jobName: GMAIL_JOBS.sync });
    expect(gmailSyncJobSchema.parse(continuation?.payload)).toEqual({
      channelAccountId: accountId,
      reason: 'continuation',
    });
    // The cursor stopped at the last record of the second page, not at the end of the mailbox.
    expect(Number((await state()).historyId)).toBeLessThan(Number(fake.currentHistoryId));

    const second = await sync.syncAccount(accountId, 'continuation');
    expect(second).toMatchObject({ queued: 3, pages: 2 });
    expect(second.continued).toBeUndefined();
    expect((await events()).map((row) => row.providerEventId)).toEqual(
      expect.arrayContaining(sent.map((message) => message.id)),
    );
    expect(await events()).toHaveLength(8);
    expect((await state()).historyId).toBe(fake.currentHistoryId);
  });

  it('keeps the cursor and records a code when Gmail fails, then recovers on the next run', async () => {
    deliver();
    const sync = makeSync();
    await sync.syncAccount(accountId, 'push');
    const cursor = (await state()).historyId;
    deliver();
    fake.failNext(
      'users.history.list',
      new ChannelError({ provider: 'gmail', operation: 'users.history.list', kind: 'timeout' }),
    );
    await expect(sync.syncAccount(accountId, 'push')).rejects.toBeInstanceOf(ChannelError);
    expect(await state()).toMatchObject({ historyId: cursor, lastErrorCode: 'channel_timeout' });
    expect(await events()).toHaveLength(1);

    expect(await sync.syncAccount(accountId, 'push')).toMatchObject({ queued: 1 });
    expect(await state()).toMatchObject({ lastErrorCode: null });
  });

  it('does nothing for a disabled mailbox, an unknown one, or one this process cannot reach', async () => {
    deliver();
    await owner()
      .update(schema.gmailAccountState)
      .set({ enabled: false })
      .where(eq(schema.gmailAccountState.channelAccountId, accountId));
    expect(await makeSync().syncAccount(accountId, 'push')).toMatchObject({ status: 'skipped' });
    expect(await makeSync().syncAccount(randomUUID(), 'push')).toMatchObject({ status: 'skipped' });
    await owner()
      .update(schema.gmailAccountState)
      .set({ enabled: true })
      .where(eq(schema.gmailAccountState.channelAccountId, accountId));
    const unreachable = makeSync(
      {},
      { ...runtime, transportFor: () => Promise.resolve(undefined) },
    );
    expect(await unreachable.syncAccount(accountId, 'push')).toMatchObject({
      status: 'no_transport',
    });
    expect(await state()).toMatchObject({ lastErrorCode: 'transport_unavailable' });
    expect(await events()).toHaveLength(0);
  });
});

// -- ingest of what the sync queued, attachments, and the in-thread reply -----------------------

function multipart(boundary: string, parts: readonly string[]): string {
  return parts.map((part) => `--${boundary}\r\n${part}\r\n`).join('') + `--${boundary}--\r\n`;
}

/** A customer mail with a PDF attachment (synthetic bytes), as a real client would send it. */
function mailWithAttachment(
  messageId: string,
  pdf: Buffer,
  extra: Record<string, string> = {},
): Uint8Array {
  const body = multipart('BOUNDARY1', [
    'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
      Buffer.from('รายงานแนบมาด้วยครับ', 'utf8').toString('base64'),
    'Content-Type: application/pdf; name="report.pdf"\r\n' +
      'Content-Disposition: attachment; filename="report.pdf"\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      pdf.toString('base64').replace(/.{1,76}/g, '$&\r\n'),
  ]);
  const headers = {
    From:
      '=?UTF-8?B?' +
      Buffer.from('สมชาย', 'utf8').toString('base64') +
      '?= <somchai@customer.example.com>',
    To: MAILBOX,
    Subject: '=?UTF-8?B?' + Buffer.from('รายงานเดือนนี้', 'utf8').toString('base64') + '?=',
    'Message-ID': `<${messageId}>`,
    Date: 'Mon, 07 Jan 2030 10:00:00 +0000',
    'MIME-Version': '1.0',
    'Content-Type': 'multipart/mixed; boundary="BOUNDARY1"',
    ...extra,
  };
  const head = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\r\n');
  return Uint8Array.from(Buffer.from(`${head}\r\n\r\n${body}`, 'utf8'));
}

function ingestProcessor(store: ReturnType<typeof createMemoryObjectStore>) {
  return createIngestProcessor({
    database,
    domain,
    store,
    ingestors: {
      gmail: createGmailIngestor({
        ticketKeyPrefix: 'OPS',
        transportFor: (account) => runtime.transportFor(account),
        allowEmbedded: false,
      }),
    },
    realtime: { publish: () => Promise.resolve() },
    logger,
  });
}

async function runIngest(store: ReturnType<typeof createMemoryObjectStore>) {
  const processor = ingestProcessor(store);
  const pending = (await events()).filter((event) => event.status === 'pending');
  for (const event of pending) {
    await processor({
      name: 'process',
      data: { inboundEventId: event.id },
      opts: { attempts: 6 },
      attemptsMade: 0,
    } as unknown as Job);
  }
  return pending.length;
}

async function messagesOf(ticketId: string) {
  return owner()
    .select()
    .from(schema.message)
    .where(eq(schema.message.ticketId, ticketId))
    .orderBy(asc(schema.message.createdAt));
}

describe('sync feeds ingestion', () => {
  it('turns a synced mail with an attachment into a ticket, keeps the raw mail and the file in object storage, and a reply joins the same ticket', async () => {
    const store = createMemoryObjectStore();
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(2048)]);
    const messageId = `${randomUUID()}@customer.example.com`;
    const first = fake.deliver(mailWithAttachment(messageId, pdf), {
      labelIds: ['INBOX', 'UNREAD'],
      threadId: 'thread-report-1',
    });
    const sync = makeSync();
    await sync.syncAccount(accountId, 'push');
    expect(await runIngest(store)).toBe(1);

    const [inbound] = await owner()
      .select()
      .from(schema.inboundMessage)
      .where(eq(schema.inboundMessage.channelAccountId, accountId));
    expect(inbound).toMatchObject({
      providerMessageId: first.id,
      subject: 'รายงานเดือนนี้',
      disposition: 'ticket',
      threadKey: 'gmail:thread-report-1',
    });
    expect(inbound?.bodyText).toContain('รายงานแนบมาด้วยครับ');
    const attachments = inbound?.attachments as {
      objectKey: string | null;
      filename: string;
      size: number;
    }[];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ filename: 'report.pdf', size: pdf.length });
    const stored = store.objects.get(attachments[0]?.objectKey ?? '');
    expect(Buffer.from(stored?.body ?? [])).toEqual(pdf);
    expect(store.objects.get(inbound?.rawObjectKey ?? '')?.contentType).toBe('message/rfc822');

    // The customer answers in the same thread: Gmail threads it, the ingest appends it.
    const reply = gmail.buildFakeMime({
      from: 'somchai@customer.example.com',
      subject: 'Re: รายงานเดือนนี้',
      body: 'ขอบคุณครับ ขอเพิ่มอีกข้อ',
      inReplyTo: messageId,
      references: [messageId],
    });
    fake.deliver(reply.raw, { labelIds: ['INBOX', 'UNREAD'], threadId: 'thread-report-1' });
    expect(await sync.syncAccount(accountId, 'push')).toMatchObject({ queued: 1 });
    expect(await runIngest(store)).toBe(1);
    const dispositions = await owner()
      .select({
        disposition: schema.inboundMessage.disposition,
        ticketId: schema.inboundMessage.ticketId,
      })
      .from(schema.inboundMessage)
      .where(eq(schema.inboundMessage.channelAccountId, accountId));
    expect(dispositions.map((row) => row.disposition).toSorted()).toEqual(['appended', 'ticket']);
    expect(new Set(dispositions.map((row) => row.ticketId)).size).toBe(1);
  });

  it('sends the staff answer in the customer thread through the dispatcher and the mailbox sender', async () => {
    const store = createMemoryObjectStore();
    const messageId = `${randomUUID()}@customer.example.com`;
    const original = gmail.buildFakeMime({
      from: 'somchai@customer.example.com',
      fromName: 'สมชาย',
      subject: 'ขอรีเซ็ตรหัสผ่าน',
      body: 'ลืมรหัสผ่านครับ',
      messageId,
    });
    const delivered = fake.deliver(original.raw, { labelIds: ['INBOX', 'UNREAD'] });
    await makeSync().syncAccount(accountId, 'push');
    await runIngest(store);
    const [inbound] = await owner()
      .select()
      .from(schema.inboundMessage)
      .where(eq(schema.inboundMessage.channelAccountId, accountId));
    const ticketId = inbound?.ticketId ?? '';
    expect(ticketId).not.toBe('');

    const [staffRow] = await owner()
      .insert(schema.users)
      .values({ email: `${randomUUID()}@example.test`, name: 'Staff', role: 'agent' })
      .returning({ id: schema.users.id });
    const staffId = staffRow?.id ?? '';
    const result = await database.db.transaction((tx) =>
      domain.tickets.reply(tx, domain.context({ actor: { type: 'user', id: staffId } }), {
        ref: ticketId,
        reply: { body: 'รีเซ็ตให้แล้วครับ ลองเข้าใหม่อีกครั้ง' },
        sender: { kind: 'staff', userId: staffId },
      }),
    );
    const deliveryId = result.value.delivery?.id ?? '';
    const dispatcher = createOutboundDispatcher({
      database,
      domain,
      channels: { ...NO_CHANNELS, gmail: (account) => runtime.senderFor(account) },
      appHost: HOST,
      realtime: { publish: () => Promise.resolve() },
      logger,
    });
    clock.now = new Date(T0.getTime() + 6000);
    expect(await dispatcher.dispatch(deliveryId)).toEqual({
      status: 'sent',
      route: 'gmail_thread',
    });

    expect(fake.sent).toHaveLength(1);
    const sent = fake.sent[0];
    expect(sent?.threadId).toBe(delivered.threadId);
    const wire = Buffer.from(
      (sent?.raw ?? '').replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    expect(wire).toContain(`In-Reply-To: <${messageId.toLowerCase()}>`);
    expect(wire).toContain(`References: <${messageId.toLowerCase()}>`);
    expect(wire).toContain(`Message-ID: <wt.${deliveryId}@${HOST}>`);
    expect(/^From: .*$/m.exec(wire)?.[0]).toContain((await state()).emailAddress);
    expect(wire).toContain('To: ');
    // Our own sent mail is not re-ingested by the next sync.
    expect(await makeSync().syncAccount(accountId, 'push')).toMatchObject({ queued: 0 });
    const [delivery] = await owner()
      .select()
      .from(schema.outboundDelivery)
      .where(eq(schema.outboundDelivery.id, deliveryId));
    expect(delivery).toMatchObject({
      state: 'sent',
      route: 'gmail_thread',
      providerThreadId: delivered.threadId,
    });
    expect(
      (await messagesOf(ticketId)).some((message) => message.deliveryStatus === 'delivered'),
    ).toBe(true);
  });

  it('fails visibly, not silently, when the account has no mailbox state to send as', async () => {
    const [bare] = await owner()
      .insert(schema.channelAccount)
      .values({ type: 'gmail', name: 'Mailbox without state' })
      .returning({ id: schema.channelAccount.id });
    expect(
      await runtime.senderFor({ id: bare?.id ?? '', type: 'gmail', name: 'x' }),
    ).toBeUndefined();
    // And a mock-mode sender tolerates a thread the sandbox mailbox has never seen (a fake-channel ticket).
    const sender = await runtime.senderFor({ id: accountId, type: 'gmail', name: 'x' });
    const sent = await sender?.send({
      from: sender.from,
      inReplyTo: {
        messageId: null,
        references: [],
        subject: 'Hello',
        from: { address: 'a@customer.example.com', name: null },
        replyTo: [],
      },
      to: [{ address: 'a@customer.example.com', name: null }],
      textBody: 'Hi',
      messageId: 'wt.test@desk.example.test',
      threadId: 'fake-t-unknown',
      subjectMode: 'reuse',
      automatic: false,
    });
    expect(sent?.gmailThreadId).toBe('fake-t-unknown');
    // The placeholder is labelled SENT: the sync never turns it into customer mail.
    expect(await makeSync().syncAccount(accountId, 'push')).toMatchObject({ queued: 0 });
    expect(
      await owner()
        .select({ id: schema.inboundEvent.id })
        .from(schema.inboundEvent)
        .where(and(eq(schema.inboundEvent.channelAccountId, accountId))),
    ).toHaveLength(0);
  });
});

describe('a production worker that is not connected to Gmail', () => {
  async function ticketWithPendingReply() {
    const store = createMemoryObjectStore();
    fake.deliver(
      gmail.buildFakeMime({
        from: 'somchai@customer.example.com',
        subject: 'ขอรีเซ็ตรหัสผ่าน',
        body: 'ลืมรหัสผ่านครับ',
        messageId: `${randomUUID()}@customer.example.com`,
      }).raw,
      { labelIds: ['INBOX', 'UNREAD'] },
    );
    await makeSync().syncAccount(accountId, 'push');
    await runIngest(store);
    const [inbound] = await owner()
      .select()
      .from(schema.inboundMessage)
      .where(eq(schema.inboundMessage.channelAccountId, accountId));
    const ticketId = inbound?.ticketId ?? '';
    const [staffRow] = await owner()
      .insert(schema.users)
      .values({ email: `${randomUUID()}@example.test`, name: 'Staff', role: 'agent' })
      .returning({ id: schema.users.id });
    const staffId = staffRow?.id ?? '';
    const result = await database.db.transaction((tx) =>
      domain.tickets.reply(tx, domain.context({ actor: { type: 'user', id: staffId } }), {
        ref: ticketId,
        reply: { body: 'รีเซ็ตให้แล้วครับ' },
        sender: { kind: 'staff', userId: staffId },
      }),
    );
    return result.value.delivery?.id ?? '';
  }

  it('fails the reply as channel_not_connected instead of "sending" it into a fake mailbox', async () => {
    const deliveryId = await ticketWithPendingReply();
    const production = createGmailRuntime({ database, logger }); // allowMock is off by default
    const dispatcher = createOutboundDispatcher({
      database,
      domain,
      channels: { ...NO_CHANNELS, gmail: (account) => production.senderFor(account) },
      appHost: HOST,
      realtime: { publish: () => Promise.resolve() },
      logger,
    });
    clock.now = new Date(T0.getTime() + 6000);
    expect(await dispatcher.dispatch(deliveryId)).toEqual({
      status: 'failed',
      errorCode: 'channel_not_connected',
      outcomeUnknown: false,
    });
    expect(fake.sent).toHaveLength(0);
    const [delivery] = await owner()
      .select()
      .from(schema.outboundDelivery)
      .where(eq(schema.outboundDelivery.id, deliveryId));
    expect(delivery?.state).not.toBe('sent');
  });

  it('retries the ingest fetch (no permanent failure) while the credential store is unreadable', async () => {
    fake.deliver(
      gmail.buildFakeMime({
        from: 'somchai@customer.example.com',
        subject: 'ทดสอบ',
        body: 'สวัสดี',
      }).raw,
      { labelIds: ['INBOX'] },
    );
    await makeSync().syncAccount(accountId, 'push');
    const unreadable = createGmailRuntime({
      database,
      logger,
      credentials: {
        configured: () => Promise.reject(new Error('database unavailable')),
        read: () => Promise.reject(new Error('unreachable')),
      },
    });
    const processor = createIngestProcessor({
      database,
      domain,
      store: createMemoryObjectStore(),
      ingestors: {
        gmail: createGmailIngestor({
          ticketKeyPrefix: 'OPS',
          transportFor: (account) => unreadable.transportFor(account),
          allowEmbedded: false,
        }),
      },
      realtime: { publish: () => Promise.resolve() },
      logger,
    });
    const [event] = (await events()).filter((row) => row.status === 'pending');
    const job = {
      name: 'process',
      data: { inboundEventId: event?.id },
      opts: { attempts: 6 },
      attemptsMade: 0,
    } as unknown as Job;
    const error = await processor(job).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error).not.toMatchObject({ name: 'UnrecoverableError' });
    // Still pending, not failed: the next attempt (or the store coming back) processes it.
    const [after] = (await events()).filter((row) => row.id === event?.id);
    expect(after?.status).toBe('pending');
  });
});
