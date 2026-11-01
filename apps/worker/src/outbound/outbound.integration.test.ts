import { randomBytes, randomUUID } from 'node:crypto';

import { ChannelError, gmail, line } from '@watchtower/channels';
import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import {
  createDomain,
  createPolicyGate,
  type Domain,
  type NormalisedInboundMessage,
} from '@watchtower/domain';
import { AUDIT_ACTIONS, type RealtimeEvent } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import type { GmailSender, LineSender, OutboundChannels } from './channels.js';
import { NO_CHANNELS } from './channels.js';
import { createOutboundDispatcher, splitLineText, type OutboundDispatcher } from './dispatcher.js';

// The dispatcher against the real database (restricted application role, real policy gate) and the
// in-memory Gmail and LINE. disableNetConnect allows loopback only: the fakes never dial out.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const net = disableNetConnect();

const T0 = new Date('2030-01-07T10:00:00.000Z');
const HOST = 'desk.example.test';
const clock = { now: T0 };
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

let testDb: TestDatabase;
let database: Database;
let domain: Domain;
let dispatcher: OutboundDispatcher;
let gmailId: string;
let lineId: string;
let fakeGmail: gmail.FakeGmailTransport;
let fakeLine: line.FakeLineTransport;
let channels: OutboundChannels;
let events: RealtimeEvent[];

const owner = () => testDb.owner.db;

function makeChannels(): OutboundChannels {
  const adapter = new gmail.GmailAdapter({ transport: fakeGmail });
  const gmailSender: GmailSender = {
    from: { address: 'support@desk.example.test', name: 'Support' },
    send: (input) => adapter.send(input),
  };
  const lineAdapter = new line.LineAdapter({
    transport: fakeLine,
    getChannelSecret: () => Promise.resolve('unused-in-this-test'),
  });
  const lineSender: LineSender = { send: (input) => lineAdapter.send(input) };
  return { gmail: () => gmailSender, line: () => lineSender };
}

