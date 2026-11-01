import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  INBOUND_TICKET_EVENTS,
  type InboundClassification,
} from '@watchtower/shared';
import { eq, notInArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Actor } from '../types.js';
import {
  addIntent,
  addOrg,
  addPolicy,
  auditRows,
  eventTypes,
  markMerged,
  startDomainTest,
  type DomainTestEnv,
} from '../testing/support.js';
import { UNIDENTIFIED_ORG_ID } from './identity.js';
import type { NormalisedInboundMessage, ThreadCandidate } from './types.js';

const SYSTEM: Actor = { type: 'system', id: null };

let env: DomainTestEnv;
let gmailId: string;
let lineId: string;
const clock = new Date('2026-11-02T03:00:00Z');

beforeAll(async () => {
  env = await startDomainTest({ now: () => clock });
  await addPolicy(
    env,
    { P3: { first_response_min: 60, resolution_min: 240, calendar: '24x7' } },
    'standard',
  );
  const accounts = await env.db.owner.db
    .insert(schema.channelAccount)
    .values([
      { type: 'gmail', name: 'Support mailbox' },
      { type: 'line', name: 'Support LINE OA' },
    ])
    .returning();
  gmailId = accounts.find((account) => account.type === 'gmail')?.id ?? '';
  lineId = accounts.find((account) => account.type === 'line')?.id ?? '';
});
afterAll(async () => {
  await env.close();
});

const ctx = () => env.ctx(SYSTEM);

interface MailOptions {
  readonly from?: string;
  readonly name?: string | null;
  readonly subject?: string;
  readonly body?: string;
  readonly providerId?: string;
  readonly messageId?: string | null;
  readonly threadId?: string | null;
  readonly inReplyTo?: string | null;
  readonly references?: readonly string[];
  readonly subjectToken?: string;
  readonly automated?: NormalisedInboundMessage['automated'];
  readonly html?: string | null;
}

/** What `GmailAdapter` + the worker's mapper produce for a mail, written out by hand. */
function mail(options: MailOptions = {}): NormalisedInboundMessage {
  const threadId = options.threadId === undefined ? `t-${randomUUID()}` : options.threadId;
  const candidates: ThreadCandidate[] = [];
  if (threadId !== null) candidates.push({ kind: 'gmail_thread_id', value: threadId });
  if (options.inReplyTo != null) candidates.push({ kind: 'in_reply_to', value: options.inReplyTo });
  for (const reference of [...(options.references ?? [])].reverse()) {
    candidates.push({ kind: 'references', value: reference });
  }
  if (options.subjectToken !== undefined) {
    candidates.push({ kind: 'subject_token', value: options.subjectToken });
  }
  const messageId =
    options.messageId === undefined ? `${randomUUID()}@mail.example.test` : options.messageId;
  return {
    channelAccountId: gmailId,
    providerMessageId: options.providerId ?? `g-${randomUUID()}`,
    rfc822MessageId: messageId,
    threadKey: threadId === null ? null : `gmail:${threadId}`,
    threadCandidates: candidates,
    from: {
      address: options.from ?? `person-${randomUUID().slice(0, 8)}@unknown.example.test`,
      name: options.name === undefined ? 'Some Person' : options.name,
      lineUserId: null,
    },
    subject: options.subject ?? 'Cannot sign in',
    bodyText: options.body ?? 'Password rejected',
    bodyHtml: options.html ?? null,
    attachments: [],
    receivedAt: new Date(clock),
    rawObjectKey: null,
    automated: options.automated ?? { disposition: 'human', subtype: 'none', signals: [] },
  };
}

function lineMessage(
  userId: string,
  text: string,
  conversationId = userId,
): NormalisedInboundMessage {
  return {
    channelAccountId: lineId,
    providerMessageId: `l-${randomUUID()}`,
    rfc822MessageId: null,
    threadKey: `line:${conversationId}`,
    threadCandidates: [{ kind: 'line_conversation', value: conversationId }],
    from: { address: null, name: null, lineUserId: userId },
    subject: '',
    bodyText: text,
    bodyHtml: null,
    attachments: [],
    receivedAt: new Date(clock),
    rawObjectKey: null,
    automated: { disposition: 'human', subtype: 'none', signals: [] },
  };
}

