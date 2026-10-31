import { gmail, line } from '@watchtower/channels';
import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { INBOUND_QUEUES, INGEST_JOBS, ingestJobSchema } from '@watchtower/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { enqueueFakeInbound, fakePayload } from './fake-channel.js';

// The fake channel writes what a webhook receiver writes. Real Postgres (throwaway database, the
// restricted application role like in compose).
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
let database: Database;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  database = createDatabase({
    url: testDb.appUrl,
    max: 3,
    applicationName: 'wt-fake-channel-test',
  });
});
afterAll(async () => {
  await database.close();
  await testDb.cleanup();
});

describe('enqueueFakeInbound', () => {
  it('writes the event and one ingest outbox job keyed by the event id', async () => {
    const result = await enqueueFakeInbound(database, {
      channel: 'gmail',
      from: 'somchai@customer.example.test',
      subject: 'ระบบเข้าไม่ได้',
      body: 'ช่วยด้วยครับ',
    });
    expect(result.duplicate).toBe(false);
    const [event] = await database.db
      .select()
      .from(schema.inboundEvent)
      .where(eq(schema.inboundEvent.id, result.inboundEventId));
    expect(event).toMatchObject({ status: 'pending', providerEventId: result.providerEventId });
    const [job] = await database.db
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.jobId, result.inboundEventId));
    expect(job).toMatchObject({
      queue: INBOUND_QUEUES.ingest,
      jobName: INGEST_JOBS.process,
      status: 'pending',
    });
    expect(ingestJobSchema.parse(job?.payload)).toEqual({ inboundEventId: result.inboundEventId });
  });

  it('is a no-op for the same provider event id, like a redelivery', async () => {
    const input = {
      channel: 'line',
      userId: 'U-redelivery',
      text: 'hello',
      webhookEventId: 'evt-fixed-1',
    } as const;
    const first = await enqueueFakeInbound(database, input);
    const second = await enqueueFakeInbound(database, input);
    expect(second).toMatchObject({ duplicate: true, inboundEventId: first.inboundEventId });
    const jobs = await database.db
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.jobId, first.inboundEventId));
    expect(jobs).toHaveLength(1);
  });

  it('reuses one fake account per channel', async () => {
    const a = await enqueueFakeInbound(database, {
      channel: 'gmail',
      from: 'a@x.example.test',
      subject: 's',
      body: 'b',
    });
    const b = await enqueueFakeInbound(database, {
      channel: 'gmail',
      from: 'b@x.example.test',
      subject: 's',
      body: 'b',
    });
    expect(a.channelAccountId).toBe(b.channelAccountId);
  });
});

async function adapterRead(raw: unknown) {
  const fake = new gmail.FakeGmailTransport();
  const stored = fake.deliver(Buffer.from(String(raw), 'base64url'), { threadId: 't' });
  const [inbound] = await new gmail.GmailAdapter({ transport: fake }).ingest({
    messageId: stored.id,
  });
  return inbound;
}

describe('fakePayload', () => {
  it('builds a Gmail payload the Gmail adapter understands, with a stable provider id', async () => {
    const { payload, providerEventId } = fakePayload({
      channel: 'gmail',
      from: 'a@customer.example.test',
      subject: 'Hello',
      body: 'World',
      threadId: 'thread-1',
      providerMessageId: 'g-1',
    });
    expect(providerEventId).toBe('g-1');
    expect(payload).toMatchObject({
      id: 'g-1',
      threadId: 'thread-1',
      labelIds: ['INBOX', 'UNREAD'],
    });
    const inbound = await adapterRead(payload.raw);
    expect(inbound?.email.subject).toBe('Hello');
    expect(inbound?.automated.disposition).toBe('human');
  });

  it('marks auto-replies and newsletters so the header rules see them', async () => {
    for (const [kind, expected] of [
      ['auto_reply', 'auto_reply'],
      ['newsletter', 'noise'],
    ] as const) {
      const { payload } = fakePayload({
        channel: 'gmail',
        from: 'a@x.example.test',
        subject: 's',
        body: 'b',
        kind,
      });
      expect((await adapterRead(payload.raw))?.automated.disposition).toBe(expected);
    }
  });

  it('builds a LINE event the LINE normaliser accepts', () => {
    const { payload, providerEventId } = fakePayload({
      channel: 'line',
      userId: 'U9',
      text: 'สวัสดี',
    });
    const event = line.normalizeLineEvent(payload);
    expect(typeof event).not.toBe('string');
    expect(event).toMatchObject({
      kind: 'message',
      providerEventId,
      content: { type: 'text', text: 'สวัสดี' },
      source: { userId: 'U9', conversationId: 'U9' },
    });
  });
});