function buildDispatcher(
  overrideChannels: OutboundChannels = channels,
  withDomain: Domain = domain,
): OutboundDispatcher {
  return createOutboundDispatcher({
    database,
    domain: withDomain,
    channels: overrideChannels,
    appHost: HOST,
    realtime: {
      publish: (event) => {
        events.push(event);
        return Promise.resolve();
      },
    },
    logger: createLogger(testConfig()),
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  database = createDatabase({ url: testDb.appUrl, max: 8, applicationName: 'wt-outbound-test' });
  domain = createDomain({
    ticketKeyPrefix: 'OPS',
    sealKey: randomBytes(32),
    portalUrl: 'https://desk.example.test/portal',
    policyGate: createPolicyGate({ db: database.db }),
    now: () => clock.now,
  });
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
  // A fresh mailbox and LINE account per case: the fakes number their messages from 1 and the
  // quota counter belongs to the account, so cases must not share either.
  const accounts = await owner()
    .insert(schema.channelAccount)
    .values([
      { type: 'gmail', name: 'Support mailbox' },
      { type: 'line', name: 'Support LINE OA' },
    ])
    .returning();
  gmailId = accounts.find((account) => account.type === 'gmail')?.id ?? '';
  lineId = accounts.find((account) => account.type === 'line')?.id ?? '';
  clock.now = T0;
  events = [];
  fakeGmail = new gmail.FakeGmailTransport({ now: () => clock.now });
  fakeLine = new line.FakeLineTransport({ now: () => clock.now });
  channels = makeChannels();
  dispatcher = buildDispatcher();
});

const system = () => domain.context({ actor: { type: 'system', id: null } });

async function addStaff(role: 'agent' | 'lead' = 'agent') {
  const [row] = await owner()
    .insert(schema.users)
    .values({ email: `${randomUUID()}@example.test`, name: 'Staff', role })
    .returning({ id: schema.users.id });
  const id = row?.id ?? '';
  return { id, actor: { type: 'user', id } as const };
}

async function addIntent(stage = 2) {
  const [row] = await owner()
    .insert(schema.intent)
    .values({
      key: `intent_${randomUUID().slice(0, 8).replace(/-/g, '')}`,
      name: 'An intent',
      autonomyStage: stage,
    })
    .returning();
  return row?.id ?? '';
}

function mail(extra: Partial<NormalisedInboundMessage> = {}): NormalisedInboundMessage {
  const threadId = `thread-${randomUUID()}`;
  return {
    channelAccountId: gmailId,
    providerMessageId: `g-${randomUUID()}`,
    rfc822MessageId: `${randomUUID()}@customer.example.test`,
    threadKey: `gmail:${threadId}`,
    threadCandidates: [{ kind: 'gmail_thread_id', value: threadId }],
    from: {
      address: `${randomUUID().slice(0, 8)}@customer.example.test`,
      name: 'Customer',
      lineUserId: null,
    },
    subject: 'Cannot sign in',
    bodyText: 'Password rejected',
    bodyHtml: null,
    attachments: [],
    receivedAt: clock.now,
    rawObjectKey: null,
    automated: { disposition: 'human', subtype: 'none', signals: [] },
    ...extra,
  };
}

async function ingest(message: NormalisedInboundMessage): Promise<string> {
  const result = await database.db.transaction((tx) =>
    domain.inbound.ingest(tx, system(), { message }),
  );
  const ticketId = result.value.ticketId;
  if (ticketId === null) throw new Error('no ticket');
  return ticketId;
}

/** A customer mail the fake mailbox also holds, so the reply can join its thread. */
async function gmailTicket(): Promise<{ ticketId: string; threadId: string; messageId: string }> {
  const threadId = `thread-${randomUUID()}`;
  const messageId = `${randomUUID()}@customer.example.test`;
  const fromAddress = `${randomUUID().slice(0, 8)}@customer.example.test`;
  const raw = gmail.buildFakeMime({
    from: fromAddress,
    fromName: 'Customer',
    to: 'support@desk.example.test',
    subject: 'Cannot sign in',
    body: 'Password rejected',
    messageId,
  });
  fakeGmail.deliver(raw.raw, { threadId });
  const ticketId = await ingest(
    mail({
      rfc822MessageId: messageId,
      threadKey: `gmail:${threadId}`,
      threadCandidates: [{ kind: 'gmail_thread_id', value: threadId }],
      from: { address: fromAddress, name: 'Customer', lineUserId: null },
    }),
  );
  return { ticketId, threadId, messageId };
}

async function lineTicket(
  options: { token?: string | null; receivedAt?: Date; user?: string } = {},
) {
  const user = options.user ?? `U${randomUUID().replace(/-/g, '')}`;
  const token = options.token === undefined ? fakeLine.issueReplyToken() : options.token;
  const ticketId = await ingest({
    channelAccountId: lineId,
    providerMessageId: `l-${randomUUID()}`,
    rfc822MessageId: null,
    threadKey: `line:${user}`,
    threadCandidates: [{ kind: 'line_conversation', value: user }],
    from: { address: null, name: null, lineUserId: user },
    subject: '',
    bodyText: 'Help please',
    bodyHtml: null,
    attachments: [],
    receivedAt: options.receivedAt ?? clock.now,
    rawObjectKey: null,
    automated: { disposition: 'human', subtype: 'none', signals: [] },
    replyToken: token,
  });
  return { ticketId, user, token };
}

async function staffReply(ticketId: string, body: string, aiDraftId?: string) {
  const staff = await addStaff();
  const result = await database.db.transaction((tx) =>
    domain.tickets.reply(tx, domain.context({ actor: staff.actor }), {
      ref: ticketId,
      reply: { body, ...(aiDraftId === undefined ? {} : { aiDraftId }) },
      sender: { kind: 'staff', userId: staff.id },
    }),
  );
  const delivery = result.value.delivery;
  if (delivery === null || delivery === undefined) throw new Error('no delivery');
  return { staff, delivery, message: result.value.message };
}

async function deliveryRow(id: string) {
  const [row] = await owner()
    .select()
    .from(schema.outboundDelivery)
    .where(eq(schema.outboundDelivery.id, id));
  if (row === undefined) throw new Error('no delivery');
  return row;
}
async function messageRow(id: string) {
  const [row] = await owner().select().from(schema.message).where(eq(schema.message.id, id));
  if (row === undefined) throw new Error('no message');
  return row;
}
async function quotaUsed(): Promise<number> {
  const rows = await owner()
    .select()
    .from(schema.channelQuotaUsage)
    .where(eq(schema.channelQuotaUsage.channelAccountId, lineId));
  return rows.reduce((sum, row) => sum + row.used, 0);
}
const timeout = (provider: 'gmail' | 'line', operation: string) =>
  new ChannelError({ provider, operation, kind: 'timeout' });

describe('Gmail', () => {
  it('sends an in-thread reply once the hold ends, and records everything T-122c needs to match the answer', async () => {
    const { ticketId, threadId, messageId } = await gmailTicket();
    const { delivery, message } = await staffReply(ticketId, 'We are on it.');

    // Before the window ends the trigger sends nothing and has to come back.
    clock.now = at(2);
    expect(await dispatcher.dispatch(delivery.id)).toMatchObject({ status: 'early' });
    expect(fakeGmail.sent).toHaveLength(0);

    clock.now = at(6);
    expect(await dispatcher.dispatch(delivery.id)).toEqual({
      status: 'sent',
      route: 'gmail_thread',
    });
    expect(fakeGmail.sent).toHaveLength(1);
    const wire = Buffer.from(
      (fakeGmail.sent[0]?.raw ?? '').replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    expect(wire).toContain(`In-Reply-To: <${messageId.toLowerCase()}>`);
    expect(wire).toContain(`Message-ID: <wt.${delivery.id}@${HOST}>`);
    expect(wire).toMatch(/Subject: Re: Cannot sign in \[OPS-\d+\]/);
    expect(wire).not.toContain('Auto-Submitted');
    expect(fakeGmail.sent[0]?.threadId).toBe(threadId);

    const row = await deliveryRow(delivery.id);
    expect(row).toMatchObject({
      state: 'sent',
      route: 'gmail_thread',
      attempts: 1,
      rfc822MessageId: `wt.${delivery.id}@${HOST}`,
      providerThreadId: threadId,
      sentAt: at(6),
    });
    expect(row.providerMessageId).toBe(fakeGmail.sent[0]?.id);
    expect(await messageRow(message.id)).toMatchObject({
      deliveryStatus: 'delivered',
      externalId: row.providerMessageId,
    });
    // The first response is counted at the send, not at the click.
    const [ticket] = await owner()
      .select()
      .from(schema.ticket)
      .where(eq(schema.ticket.id, ticketId));
    expect(ticket?.firstRespondedAt).toEqual(at(6));
    expect(events.map((event) => event.type)).toContain('message.created');
    const audit = await owner()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, AUDIT_ACTIONS.outboundSent));
    expect(JSON.stringify(audit)).not.toContain('We are on it');
  });

  it('is at-most-once: many triggers at the same moment send one mail', async () => {
    const { ticketId } = await gmailTicket();
    const { delivery } = await staffReply(ticketId, 'Only once please');
    clock.now = at(6);
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => buildDispatcher().dispatch(delivery.id)),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'sent')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'skipped')).toHaveLength(9);
    expect(fakeGmail.sent).toHaveLength(1);
    // Later duplicates (the outbox is at-least-once) do nothing either.
    expect(await dispatcher.dispatch(delivery.id)).toEqual({ status: 'skipped' });
    expect(fakeGmail.sent).toHaveLength(1);
  });

  it('does not send what was undone', async () => {
    const { ticketId } = await gmailTicket();
    const { delivery, staff } = await staffReply(ticketId, 'Never mind');
    clock.now = at(3);
    await database.db.transaction((tx) =>
      domain.outbound.cancel(tx, domain.context({ actor: staff.actor }), {
        ref: ticketId,
        deliveryId: delivery.id,
        canCancelAny: false,
      }),
    );
    clock.now = at(10);
    expect(await dispatcher.dispatch(delivery.id)).toEqual({ status: 'skipped' });
    expect(fakeGmail.sent).toHaveLength(0);
    expect(fakeGmail.calls.filter((call) => call.op === 'sendMessage')).toHaveLength(0);
  });

  it('never repeats a send whose outcome is unknown: Gmail has no idempotency key', async () => {
    const { ticketId } = await gmailTicket();
    const { delivery, message } = await staffReply(ticketId, 'Did it go out?');
    clock.now = at(6);
    fakeGmail.failNext('users.messages.send', timeout('gmail', 'users.messages.send'));
    expect(await dispatcher.dispatch(delivery.id)).toEqual({
      status: 'failed',
      errorCode: 'channel_timeout',
      outcomeUnknown: true,
    });
    expect(await deliveryRow(delivery.id)).toMatchObject({ state: 'failed', outcomeUnknown: true });
    expect((await messageRow(message.id)).deliveryStatus).toBe('failed');
    clock.now = at(600);
    expect(await dispatcher.dispatch(delivery.id)).toEqual({ status: 'skipped' });
    expect(fakeGmail.calls.filter((call) => call.op === 'sendMessage')).toHaveLength(1);
  });

  it('retries a certain non-delivery (429) later, then sends', async () => {
    const { ticketId } = await gmailTicket();
    const { delivery } = await staffReply(ticketId, 'Rate limited once');
    clock.now = at(6);
    fakeGmail.failNext(
      'users.messages.send',
      new ChannelError({
        provider: 'gmail',
        operation: 'users.messages.send',
        kind: 'rate_limited',
        status: 429,
        retryAfterMs: 30_000,
      }),
    );
    expect((await dispatcher.dispatch(delivery.id)).status).toBe('retry');
    const waiting = await deliveryRow(delivery.id);
    expect(waiting.state).toBe('scheduled');
    expect(waiting.nextAttemptAt).toEqual(at(36));
    expect(await dispatcher.dispatch(delivery.id)).toMatchObject({ status: 'early' });
    clock.now = at(37);
    expect(await dispatcher.dispatch(delivery.id)).toEqual({
      status: 'sent',
      route: 'gmail_thread',
    });
    expect((await deliveryRow(delivery.id)).attempts).toBe(2);
    expect(fakeGmail.sent).toHaveLength(1);
  });

  it('fails a refused request at once and tells the staff', async () => {
    const { ticketId } = await gmailTicket();
    const { delivery, message } = await staffReply(ticketId, 'Refused');
    clock.now = at(6);
    fakeGmail.failNext(
      'users.messages.send',
      new ChannelError({
        provider: 'gmail',
        operation: 'users.messages.send',
        kind: 'auth',
        status: 401,
      }),
    );
    expect(await dispatcher.dispatch(delivery.id)).toEqual({
      status: 'failed',
      errorCode: 'channel_auth',
      outcomeUnknown: false,
    });
    expect((await messageRow(message.id)).deliveryStatus).toBe('failed');
    const events$ = await owner()
      .select()
      .from(schema.ticketEvent)
      .where(eq(schema.ticketEvent.ticketId, ticketId));
    expect(events$.some((event) => event.type === 'message.delivery_failed')).toBe(true);
  });

  it('fails visibly when the account has no credentials, and sends nothing', async () => {
    const { ticketId } = await gmailTicket();
    const { delivery } = await staffReply(ticketId, 'No transport');
    clock.now = at(6);
    const bare = buildDispatcher(NO_CHANNELS);
    expect(await bare.dispatch(delivery.id)).toEqual({
      status: 'failed',
      errorCode: 'channel_not_connected',
      outcomeUnknown: false,
    });
    expect(fakeGmail.sent).toHaveLength(0);
  });

  it('refuses at claim time when the text changed or the gate says no, and sends nothing', async () => {
    const tampered = await gmailTicket();
    const a = await staffReply(tampered.ticketId, 'As approved');
    await owner().execute(
      `UPDATE message SET body_text = 'Rewritten' WHERE id = '${a.message.id}'`,
    );
    clock.now = at(6);
    expect(await dispatcher.dispatch(a.delivery.id)).toEqual({
      status: 'denied',
      reason: 'content_changed',
    });
    expect(await deliveryRow(a.delivery.id)).toMatchObject({
      state: 'cancelled',
      errorCode: 'policy_denied',
    });

    // An AI draft sent by a person, then the intent is pulled to stage 0 during the hold (N3).
    clock.now = T0;
    const intentId = await addIntent(2);
    const { ticketId } = await gmailTicket();
    await owner().update(schema.ticket).set({ intentId }).where(eq(schema.ticket.id, ticketId));
    const [draft] = await owner()
      .insert(schema.aiDraft)
      .values({ ticketId, bodyText: 'Draft by the AI' })
      .returning();
    const b = await staffReply(ticketId, 'Draft by the AI', draft?.id);
    expect(b.delivery.origin).toBe('ai_approved');
    await owner()
      .update(schema.intent)
      .set({ autonomyStage: 0 })
      .where(eq(schema.intent.id, intentId));
    clock.now = at(6);
    expect(await dispatcher.dispatch(b.delivery.id)).toEqual({
      status: 'denied',
      reason: 'stage_0_no_customer_draft',
    });
    expect(fakeGmail.sent).toHaveLength(0);
    const denied = await owner()
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, AUDIT_ACTIONS.outboundPolicyDenied),
          eq(schema.auditLog.targetId, b.delivery.id),
        ),
      );
    expect(denied).toHaveLength(1);
  });

  it('a delivery whose worker died before calling Gmail is released and then sent; one that died after is failed, not repeated', async () => {
    const { ticketId } = await gmailTicket();
    const { delivery } = await staffReply(ticketId, 'Crash before');
    clock.now = at(6);
    // The worker claimed it and died before the provider call.
    await database.db.transaction((tx) => domain.outbound.claim(tx, system(), delivery.id));
    expect(await dispatcher.dispatch(delivery.id)).toEqual({ status: 'skipped' });
    clock.now = at(6 + 130);
    const swept = await dispatcher.sweep();
    expect(swept.released).toBe(1);
    expect(await dispatcher.dispatch(delivery.id)).toEqual({
      status: 'sent',
      route: 'gmail_thread',
    });

    const second = await gmailTicket();
    const after = await staffReply(second.ticketId, 'Crash after');
    clock.now = at(300);
    await database.db.transaction(async (tx) => {
      const claimed = await domain.outbound.claim(tx, system(), after.delivery.id);
      if (claimed === null) throw new Error('not claimed');
      await domain.outbound.markDispatched(tx, system(), claimed, 'gmail_thread');
    });
    clock.now = at(300 + 130);
    const second$ = await dispatcher.sweep();
    expect(second$.unknownOutcome).toBe(1);
    expect(await deliveryRow(after.delivery.id)).toMatchObject({
      state: 'failed',
      outcomeUnknown: true,
    });
    expect(fakeGmail.sent).toHaveLength(1);
  });
});