const AUTO_REPLY: NormalisedInboundMessage['automated'] = {
  disposition: 'auto_reply',
  subtype: 'out_of_office',
  signals: ['header:auto-submitted=auto-replied'],
};
const NEWSLETTER: NormalisedInboundMessage['automated'] = {
  disposition: 'noise',
  subtype: 'mailing_list',
  signals: ['header:list-unsubscribe'],
};

async function ingest(message: NormalisedInboundMessage, classification?: InboundClassification) {
  return env.tx((tx) =>
    env.domain.inbound.ingest(tx, ctx(), {
      message,
      inboundEventId: null,
      ...(classification === undefined ? {} : { classification }),
    }),
  );
}

async function counts(): Promise<{
  tickets: number;
  messages: number;
  contacts: number;
  outbox: number;
}> {
  const db = env.db.owner.db;
  return {
    tickets: (await db.select({ id: schema.ticket.id }).from(schema.ticket)).length,
    messages: (await db.select({ id: schema.message.id }).from(schema.message)).length,
    contacts: (await db.select({ id: schema.contact.id }).from(schema.contact)).length,
    // Customer-bound jobs only: a new ticket also queues its AI brief (T-106e) and a Discord notice
    // for staff (T-104); neither goes to the customer.
    outbox: (
      await db
        .select({ id: schema.outbox.id })
        .from(schema.outbox)
        .where(notInArray(schema.outbox.queue, ['ai', 'discord']))
    ).length,
  };
}

async function ticketRow(id: string) {
  const [row] = await env.db.owner.db.select().from(schema.ticket).where(eq(schema.ticket.id, id));
  if (!row) throw new Error('no ticket');
  return row;
}

async function setTicket(id: string, patch: Partial<typeof schema.ticket.$inferInsert>) {
  await env.db.owner.db.update(schema.ticket).set(patch).where(eq(schema.ticket.id, id));
}

async function openTicketFor(from: string, subject = 'Cannot sign in') {
  const first = mail({ from, subject, messageId: `first-${randomUUID()}@mail.example.test` });
  const result = await ingest(first);
  const ticketId = result.value.ticketId;
  if (ticketId === null) throw new Error('expected a ticket');
  return { first, ticketId, result };
}