describe('LINE: reply token or push', () => {
  it('answers with the free reply token while it is fresh, and spends it once', async () => {
    const { ticketId, token } = await lineTicket();
    const { delivery, message } = await staffReply(ticketId, 'We got it');
    clock.now = at(6);
    expect(await dispatcher.dispatch(delivery.id)).toEqual({ status: 'sent', route: 'line_reply' });
    expect(fakeLine.replies).toHaveLength(1);
    expect(fakeLine.replies[0]?.replyToken).toBe(token);
    expect(fakeLine.pushes).toHaveLength(0);
    expect(await quotaUsed()).toBe(0);
    expect((await messageRow(message.id)).deliveryStatus).toBe('delivered');

    // The token is gone: the next reply on the same conversation pushes.
    const next = await staffReply(ticketId, 'And a second thing');
    clock.now = at(20);
    expect(await dispatcher.dispatch(next.delivery.id)).toEqual({
      status: 'sent',
      route: 'line_push',
    });
    expect(fakeLine.pushes).toHaveLength(1);
    expect(fakeLine.pushes[0]?.retryKey).toBe(next.delivery.id);
    expect(await quotaUsed()).toBe(1);
  });

  it('pushes when the token is too old, and keeps no token in the row afterwards', async () => {
    const { ticketId, user } = await lineTicket({ receivedAt: new Date(T0.getTime() - 55_000) });
    const { delivery } = await staffReply(ticketId, 'Late');
    clock.now = at(6);
    expect(await dispatcher.dispatch(delivery.id)).toEqual({ status: 'sent', route: 'line_push' });
    expect(fakeLine.replies).toHaveLength(0);
    expect(fakeLine.pushes[0]).toMatchObject({ to: user, texts: ['Late'] });
    expect(await quotaUsed()).toBe(1);
  });

  it('falls back to a push in the same attempt when the provider rejects the token', async () => {
    const { ticketId } = await lineTicket({ token: 'a-token-line-never-issued' });
    const { delivery } = await staffReply(ticketId, 'Token was bad');
    clock.now = at(6);
    expect(await dispatcher.dispatch(delivery.id)).toEqual({ status: 'sent', route: 'line_push' });
    expect(fakeLine.pushes).toHaveLength(1);
    expect(await quotaUsed()).toBe(1);
  });

  it('uses the delivery id as the retry key: a push LINE already accepted is recorded, not sent twice', async () => {
    const { ticketId, user } = await lineTicket({ token: null });
    const { delivery } = await staffReply(ticketId, 'Retry-safe');
    clock.now = at(6);
    // The first attempt reached LINE but the answer was lost; the repeat carries the same key.
    await fakeLine.push({
      to: user,
      messages: [{ type: 'text', text: 'Retry-safe' }],
      retryKey: delivery.id,
    });
    expect(await dispatcher.dispatch(delivery.id)).toEqual({ status: 'sent', route: 'line_push' });
    expect(fakeLine.pushes).toHaveLength(1);
    expect(await deliveryRow(delivery.id)).toMatchObject({ state: 'sent' });
  });

  it('retries a push of unknown outcome automatically (the retry key makes it safe) and gives the reservation back', async () => {
    const { ticketId } = await lineTicket({ token: null });
    const { delivery } = await staffReply(ticketId, 'Timeout then fine');
    clock.now = at(6);
    fakeLine.failNext('message.push', timeout('line', 'message.push'));
    expect((await dispatcher.dispatch(delivery.id)).status).toBe('retry');
    expect(await quotaUsed()).toBe(0);
    clock.now = at(20);
    expect(await dispatcher.dispatch(delivery.id)).toEqual({ status: 'sent', route: 'line_push' });
    expect(await quotaUsed()).toBe(1);
    expect(fakeLine.pushes).toHaveLength(1);
  });

  it('never repeats a reply of unknown outcome', async () => {
    const { ticketId } = await lineTicket();
    const { delivery } = await staffReply(ticketId, 'Reply timeout');
    clock.now = at(6);
    fakeLine.failNext('message.reply', timeout('line', 'message.reply'));
    expect(await dispatcher.dispatch(delivery.id)).toEqual({
      status: 'failed',
      errorCode: 'channel_timeout',
      outcomeUnknown: true,
    });
    clock.now = at(60);
    expect(await dispatcher.dispatch(delivery.id)).toEqual({ status: 'skipped' });
    expect(fakeLine.replies).toHaveLength(0);
    expect(fakeLine.pushes).toHaveLength(0);
  });

  it("when the quota is used up a person's reply fails with quota_exhausted and the audit suggests email", async () => {
    const { ticketId } = await lineTicket({ token: null });
    await owner().execute(
      `INSERT INTO channel_quota_usage (channel_account_id, period, used, quota_limit)
       VALUES ('${lineId}', '${line.quotaPeriod(at(6))}', 300, 300)
       ON CONFLICT (channel_account_id, period) DO UPDATE SET used = 300, quota_limit = 300`,
    );
    const { delivery, message } = await staffReply(ticketId, 'No quota left');
    clock.now = at(6);
    expect(await dispatcher.dispatch(delivery.id)).toEqual({
      status: 'failed',
      errorCode: 'quota_exhausted',
      outcomeUnknown: false,
    });
    expect(fakeLine.pushes).toHaveLength(0);
    expect((await messageRow(message.id)).deliveryStatus).toBe('failed');
    const audit = await owner()
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, AUDIT_ACTIONS.outboundFailed),
          eq(schema.auditLog.targetId, delivery.id),
        ),
      );
    expect((audit[0]?.metadata as { reason?: string }).reason).toBe('suggest_email');
    expect(await quotaUsed()).toBe(300);
  });

  it('treats the provider monthly limit (429) as a wall, not a delay', async () => {
    const { ticketId } = await lineTicket({ token: null });
    const { delivery } = await staffReply(ticketId, 'Provider says no');
    clock.now = at(6);
    fakeLine.failNext(
      'message.push',
      new ChannelError({
        provider: 'line',
        operation: 'message.push',
        kind: 'rate_limited',
        status: 429,
        code: 'monthly_limit',
      }),
    );
    expect((await dispatcher.dispatch(delivery.id)).status).toBe('failed');
    expect(await deliveryRow(delivery.id)).toMatchObject({
      state: 'failed',
      errorCode: 'quota_exhausted',
    });
    expect(await quotaUsed()).toBe(0);
  });

  it('splits a long text into LINE messages of at most 5,000 characters', async () => {
    const { ticketId } = await lineTicket({ token: null });
    const long = `${'ก'.repeat(5000)}${'b'.repeat(1200)}`;
    const { delivery } = await staffReply(ticketId, long);
    clock.now = at(6);
    expect((await dispatcher.dispatch(delivery.id)).status).toBe('sent');
    expect(fakeLine.pushes[0]?.texts.map((text) => text.length)).toEqual([5000, 1200]);
    expect(splitLineText('x'.repeat(10_001))).toHaveLength(3);
    expect(splitLineText('😀'.repeat(2500)).map((part) => part.length)).toEqual([5000]);
    expect(splitLineText('😀'.repeat(2501)).map((part) => part.length)).toEqual([5000, 2]);
  });

  it('an automatic acknowledgment is never pushed: no valid token means it fails and the quota is untouched', async () => {
    const { ticketId } = await lineTicket({ token: null });
    const ack = await database.db.transaction((tx) =>
      domain.outbound.scheduleTemplateAck(tx, system(), {
        ref: ticketId,
        templateKey: 'auto_ack.received',
      }),
    );
    expect(ack.value.delivery.holdSeconds).toBe(0);
    expect(await dispatcher.dispatch(ack.value.delivery.id)).toEqual({
      status: 'failed',
      errorCode: 'reply_token_unavailable',
      outcomeUnknown: false,
    });
    expect(fakeLine.pushes).toHaveLength(0);
    expect(await quotaUsed()).toBe(0);
  });

  it('an automatic acknowledgment goes out at once with the reply token (no hold, AC-2)', async () => {
    const { ticketId, token } = await lineTicket();
    const ack = await database.db.transaction((tx) =>
      domain.outbound.scheduleTemplateAck(tx, system(), {
        ref: ticketId,
        templateKey: 'auto_ack.received',
      }),
    );
    clock.now = at(1);
    expect(await dispatcher.dispatch(ack.value.delivery.id)).toEqual({
      status: 'sent',
      route: 'line_reply',
    });
    expect(fakeLine.replies[0]?.replyToken).toBe(token);
    expect(fakeLine.replies[0]?.texts[0]).toContain('OPS-');
    // An acknowledgment is not a first response (SLA).
    const [ticket] = await owner()
      .select()
      .from(schema.ticket)
      .where(eq(schema.ticket.id, ticketId));
    expect(ticket?.firstRespondedAt).toBeNull();
  });
});

describe('what the logs and audit rows hold', () => {
  it('never a body, a reply token or a header', async () => {
    const { ticketId, token } = await lineTicket();
    const { delivery } = await staffReply(ticketId, 'Secret customer words 0812345678');
    clock.now = at(6);
    await dispatcher.dispatch(delivery.id);
    const rows = await owner().select().from(schema.auditLog);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('Secret customer words');
    expect(dump).not.toContain(token ?? 'no-token');
    const events$ = await owner()
      .select()
      .from(schema.ticketEvent)
      .where(eq(schema.ticketEvent.ticketId, ticketId));
    expect(JSON.stringify(events$)).not.toContain('Secret customer words');
    const outbox = await owner().select().from(schema.outbox);
    expect(JSON.stringify(outbox)).not.toContain('Secret customer words');
  });
});

describe('claim fencing (review O-1)', () => {
  it('a worker that stalled past its lease and was replaced never calls the provider', async () => {
    const { ticketId } = await gmailTicket();
    const { delivery } = await staffReply(ticketId, 'Only one of us sends');
    clock.now = at(6);

    // Worker A claims, then stalls inside the policy gate.
    let release: () => void = () => undefined;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realGate = createPolicyGate({ db: database.db });
    const slowDomain = createDomain({
      ticketKeyPrefix: 'OPS',
      sealKey: randomBytes(32),
      policyGate: {
        check: async (request) => {
          await stalled;
          return realGate.check(request);
        },
        checkAiAction: (request) => realGate.checkAiAction(request),
      },
      now: () => clock.now,
    });
    const workerA = buildDispatcher(channels, slowDomain).dispatch(delivery.id);
    await vi.waitFor(async () => {
      expect((await deliveryRow(delivery.id)).state).toBe('sending');
    });

    // The lease runs out, the sweeper releases the row, and worker B sends.
    clock.now = at(6 + 130);
    expect((await dispatcher.sweep()).released).toBe(1);
    expect(await dispatcher.dispatch(delivery.id)).toEqual({
      status: 'sent',
      route: 'gmail_thread',
    });
    expect(fakeGmail.sent).toHaveLength(1);

    // A wakes up. It no longer owns the row: it must not dispatch, and it does not.
    release();
    expect(await workerA).toEqual({ status: 'lost' });
    expect(fakeGmail.calls.filter((call) => call.op === 'sendMessage')).toHaveLength(1);
    expect(await deliveryRow(delivery.id)).toMatchObject({ state: 'sent', attempts: 2 });
  });

  it('the same for LINE: a replaced worker neither replies nor pushes, and keeps the reply token it never took', async () => {
    const { ticketId } = await lineTicket();
    const { delivery } = await staffReply(ticketId, 'Fenced LINE');
    clock.now = at(6);
    let release: () => void = () => undefined;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realGate = createPolicyGate({ db: database.db });
    const slowDomain = createDomain({
      ticketKeyPrefix: 'OPS',
      sealKey: randomBytes(32),
      policyGate: {
        check: async (request) => {
          await stalled;
          return realGate.check(request);
        },
        checkAiAction: (request) => realGate.checkAiAction(request),
      },
      now: () => clock.now,
    });
    const workerA = buildDispatcher(channels, slowDomain).dispatch(delivery.id);
    await vi.waitFor(async () => {
      expect((await deliveryRow(delivery.id)).state).toBe('sending');
    });
    clock.now = at(6 + 130);
    await dispatcher.sweep();
    // B pushes: the token is older than the router allows by now.
    expect(await dispatcher.dispatch(delivery.id)).toEqual({ status: 'sent', route: 'line_push' });
    release();
    expect(await workerA).toEqual({ status: 'lost' });
    expect(fakeLine.replies).toHaveLength(0);
    expect(fakeLine.pushes).toHaveLength(1);
    expect(await quotaUsed()).toBe(1);
  });
});