describe('ingestInbound: new mail', () => {
  it('opens a ticket for an unknown sender under the placeholder organization, unverified', async () => {
    const message = mail({
      from: 'New.Person@Stranger.example.test',
      name: 'สมชาย ใจดี',
      subject: 'ระบบเข้าสู่ระบบไม่ได้ ด่วน',
      body: 'รหัสผ่านถูกปฏิเสธตั้งแต่เช้า',
      html: '<p>รหัสผ่านถูกปฏิเสธ</p>',
    });
    const before = await counts();
    const result = await ingest(message);
    const outcome = result.value;

    expect(outcome).toMatchObject({
      disposition: 'ticket',
      alreadyIngested: false,
      duplicateOf: null,
      matchedBy: null,
      channel: 'gmail',
    });
    expect(outcome.ticketKey).toMatch(/^OPS-\d+$/);
    const ticket = await ticketRow(outcome.ticketId ?? '');
    expect(ticket).toMatchObject({
      orgId: UNIDENTIFIED_ORG_ID,
      channel: 'gmail',
      channelAccountId: gmailId,
      subject: 'ระบบเข้าสู่ระบบไม่ได้ ด่วน',
      status: 'new',
    });
    const [contact] = await env.db.owner.db
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.id, ticket.requesterContactId ?? ''));
    expect(contact).toMatchObject({
      orgId: UNIDENTIFIED_ORG_ID,
      name: 'สมชาย ใจดี',
      emails: ['new.person@stranger.example.test'],
      verifiedAt: null,
    });
    const [saved] = await env.db.owner.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.id, outcome.messageId ?? ''));
    expect(saved).toMatchObject({
      direction: 'inbound',
      externalId: message.providerMessageId,
      threadKey: message.threadKey,
      bodyText: 'รหัสผ่านถูกปฏิเสธตั้งแต่เช้า',
      bodyHtml: '<p>รหัสผ่านถูกปฏิเสธ</p>',
      deliveryStatus: 'not_applicable',
    });
    const [record] = await env.db.owner.db
      .select()
      .from(schema.inboundMessage)
      .where(eq(schema.inboundMessage.id, outcome.inboundMessageId));
    expect(record).toMatchObject({
      disposition: 'ticket',
      ticketId: ticket.id,
      messageId: saved?.id,
      dispositionBy: 'system',
      classification: { type: 'triage', source: 'rules' },
    });
    expect(result.events.map((event) => event.type).toSorted()).toEqual([
      'message.created',
      'ticket.created',
    ]);
    const ingestAudits = (await auditRows(env, AUDIT_ACTIONS.inboundIngest)).filter(
      (row) => row.targetId === outcome.inboundMessageId,
    );
    expect(ingestAudits).toHaveLength(1);
    // Nothing goes to the customer from ingestion (no auto-ack, N3): the outbox stays as it was.
    expect((await counts()).outbox).toBe(before.outbox);
  });

  it('writes one inbound.ingest audit row with ids and labels, never the address or the text', async () => {
    const message = mail({
      from: 'audit.check@stranger.example.test',
      body: 'secret-looking text 12345',
    });
    const rows0 = (await auditRows(env, AUDIT_ACTIONS.inboundIngest)).length;
    const result = await ingest(message);
    const rows = await auditRows(env, AUDIT_ACTIONS.inboundIngest);
    expect(rows).toHaveLength(rows0 + 1);
    const row = rows.find((candidate) => candidate.targetId === result.value.inboundMessageId);
    expect(row).toMatchObject({
      actorType: 'system',
      targetType: 'inbound_message',
      outcome: 'success',
      metadata: { disposition: 'ticket', classifier: { type: 'triage', source: 'rules' } },
    });
    const text = JSON.stringify(row);
    expect(text).not.toContain('audit.check@');
    expect(text).not.toContain('secret-looking');
  });

  it('puts a sender whose domain an organization claims in that organization', async () => {
    const org = await addOrg(env, { domains: ['claimed.example.test'] });
    const result = await ingest(mail({ from: 'agent@claimed.example.test' }));
    expect((await ticketRow(result.value.ticketId ?? '')).orgId).toBe(org.id);
  });

  it('keeps a known contact in their organization and reuses the contact', async () => {
    const org = await addOrg(env);
    const [contact] = await env.db.owner.db
      .insert(schema.contact)
      .values({ orgId: org.id, name: 'Known', emails: ['known@customer.example.test'] })
      .returning();
    const before = (await counts()).contacts;
    const result = await ingest(mail({ from: 'Known@Customer.example.test' }));
    const ticket = await ticketRow(result.value.ticketId ?? '');
    expect(ticket).toMatchObject({ orgId: org.id, requesterContactId: contact?.id });
    expect((await counts()).contacts).toBe(before);
  });

  it('files the ticket under the classifier intent when it exists and ignores an unknown one', async () => {
    const intent = await addIntent(env, { key: 'login_failure', defaultPriority: 'P2' });
    const known = await ingest(mail(), {
      type: 'new_customer_issue',
      intentKey: 'login_failure',
      confidence: 0.9,
      source: 'ai',
      aiRunId: null,
    });
    expect((await ticketRow(known.value.ticketId ?? '')).intentId).toBe(intent.id);
    const unknown = await ingest(mail(), {
      type: 'new_customer_issue',
      intentKey: 'made_up_by_model',
      confidence: 0.5,
      source: 'ai',
      aiRunId: null,
    });
    expect((await ticketRow(unknown.value.ticketId ?? '')).intentId).toBeNull();
  });

  it('takes the subject of a ticket from the first line of the text when the channel has none', async () => {
    const blank = await ingest(mail({ subject: '   ', body: '\n  \n' }));
    expect((await ticketRow(blank.value.ticketId ?? '')).subject).toBe('(no subject)');
    const fromBody = await ingest(mail({ subject: '', body: '\nระบบล่มครับ\nรายละเอียดต่อ' }));
    expect((await ticketRow(fromBody.value.ticketId ?? '')).subject).toBe('ระบบล่มครับ');
    const long = await ingest(mail({ subject: '', body: 'ก'.repeat(200) }));
    const subject = (await ticketRow(long.value.ticketId ?? '')).subject;
    expect(Array.from(subject)).toHaveLength(80);
    expect(subject.endsWith('…')).toBe(true);
  });
});