describe('a LINE push is pinned to push (review O-2)', () => {
  it('does not turn into a reply when a fresh reply token arrives after an unknown outcome', async () => {
    const { ticketId, user } = await lineTicket({ token: null });
    const { delivery } = await staffReply(ticketId, 'Push, then maybe');
    clock.now = at(6);
    fakeLine.failNext('message.push', timeout('line', 'message.push'));
    expect((await dispatcher.dispatch(delivery.id)).status).toBe('retry');
    expect((await deliveryRow(delivery.id)).route).toBe('line_push');

    // The customer writes again; the new message carries a fresh, valid reply token.
    clock.now = at(10);
    await lineTicket({ user, token: fakeLine.issueReplyToken() });
    clock.now = at(20);
    expect(await dispatcher.dispatch(delivery.id)).toEqual({ status: 'sent', route: 'line_push' });
    expect(fakeLine.replies).toHaveLength(0);
    expect(fakeLine.pushes).toHaveLength(1);
    expect(fakeLine.pushes[0]?.retryKey).toBe(delivery.id);
    // The token was not spent: it is still there for the next, different message.
    const next = await staffReply(ticketId, 'A different message');
    clock.now = at(25);
    expect(await dispatcher.dispatch(next.delivery.id)).toEqual({
      status: 'sent',
      route: 'line_reply',
    });
  });
});