describe('ingestInbound: duplicates and redelivery', () => {
  it('does nothing the second time the same provider message arrives', async () => {
    const message = mail();
    const first = await ingest(message);
    const before = await counts();
    const audits = (await auditRows(env, AUDIT_ACTIONS.inboundIngest)).length;
    const second = await ingest(message);

    expect(second.value).toMatchObject({
      alreadyIngested: true,
      disposition: 'ticket',
      ticketId: first.value.ticketId,
      messageId: first.value.messageId,
    });
    expect(second.events).toEqual([]);
    expect(await counts()).toEqual(before);
    expect(await auditRows(env, AUDIT_ACTIONS.inboundIngest)).toHaveLength(audits);
  });

  it('creates one ticket when the same message is ingested twice at the same time', async () => {
    const message = mail();
    const before = await counts();
    const results = await Promise.all([ingest(message), ingest(message), ingest(message)]);
    expect(new Set(results.map((result) => result.value.ticketId)).size).toBe(1);
    expect(results.filter((result) => !result.value.alreadyIngested)).toHaveLength(1);
    const after = await counts();
    expect(after.tickets).toBe(before.tickets + 1);
    expect(after.messages).toBe(before.messages + 1);
  });

  it('follows the first copy when the same Message-ID arrives under another provider id (R-2.2)', async () => {
    const original = mail({ messageId: 'same-mail@mail.example.test' });
    const first = await ingest(original);
    const before = await counts();
    const second = await ingest({
      ...original,
      providerMessageId: `g-${randomUUID()}`,
    });
    expect(second.value).toMatchObject({
      disposition: 'ticket',
      ticketId: first.value.ticketId,
      duplicateOf: first.value.inboundMessageId,
      alreadyIngested: false,
    });
    expect(second.events).toEqual([]);
    expect(await counts()).toEqual(before);
  });

  it('rolls everything back when the transaction fails after ingestion', async () => {
    const message = mail();
    const before = await counts();
    await expect(
      env.tx(async (tx) => {
        await env.domain.inbound.ingest(tx, ctx(), { message });
        throw new Error('simulated crash before commit');
      }),
    ).rejects.toThrow('simulated crash');
    expect(await counts()).toEqual(before);
    const rows = await env.db.owner.db
      .select()
      .from(schema.inboundMessage)
      .where(eq(schema.inboundMessage.providerMessageId, message.providerMessageId));
    expect(rows).toEqual([]);
    // A retry then works as if it were the first time.
    expect((await ingest(message)).value.disposition).toBe('ticket');
  });
});

describe('ingestInbound: thread matching (R-2.3)', () => {
  it('appends a reply that has the same Gmail thread id, and says how it matched', async () => {
    const { first, ticketId } = await openTicketFor('thread.reader@stranger.example.test');
    const threadId = first.threadKey?.replace('gmail:', '') ?? '';
    const reply = await ingest(
      mail({
        from: 'thread.reader@stranger.example.test',
        threadId,
        subject: 'Re: Cannot sign in',
        body: 'Still failing',
      }),
    );
    expect(reply.value).toMatchObject({
      disposition: 'appended',
      ticketId,
      matchedBy: 'gmail_thread_id',
    });
    const messages = await env.db.owner.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.ticketId, ticketId));
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.bodyText).toSorted()).toEqual([
      'Password rejected',
      'Still failing',
    ]);
    expect(reply.events.map((event) => event.type)).toContain('message.created');
  });

  it('matches by In-Reply-To when the thread id differs', async () => {
    const { first, ticketId } = await openTicketFor('replyto@stranger.example.test');
    const reply = await ingest(
      mail({
        from: 'replyto@stranger.example.test',
        threadId: `other-${randomUUID()}`,
        inReplyTo: (first.rfc822MessageId ?? '').toLowerCase(),
        subject: 'Re: Cannot sign in',
      }),
    );
    expect(reply.value).toMatchObject({
      disposition: 'appended',
      ticketId,
      matchedBy: 'in_reply_to',
    });
  });

  it('matches by References, newest first, when In-Reply-To names something unknown', async () => {
    const { first, ticketId } = await openTicketFor('refs@stranger.example.test');
    const reply = await ingest(
      mail({
        from: 'refs@stranger.example.test',
        threadId: `other-${randomUUID()}`,
        inReplyTo: 'unknown-parent@elsewhere.example.test',
        references: [first.rfc822MessageId ?? '', 'unknown-parent@elsewhere.example.test'],
        subject: 'Re: Re: Cannot sign in',
      }),
    );
    expect(reply.value).toMatchObject({
      disposition: 'appended',
      ticketId,
      matchedBy: 'references',
    });
  });

  it('matches a [OPS-n] token in a Thai subject', async () => {
    const { ticketId, result } = await openTicketFor(
      'token@stranger.example.test',
      'ปัญหาการชำระเงิน',
    );
    const key = result.value.ticketKey ?? '';
    const reply = await ingest(
      mail({
        from: 'token@stranger.example.test',
        threadId: null,
        subject: `ตอบกลับ: [${key}] ปัญหาการชำระเงิน`,
        subjectToken: key,
      }),
    );
    expect(reply.value).toMatchObject({
      disposition: 'appended',
      ticketId,
      matchedBy: 'subject_token',
    });
  });

  it('does not let a stranger write into a customer ticket by quoting its key or headers', async () => {
    const org = await addOrg(env);
    await env.db.owner.db
      .insert(schema.contact)
      .values({ orgId: org.id, name: 'Customer', emails: ['customer@victim.example.test'] });
    const { first, ticketId, result } = await openTicketFor('customer@victim.example.test');
    const key = result.value.ticketKey ?? '';
    const threadId = first.threadKey?.replace('gmail:', '') ?? '';

    const attacker = await ingest(
      mail({
        from: 'attacker@evil.example.test',
        threadId,
        inReplyTo: (first.rfc822MessageId ?? '').toLowerCase(),
        subject: `Re: [${key}] Cannot sign in`,
        subjectToken: key,
      }),
    );
    expect(attacker.value.disposition).toBe('ticket');
    expect(attacker.value.ticketId).not.toBe(ticketId);
    const messages = await env.db.owner.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.ticketId, ticketId));
    expect(messages).toHaveLength(1);
  });

  it('follows a merged ticket to the one it was merged into', async () => {
    const { first, ticketId } = await openTicketFor('merged@stranger.example.test');
    await markMerged(env, ticketId);
    const [parentRow] = await env.db.owner.db
      .select({ parent: schema.ticket.parentTicketId })
      .from(schema.ticket)
      .where(eq(schema.ticket.id, ticketId));
    const reply = await ingest(
      mail({
        from: 'merged@stranger.example.test',
        threadId: first.threadKey?.replace('gmail:', '') ?? '',
      }),
    );
    // The stand-in parent belongs to the same org as the child, so the message joins it.
    expect(reply.value).toMatchObject({ disposition: 'appended', ticketId: parentRow?.parent });
  });

  describe('heuristic: same contact, open ticket, same subject [ASSUMED]', () => {
    it('joins a mail with no thread keys when the normalised Thai subject is the same', async () => {
      const { ticketId } = await openTicketFor(
        'heuristic@stranger.example.test',
        'ปัญหา รายงานไม่ขึ้น',
      );
      const follow = await ingest(
        mail({
          from: 'heuristic@stranger.example.test',
          threadId: null,
          messageId: null,
          subject: 'Re:  Re: ปัญหา   รายงานไม่ขึ้น',
        }),
      );
      expect(follow.value).toMatchObject({
        disposition: 'appended',
        ticketId,
        matchedBy: 'subject_heuristic',
      });
    });

    it('opens a new ticket when the subject differs', async () => {
      const { ticketId } = await openTicketFor(
        'heuristic2@stranger.example.test',
        'Invoice question',
      );
      const other = await ingest(
        mail({
          from: 'heuristic2@stranger.example.test',
          threadId: null,
          subject: 'Something else',
        }),
      );
      expect(other.value.disposition).toBe('ticket');
      expect(other.value.ticketId).not.toBe(ticketId);
    });

    it('does not join a ticket that is no longer open, or one that was last touched long ago', async () => {
      const { ticketId } = await openTicketFor('heuristic3@stranger.example.test', 'Old topic');
      await setTicket(ticketId, { updatedAt: new Date(clock.getTime() - 15 * 24 * 3600 * 1000) });
      const stale = await ingest(
        mail({
          from: 'heuristic3@stranger.example.test',
          threadId: null,
          subject: 'Re: Old topic',
        }),
      );
      expect(stale.value.ticketId).not.toBe(ticketId);
    });

    it('lets noise labels win over the heuristic', async () => {
      const { ticketId } = await openTicketFor('heuristic4@stranger.example.test', 'Weekly digest');
      const newsletter = await ingest(
        mail({
          from: 'heuristic4@stranger.example.test',
          threadId: null,
          subject: 'Weekly digest',
          automated: NEWSLETTER,
        }),
      );
      expect(newsletter.value.disposition).toBe('noise');
      expect(newsletter.value.ticketId).toBeNull();
      expect((await ticketRow(ticketId)).status).toBe('new');
    });
  });

  it('keeps a LINE conversation on one ticket while it is open and starts a new one after it was resolved', async () => {
    const userId = `U${randomUUID().replaceAll('-', '')}`;
    const first = await ingest(lineMessage(userId, 'สวัสดีครับ ระบบล่ม'));
    expect(first.value).toMatchObject({ disposition: 'ticket', channel: 'line' });
    const ticket = await ticketRow(first.value.ticketId ?? '');
    const [contact] = await env.db.owner.db
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.id, ticket.requesterContactId ?? ''));
    expect(contact).toMatchObject({
      lineUserId: userId,
      orgId: UNIDENTIFIED_ORG_ID,
      verifiedAt: null,
    });

    const second = await ingest(lineMessage(userId, 'ยังเข้าไม่ได้เลยครับ'));
    expect(second.value).toMatchObject({
      disposition: 'appended',
      ticketId: ticket.id,
      matchedBy: 'line_conversation',
    });

    await setTicket(ticket.id, { status: 'resolved', resolvedAt: new Date(clock) });
    const third = await ingest(lineMessage(userId, 'ขอบคุณครับ มีเรื่องใหม่'));
    expect(third.value.disposition).toBe('ticket');
    expect(third.value.ticketId).not.toBe(ticket.id);
    expect(await eventTypes(env, third.value.ticketId ?? '')).toContain(
      INBOUND_TICKET_EVENTS.followsUp,
    );
  });
});