describe('a pinned push that cannot be repeated may already have reached the customer (N-5)', () => {
  /** A push whose first attempt timed out: scheduled again, pinned to line_push, retry key = delivery id. */
  async function timedOutPush(text: string) {
    const { ticketId } = await lineTicket({ token: null });
    const { delivery, message } = await staffReply(ticketId, text);
    clock.now = at(6);
    fakeLine.failNext('message.push', timeout('line', 'message.push'));
    expect((await dispatcher.dispatch(delivery.id)).status).toBe('retry');
    expect((await deliveryRow(delivery.id)).route).toBe('line_push');
    return { ticketId, delivery, message };
  }

  it('records outcomeUnknown when the later attempt finds the monthly quota used up', async () => {
    const { delivery, message } = await timedOutPush('Maybe sent');
    await owner().execute(
      `INSERT INTO channel_quota_usage (channel_account_id, period, used, quota_limit)
       VALUES ('${lineId}', '${line.quotaPeriod(at(20))}', 300, 300)
       ON CONFLICT (channel_account_id, period) DO UPDATE SET used = 300, quota_limit = 300`,
    );
    clock.now = at(20);
    expect(await dispatcher.dispatch(delivery.id)).toEqual({
      status: 'failed',
      errorCode: 'quota_exhausted',
      outcomeUnknown: true,
    });
    expect(await deliveryRow(delivery.id)).toMatchObject({
      state: 'failed',
      outcomeUnknown: true,
    });
    expect(fakeLine.pushes).toHaveLength(0);
    expect((await messageRow(message.id)).deliveryStatus).toBe('failed');
    // The audit row and the timeline event carry the flag staff see before they retry.
    const audit = await owner()
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, AUDIT_ACTIONS.outboundFailed),
          eq(schema.auditLog.targetId, delivery.id),
        ),
      );
    expect((audit[0]?.metadata as { outcomeUnknown?: boolean }).outcomeUnknown).toBe(true);
  });

  it('records outcomeUnknown when the channel is no longer connected', async () => {
    const { delivery } = await timedOutPush('Maybe sent too');
    clock.now = at(20);
    expect(await buildDispatcher(NO_CHANNELS).dispatch(delivery.id)).toEqual({
      status: 'failed',
      errorCode: 'channel_not_connected',
      outcomeUnknown: true,
    });
  });

  it('records outcomeUnknown when the retry key may have expired, and sends nothing', async () => {
    const { delivery } = await timedOutPush('Too old to repeat');
    clock.now = at(21 * 3600);
    expect(await dispatcher.dispatch(delivery.id)).toEqual({
      status: 'failed',
      errorCode: 'retry_key_expired',
      outcomeUnknown: true,
    });
    expect(fakeLine.pushes).toHaveLength(0);
    expect(await quotaUsed()).toBe(0);
  });

  it('still says a first-attempt refusal is a certain non-delivery', async () => {
    const { ticketId } = await lineTicket({ token: null });
    const { delivery } = await staffReply(ticketId, 'Never pushed');
    clock.now = at(6);
    expect(await buildDispatcher(NO_CHANNELS).dispatch(delivery.id)).toEqual({
      status: 'failed',
      errorCode: 'channel_not_connected',
      outcomeUnknown: false,
    });
  });
});