describe('ingestInbound: reopen rules (R-1.10)', () => {
  it('restarts a ticket that waits on the customer', async () => {
    const { first, ticketId } = await openTicketFor('waiting@stranger.example.test');
    await setTicket(ticketId, { status: 'waiting_on_customer', slaPausedAt: new Date(clock) });
    const reply = await ingest(
      mail({
        from: 'waiting@stranger.example.test',
        threadId: first.threadKey?.replace('gmail:', '') ?? '',
      }),
    );
    expect(reply.value).toMatchObject({ disposition: 'appended', ticketId, reopened: false });
    expect(await ticketRow(ticketId)).toMatchObject({ status: 'open', slaPausedAt: null });
    expect(reply.events.map((event) => event.type)).toContain('ticket.updated');
  });

  it('reopens a ticket resolved inside the window and counts the reopen', async () => {
    const { first, ticketId } = await openTicketFor('resolved@stranger.example.test');
    await setTicket(ticketId, {
      status: 'resolved',
      resolvedAt: new Date(clock.getTime() - 2 * 24 * 3600 * 1000),
    });
    const reply = await ingest(
      mail({
        from: 'resolved@stranger.example.test',
        threadId: first.threadKey?.replace('gmail:', '') ?? '',
      }),
    );
    expect(reply.value).toMatchObject({ disposition: 'appended', ticketId, reopened: true });
    expect(await ticketRow(ticketId)).toMatchObject({
      status: 'open',
      reopenCount: 1,
      resolvedAt: null,
    });
  });

  it('opens a new ticket, linked to the old one, when the resolved ticket is past the window', async () => {
    const { first, ticketId } = await openTicketFor('late@stranger.example.test');
    await setTicket(ticketId, {
      status: 'resolved',
      resolvedAt: new Date(clock.getTime() - 8 * 24 * 3600 * 1000),
    });
    const reply = await ingest(
      mail({
        from: 'late@stranger.example.test',
        threadId: first.threadKey?.replace('gmail:', '') ?? '',
      }),
    );
    expect(reply.value.disposition).toBe('ticket');
    expect(reply.value.ticketId).not.toBe(ticketId);
    expect((await ticketRow(ticketId)).status).toBe('resolved');
    const events = await env.db.owner.db
      .select()
      .from(schema.ticketEvent)
      .where(eq(schema.ticketEvent.ticketId, reply.value.ticketId ?? ''));
    const follows = events.find((event) => event.type === INBOUND_TICKET_EVENTS.followsUp);
    expect(follows?.payload).toMatchObject({
      previousTicketId: ticketId,
      previousStatus: 'resolved',
    });
  });

  it('opens a new ticket for a reply to a closed one', async () => {
    const { first, ticketId } = await openTicketFor('closed@stranger.example.test');
    await setTicket(ticketId, {
      status: 'closed',
      closedAt: new Date(clock),
      resolvedAt: new Date(clock),
    });
    const reply = await ingest(
      mail({
        from: 'closed@stranger.example.test',
        threadId: first.threadKey?.replace('gmail:', '') ?? '',
      }),
    );
    expect(reply.value.disposition).toBe('ticket');
    expect(reply.value.ticketId).not.toBe(ticketId);
  });
});

describe('ingestInbound: noise, auto replies and internal mail', () => {
  it('never opens a ticket or reopens one for an out-of-office reply, even on a resolved thread', async () => {
    const { first, ticketId } = await openTicketFor('away@stranger.example.test');
    await setTicket(ticketId, { status: 'resolved', resolvedAt: new Date(clock) });
    const before = await counts();
    const reply = await ingest(
      mail({
        from: 'away@stranger.example.test',
        threadId: first.threadKey?.replace('gmail:', '') ?? '',
        inReplyTo: (first.rfc822MessageId ?? '').toLowerCase(),
        subject: 'Automatic reply: Cannot sign in',
        automated: AUTO_REPLY,
      }),
      { type: 'reply_to_existing', intentKey: null, confidence: 0.99, source: 'ai', aiRunId: null },
    );
    expect(reply.value).toMatchObject({
      disposition: 'auto_reply',
      ticketId: null,
      messageId: null,
    });
    expect(reply.events).toEqual([]);
    expect(await counts()).toEqual(before);
    expect(await ticketRow(ticketId)).toMatchObject({ status: 'resolved', reopenCount: 0 });
  });

  it('keeps a bounce out of the ticket flow and still stores it for "Other mail"', async () => {
    const message = mail({
      from: 'mailer-daemon@mail.example.test',
      subject: 'Delivery Status Notification (Failure)',
      automated: {
        disposition: 'auto_reply',
        subtype: 'bounce',
        signals: ['sender:mailer-daemon'],
      },
    });
    const before = await counts();
    const result = await ingest(message);
    expect(result.value.disposition).toBe('auto_reply');
    const after = await counts();
    expect(after.tickets).toBe(before.tickets);
    expect(after.contacts).toBe(before.contacts);
    const [row] = await env.db.owner.db
      .select()
      .from(schema.inboundMessage)
      .where(eq(schema.inboundMessage.id, result.value.inboundMessageId));
    expect(row).toMatchObject({
      disposition: 'auto_reply',
      ticketId: null,
      subject: 'Delivery Status Notification (Failure)',
      automated: { subtype: 'bounce' },
    });
  });

  it('files a newsletter as noise: no ticket, no contact, kept for the Other mail view', async () => {
    const before = await counts();
    const result = await ingest(
      mail({
        from: 'news@vendor.example.test',
        subject: 'ข่าวประจำสัปดาห์',
        automated: NEWSLETTER,
      }),
    );
    expect(result.value).toMatchObject({ disposition: 'noise', ticketId: null });
    expect(result.events).toEqual([]);
    expect(await counts()).toEqual(before);
    const other = await env.db.owner.db
      .select({ id: schema.inboundMessage.id })
      .from(schema.inboundMessage)
      .where(eq(schema.inboundMessage.disposition, 'noise'));
    expect(other.map((row) => row.id)).toContain(result.value.inboundMessageId);
  });

  it('treats a message the classifier calls noise the same way when the headers looked human', async () => {
    const result = await ingest(mail(), {
      type: 'noise',
      intentKey: null,
      confidence: 0.97,
      source: 'ai',
      aiRunId: null,
    });
    expect(result.value.disposition).toBe('noise');
  });

  it('lets a reply inside a known thread through even when a mailing-list header marks it noise', async () => {
    // Customers who write from a Google Group carry List-Id on every message; the conversation wins.
    const { first, ticketId } = await openTicketFor('group@stranger.example.test');
    const reply = await ingest(
      mail({
        from: 'group@stranger.example.test',
        threadId: first.threadKey?.replace('gmail:', '') ?? '',
        automated: NEWSLETTER,
      }),
    );
    expect(reply.value).toMatchObject({ disposition: 'appended', ticketId });
  });

  it('keeps internal or machine mail out of the ticket flow', async () => {
    const result = await ingest(mail(), {
      type: 'internal_or_machine',
      intentKey: null,
      confidence: 0.9,
      source: 'ai',
      aiRunId: null,
    });
    expect(result.value).toMatchObject({ disposition: 'internal', ticketId: null });
  });

  it('keeps a message from an inactive organization visible instead of failing', async () => {
    const org = await addOrg(env, { status: 'inactive' });
    await env.db.owner.db
      .insert(schema.contact)
      .values({ orgId: org.id, name: 'Gone', emails: ['gone@former.example.test'] });
    const result = await ingest(mail({ from: 'gone@former.example.test', threadId: null }));
    expect(result.value).toMatchObject({ disposition: 'noise', ticketId: null });
    const [audit] = (await auditRows(env, AUDIT_ACTIONS.inboundIngest)).filter(
      (row) => row.targetId === result.value.inboundMessageId,
    );
    expect(audit?.metadata).toMatchObject({ reason: 'org_inactive' });
  });
});
