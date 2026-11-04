import { randomBytes, randomUUID } from 'node:crypto';

import { createRedactor } from '@watchtower/ai';
import { ChannelError, line } from '@watchtower/channels';
import { createDatabase, enqueueOutbox, schema } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { createDomain, createPolicyGate, parseLinkCode } from '@watchtower/domain';
import {
  AUDIT_ACTIONS,
  INBOUND_QUEUES,
  INGEST_JOBS,
  INGEST_OUTBOX_JOB_OPTIONS,
  QUEUE_NAMES,
  parseRedisUrl,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { Queue } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLineAutoAck } from '../ingest/auto-ack.js';
import type { InboundClassifierHook } from '../ingest/classifier.js';
import { createS3ObjectStore, type ObjectStore } from '../ingest/object-store.js';
import { createLogger } from '../logger.js';
import { createOutboundDispatcher } from '../outbound/dispatcher.js';
import { testConfig } from '../testing/support.js';
import { startWorker, type RunningWorker } from '../worker.js';
import { createQuotaReconciler } from './reconcile.js';
import { lineChannelsFrom } from './transports.js';

// LINE through the real worker: Postgres (restricted application role, real policy gate), Redis
// (outbox relay, BullMQ) and MinIO from docker compose, with FakeLineTransport standing in for
// LINE. disableNetConnect allows loopback only, so anything that tried to reach LINE would fail the
// test (N1). Synthetic ids and example.test hosts only.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const prefix = `wt-line-${randomBytes(4).toString('hex')}`;
const net = disableNetConnect();

let testDb: TestDatabase;
let worker: RunningWorker;
let config: ReturnType<typeof testConfig>;
let store: ObjectStore;
let fakeLine: line.FakeLineTransport;
let lineId = '';
const storedKeys = new Set<string>();
const classifierSeen: string[] = [];

const owner = () => testDb.owner.db;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
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
    getStream: (key) => real.getStream(key),
    delete: (key) => real.delete(key),
  };
  fakeLine = new line.FakeLineTransport();
  const hook: InboundClassifierHook = {
    redact: (text) => createRedactor().session({ scope: 'line-test' }).redact(text),
    classify: (input) => {
      classifierSeen.push(input.body);
      return Promise.resolve({
        type: 'triage',
        intentKey: null,
        confidence: 0.5,
        source: 'ai',
        aiRunId: null,
      });
    },
  };
  worker = await startWorker(config, createLogger(config), {
    queuePrefix: prefix,
    realtimeChannel: `watchtower:realtime:${prefix}`,
    overrides: {
      ingest: { store, classifier: () => hook },
      line: { transportFor: (account) => (account.type === 'line' ? fakeLine : undefined) },
    },
  });
  const [account] = await owner()
    .insert(schema.channelAccount)
    .values({ type: 'line', name: 'Support LINE OA' })
    .returning();
  lineId = account?.id ?? '';
});

afterAll(async () => {
  await worker.close();
  for (const key of storedKeys) await store.delete(key).catch(() => undefined);
  const connection = parseRedisUrl(config.REDIS_URL);
  for (const name of [QUEUE_NAMES.ingest, QUEUE_NAMES.outbound, QUEUE_NAMES.line]) {
    const queue = new Queue(name, { connection, prefix });
    await queue.obliterate({ force: true });
    await queue.close();
  }
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
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

/** What the webhook receiver does: the event and its outbox job in one transaction. */
async function receive(event: Record<string, unknown>): Promise<string> {
  return owner().transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.inboundEvent)
      .values({
        channelAccountId: lineId,
        providerEventId: String(event.webhookEventId),
        payload: event,
      })
      .returning({ id: schema.inboundEvent.id });
    if (!row) throw new Error('no event row');
    await enqueueOutbox(tx, {
      queue: INBOUND_QUEUES.ingest,
      jobName: INGEST_JOBS.process,
      jobId: row.id,
      payload: { inboundEventId: row.id },
      options: { ...INGEST_OUTBOX_JOB_OPTIONS },
    });
    return row.id;
  });
}

const settled = (id: string) =>
  waitFor('the event to be finished', async () => {
    const [row] = await owner()
      .select()
      .from(schema.inboundEvent)
      .where(eq(schema.inboundEvent.id, id));
    return row === undefined || row.status === 'pending' ? undefined : row;
  });

let sequence = 0;
function lineEvent(
  userId: string,
  message: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  sequence += 1;
  return {
    type: 'message',
    mode: 'active',
    timestamp: Date.now(),
    webhookEventId: `01${prefix}-${String(sequence)}`,
    deliveryContext: { isRedelivery: false },
    source: { type: 'user', userId },
    replyToken: fakeLine.issueReplyToken(),
    message: { id: `m-${prefix}-${String(sequence)}`, ...message },
    ...extra,
  };
}
const newUser = () => `Ufake${randomBytes(12).toString('hex')}`;

async function messageFor(eventId: string) {
  const [row] = await owner()
    .select()
    .from(schema.inboundMessage)
    .where(eq(schema.inboundMessage.inboundEventId, eventId));
  return row;
}

async function deliveriesOf(ticketId: string) {
  return owner()
    .select()
    .from(schema.outboundDelivery)
    .where(eq(schema.outboundDelivery.ticketId, ticketId));
}

async function quotaRows() {
  return owner()
    .select()
    .from(schema.channelQuotaUsage)
    .where(eq(schema.channelQuotaUsage.channelAccountId, lineId));
}

describe('LINE auto-ack (T-103c)', () => {
  it('acknowledges a new conversation through the reply token within 5 s, for free', async () => {
    const userId = newUser();
    const repliesBefore = fakeLine.replies.length;
    const startedAt = Date.now();
    const eventId = await receive(
      lineEvent(userId, { type: 'text', text: 'ระบบล่มครับ ช่วยด้วย' }),
    );
    await waitFor('the acknowledgment', () => fakeLine.replies.length > repliesBefore);
    const ackMs = Date.now() - startedAt;
    // AC-2: the whole path (outbox relay, queue, ingest, ticket, ack) in under 5 s, on fakes.
    expect(ackMs).toBeLessThan(5000);
    await settled(eventId);

    const message = await messageFor(eventId);
    expect(message?.disposition).toBe('ticket');
    const [ticket] = await owner()
      .select()
      .from(schema.ticket)
      .where(eq(schema.ticket.id, message?.ticketId ?? ''));
    const reply = fakeLine.replies.at(-1);
    // The text is the server-side template for the safe key, with the ticket key; nobody supplied words.
    expect(reply?.texts.join('\n')).toContain(`OPS-${String(ticket?.number)}`);
    expect(fakeLine.pushes).toHaveLength(0);

    const deliveries = await waitFor('the delivery to be recorded', async () => {
      const rows = await deliveriesOf(ticket?.id ?? '');
      return rows.length > 0 && rows.every((row) => row.state === 'sent') ? rows : undefined;
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      origin: 'system_template',
      templateKey: 'auto_ack.received',
      route: 'line_reply',
      state: 'sent',
      holdSeconds: 0,
    });
    // A reply token costs nothing: the push counter did not move.
    expect((await quotaRows()).reduce((sum, row) => sum + row.used, 0)).toBe(0);
    // The token was spent exactly once and is gone from the database.
    expect(message?.replyTokenSealed).toBeNull();
    // The event payload was blanked, and the reply token never reached object storage.
    const raw = await store.get(message?.rawObjectKey ?? '');
    expect(Buffer.from(raw ?? []).toString('utf8')).not.toContain('replyToken');
  });

  it('acknowledges a new ticket once, not every message of an open conversation', async () => {
    const userId = newUser();
    const first = await receive(lineEvent(userId, { type: 'text', text: 'เปิดรายงานไม่ได้' }));
    await settled(first);
    await waitFor('the first ack', async () => {
      const message = await messageFor(first);
      return message?.ticketId === null || message === undefined
        ? undefined
        : (await deliveriesOf(message.ticketId)).some((row) => row.state === 'sent');
    });
    const repliesAfterFirst = fakeLine.replies.length;
    const second = await receive(lineEvent(userId, { type: 'text', text: 'ยังไม่ได้เลยครับ' }));
    await settled(second);
    expect((await messageFor(second))?.disposition).toBe('appended');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeLine.replies).toHaveLength(repliesAfterFirst);
    expect(fakeLine.pushes).toHaveLength(0);
  });

  it('never pushes an acknowledgment whose reply token is too old, and spends no quota', async () => {
    const userId = newUser();
    const pushesBefore = fakeLine.pushes.length;
    const eventId = await receive(
      lineEvent(userId, { type: 'text', text: 'ส่งช้า' }, { timestamp: Date.now() - 120_000 }),
    );
    await settled(eventId);
    const message = await messageFor(eventId);
    const ticketId = message?.ticketId ?? '';
    const delivery = await waitFor('the refused delivery', async () => {
      const rows = await deliveriesOf(ticketId);
      return rows.find((row) => row.state === 'failed');
    });
    expect(delivery.errorCode).toBe('reply_token_unavailable');
    expect(fakeLine.pushes).toHaveLength(pushesBefore);
    expect((await quotaRows()).reduce((sum, row) => sum + row.used, 0)).toBe(0);
  });

  it('counts a staff push against the monthly quota once the token is gone', async () => {
    const userId = newUser();
    const eventId = await receive(
      lineEvent(userId, { type: 'text', text: 'ขอสอบถาม' }, { timestamp: Date.now() - 120_000 }),
    );
    await settled(eventId);
    const message = await messageFor(eventId);
    const ticketId = message?.ticketId ?? '';
    await waitFor('the refused ack', async () =>
      (await deliveriesOf(ticketId)).find((row) => row.state === 'failed'),
    );
    const [staff] = await owner()
      .insert(schema.users)
      .values({ email: `${randomUUID()}@example.test`, name: 'Staff', role: 'agent' })
      .returning({ id: schema.users.id });
    const database = createDatabase({
      url: testDb.appUrl,
      max: 2,
      applicationName: 'wt-line-test',
    });
    const domain = createDomain({
      ticketKeyPrefix: config.TICKET_KEY_PREFIX,
      sealKey: randomBytes(32),
      policyGate: createPolicyGate({ db: database.db }),
    });
    try {
      const replied = await database.db.transaction((tx) =>
        domain.tickets.reply(
          tx,
          domain.context({ actor: { type: 'user', id: staff?.id ?? null } }),
          {
            ref: ticketId,
            reply: { body: 'ตรวจสอบให้แล้วครับ' },
            sender: { kind: 'staff', userId: staff?.id ?? '' },
          },
        ),
      );
      const staffDelivery = replied.value.delivery;
      expect(staffDelivery?.state).toBe('scheduled');
      // The worker's dispatcher picks it up when the undo window ends (default 5 s); nudge it to
      // keep the test fast by moving the window to now.
      await owner()
        .update(schema.outboundDelivery)
        .set({ nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(schema.outboundDelivery.id, staffDelivery?.id ?? ''));
      const dispatcher = createOutboundDispatcher({
        database,
        domain: createDomain({
          ticketKeyPrefix: config.TICKET_KEY_PREFIX,
          sealKey: randomBytes(32),
          policyGate: createPolicyGate({ db: database.db }),
        }),
        channels: {
          gmail: () => undefined,
          ...lineChannelsFrom(
            () => fakeLine,
            (transport) => {
              const adapter = new line.LineAdapter({
                transport,
                getChannelSecret: () => Promise.resolve('unused'),
              });
              return { send: (input) => adapter.send(input) };
            },
          ),
        },
        appHost: 'desk.example.test',
        realtime: { publish: () => Promise.resolve() },
        logger: createLogger(config),
      });
      const outcome = await dispatcher.dispatch(staffDelivery?.id ?? '');
      expect(outcome).toEqual({ status: 'sent', route: 'line_push' });
      expect(fakeLine.pushes.at(-1)?.to).toBe(userId);
    } finally {
      await database.close();
    }
    const used = (await quotaRows()).reduce((sum, row) => sum + row.used, 0);
    expect(used).toBe(1);
  });
});

describe('LINE auto-ack and the policy gate (N3)', () => {
  it('sends nothing for a template that is not on the safe list', async () => {
    const database = createDatabase({
      url: testDb.appUrl,
      max: 2,
      applicationName: 'wt-line-gate',
    });
    try {
      const domain = createDomain({
        ticketKeyPrefix: config.TICKET_KEY_PREFIX,
        sealKey: randomBytes(32),
        policyGate: createPolicyGate({ db: database.db }),
      });
      const eventId = await receive(lineEvent(newUser(), { type: 'text', text: 'สวัสดี' }));
      await settled(eventId);
      const message = await messageFor(eventId);
      const ticketId = message?.ticketId ?? '';
      await waitFor('the real ack', async () =>
        (await deliveriesOf(ticketId)).find((row) => row.state === 'sent'),
      );
      const repliesBefore = fakeLine.replies.length;
      const logged: string[] = [];
      const ack = createLineAutoAck({
        database,
        domain,
        dispatcher: { dispatch: () => Promise.reject(new Error('must not be reached')) },
        channels: { line: () => ({ send: () => Promise.reject(new Error('must not send')) }) },
        realtime: { publish: () => Promise.resolve() },
        logger: createLogger(
          { ...config, LOG_LEVEL: 'warn' },
          { write: (line) => void logged.push(line) },
        ),
        templateKey: 'auto_ack.free_text_by_ai',
      });
      await ack([
        {
          channelAccountId: lineId,
          channel: 'line',
          outcome: {
            inboundMessageId: randomUUID(),
            disposition: 'ticket',
            ticketId,
            ticketKey: null,
            messageId: null,
            matchedBy: null,
            alreadyIngested: false,
            duplicateOf: null,
            reopened: false,
            channel: 'line',
          },
        },
      ]);
      expect(fakeLine.replies).toHaveLength(repliesBefore);
      expect(logged.join('')).toContain('line auto-ack not sent');
      // No second delivery, no message with arbitrary text.
      expect(await deliveriesOf(ticketId)).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  it('still acknowledges at stage 0 with the kill switch on (a template involves no AI)', async () => {
    // The operator's switch ("stop all AI") has one legitimate writer; the owner connection stands in for it.
    await owner().execute(sql`UPDATE ai_switch SET is_on = true WHERE key = 'ai_kill_switch'`);
    try {
      const repliesBefore = fakeLine.replies.length;
      const eventId = await receive(lineEvent(newUser(), { type: 'text', text: 'ช่วยด้วย' }));
      await waitFor('the acknowledgment', () => fakeLine.replies.length > repliesBefore);
      await settled(eventId);
    } finally {
      await owner().execute(sql`UPDATE ai_switch SET is_on = false WHERE key = 'ai_kill_switch'`);
    }
  });
});

describe('LINE media (T-103c, R-2.12)', () => {
  it('downloads an image and a file into object storage and attaches them to the message', async () => {
    const userId = newUser();
    const imageBytes = Uint8Array.from(randomBytes(2048));
    const fileBytes = Uint8Array.from(Buffer.from('%PDF-1.4 synthetic report'));
    const image = lineEvent(userId, { type: 'image', contentProvider: { type: 'line' } });
    fakeLine.setContent(image.message.id, imageBytes, 'image/png');
    const first = await receive(image);
    await settled(first);
    const imageMessage = await messageFor(first);
    const attachments = imageMessage?.attachments as {
      objectKey: string | null;
      size: number;
      contentType: string;
      sha256: string;
    }[];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ contentType: 'image/png', size: 2048 });
    const key = attachments[0]?.objectKey ?? '';
    expect(key).toMatch(/^attachments\/line\//);
    expect(Buffer.from((await store.get(key)) ?? [])).toEqual(Buffer.from(imageBytes));

    const file = lineEvent(userId, {
      type: 'file',
      fileName: '../../รายงาน ประจำเดือน.pdf',
      fileSize: fileBytes.length,
    });
    fakeLine.setContent(file.message.id, fileBytes, 'application/pdf');
    const second = await receive(file);
    await settled(second);
    const fileMessage = await messageFor(second);
    const stored = fileMessage?.attachments as { objectKey: string | null; filename: string }[];
    // The name is for display only: no path survives, and the key does not depend on it.
    expect(stored[0]?.filename).toBe('รายงาน ประจำเดือน.pdf');
    expect(Buffer.from((await store.get(stored[0]?.objectKey ?? '')) ?? [])).toEqual(
      Buffer.from(fileBytes),
    );
  });

  it('keeps the message when the content is already gone, and does not fetch an external image', async () => {
    const userId = newUser();
    const gone = await receive(
      lineEvent(userId, { type: 'image', contentProvider: { type: 'line' } }),
    );
    await settled(gone);
    const goneMessage = await messageFor(gone);
    expect(goneMessage).toMatchObject({
      disposition: expect.stringMatching(/ticket|appended/) as string,
    });
    expect(goneMessage?.attachments).toEqual([]);

    let fetched = 0;
    const original = fakeLine.getContent.bind(fakeLine);
    fakeLine.getContent = (id) => {
      fetched += 1;
      return original(id);
    };
    try {
      const external = await receive(
        lineEvent(userId, { type: 'image', contentProvider: { type: 'external' } }),
      );
      await settled(external);
      expect(fetched).toBe(0);
      expect((await messageFor(external))?.attachments).toEqual([]);
    } finally {
      fakeLine.getContent = original;
    }
  });

  it('retries a download that failed for a reason that passes', async () => {
    const userId = newUser();
    const event = lineEvent(userId, { type: 'image', contentProvider: { type: 'line' } });
    const id = event.message.id;
    fakeLine.setContent(id, Uint8Array.from([1, 2, 3]), 'image/jpeg');
    fakeLine.failNext(
      'message.content',
      new ChannelError({
        provider: 'line',
        operation: 'message.content',
        kind: 'server',
        status: 503,
      }),
    );
    const eventId = await receive(event);
    const row = await settled(eventId);
    expect(row.status).toBe('processed');
    const attachments = (await messageFor(eventId))?.attachments as unknown[];
    expect(attachments).toHaveLength(1);
  });
});

describe('LINE identity: link code (T-103d)', () => {
  it('links the sender to the contact the code was made for, without a ticket, an ack or a model', async () => {
    const userId = newUser();
    // The customer wrote before: an unverified contact and a ticket in the placeholder organization.
    const first = await receive(lineEvent(userId, { type: 'text', text: 'ขอความช่วยเหลือ' }));
    await settled(first);
    const ticketId = (await messageFor(first))?.ticketId ?? '';
    // Let the first acknowledgment finish, so the count below is about the link message only.
    await waitFor('the first ack', async () =>
      (await deliveriesOf(ticketId)).find((row) => row.state === 'sent'),
    );
    const [org] = await owner()
      .insert(schema.organization)
      .values({ name: `Acme ${prefix}` })
      .returning();
    const [known] = await owner()
      .insert(schema.contact)
      .values({
        orgId: org?.id ?? '',
        name: 'Known',
        emails: [`${randomUUID()}@acme.example.test`],
      })
      .returning();
    const [staff] = await owner()
      .insert(schema.users)
      .values({ email: `${randomUUID()}@example.test`, name: 'Staff', role: 'agent' })
      .returning({ id: schema.users.id });
    const domain = createDomain({
      ticketKeyPrefix: config.TICKET_KEY_PREFIX,
      sealKey: randomBytes(32),
    });
    const database = createDatabase({
      url: testDb.appUrl,
      max: 2,
      applicationName: 'wt-line-code',
    });
    let code: string;
    try {
      const issued = await database.db.transaction((tx) =>
        domain.identity.issueLineLinkCode(
          tx,
          domain.context({ actor: { type: 'user', id: staff?.id ?? null } }),
          { contactId: known?.id ?? '' },
        ),
      );
      code = issued.value.code;
    } finally {
      await database.close();
    }
    classifierSeen.length = 0;
    const repliesBefore = fakeLine.replies.length;
    const ticketsBefore = (await owner().select({ id: schema.ticket.id }).from(schema.ticket))
      .length;
    const linkEvent = await receive(lineEvent(userId, { type: 'text', text: code.toLowerCase() }));
    const row = await settled(linkEvent);
    expect(row.status).toBe('processed');

    const [contact] = await owner()
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.id, known?.id ?? ''));
    expect(contact).toMatchObject({ lineUserId: userId });
    // A staff-issued code links the account but does not verify it.
    expect(contact).toMatchObject({ lineLinkedVia: 'staff_code', lineVerifiedAt: null });
    const [ticket] = await owner()
      .select()
      .from(schema.ticket)
      .where(eq(schema.ticket.id, ticketId));
    expect(ticket).toMatchObject({ requesterContactId: known?.id, orgId: org?.id });
    expect((await owner().select({ id: schema.ticket.id }).from(schema.ticket)).length).toBe(
      ticketsBefore,
    );
    expect(await messageFor(linkEvent)).toBeUndefined();

    // The code never reached a model, an acknowledgment, the logs of the ticket, or object storage.
    expect(classifierSeen.join('\n')).not.toContain(parseLinkCode(code) ?? 'x');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fakeLine.replies).toHaveLength(repliesBefore);
    const audit = await owner()
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, AUDIT_ACTIONS.lineLinked),
          eq(schema.auditLog.targetId, known?.id ?? ''),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(userId);
    const rawKey = row.rawObjectKey;
    expect(rawKey).not.toBeNull();
    const raw = Buffer.from((await store.get(rawKey ?? '')) ?? []).toString('utf8');
    expect(raw).not.toContain(code);
    expect(raw).toContain('[link code]');

    // The next message from this LINE user lands on the known contact's side.
    const next = await receive(lineEvent(userId, { type: 'text', text: 'ยังไม่หาย' }));
    await settled(next);
    expect((await messageFor(next))?.ticketId).toBe(ticketId);
  });

  it('treats a code that does not work as an ordinary message', async () => {
    const userId = newUser();
    const eventId = await receive(lineEvent(userId, { type: 'text', text: 'WT-ZZZZZ-ZZZZZ' }));
    await settled(eventId);
    const message = await messageFor(eventId);
    expect(message?.disposition).toBe('ticket');
    // A code that matched the shape is never stored as text, working or not (C-3).
    expect(message?.bodyText).toBe('[link code]');
    expect(message?.bodyText).not.toContain('ZZZZZ');
    const [contact] = await owner()
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.lineUserId, userId));
    expect(contact?.verifiedAt).toBeNull();
    expect(contact?.lineLinkedVia).toBeNull();
  });

  it('does not keep a still-valid code in the ticket when the link is refused (C-1, C-3)', async () => {
    const userId = newUser();
    // A contact that staff created in a real organization with this LINE id, and one of its tickets.
    const [orgB] = await owner()
      .insert(schema.organization)
      .values({ name: `B ${prefix}` })
      .returning();
    const [holder] = await owner()
      .insert(schema.contact)
      .values({
        orgId: orgB?.id ?? '',
        name: 'B person',
        emails: [`${randomUUID()}@b.example.test`],
        lineUserId: userId,
      })
      .returning();
    const [ticketB] = await owner()
      .insert(schema.ticket)
      .values({ subject: 'B ticket', orgId: orgB?.id ?? '', requesterContactId: holder?.id })
      .returning();
    const [orgA] = await owner()
      .insert(schema.organization)
      .values({ name: `A ${prefix}` })
      .returning();
    const [target] = await owner()
      .insert(schema.contact)
      .values({
        orgId: orgA?.id ?? '',
        name: 'A person',
        emails: [`${randomUUID()}@a.example.test`],
      })
      .returning();
    const database = createDatabase({ url: testDb.appUrl, max: 2, applicationName: 'wt-line-c1' });
    let code: string;
    try {
      const domain = createDomain({
        ticketKeyPrefix: config.TICKET_KEY_PREFIX,
        sealKey: randomBytes(32),
      });
      const issued = await database.db.transaction((tx) =>
        domain.identity.issueLineLinkCode(
          tx,
          domain.context({ actor: { type: 'system', id: null } }),
          {
            contactId: target?.id ?? '',
          },
        ),
      );
      code = issued.value.code;
    } finally {
      await database.close();
    }
    const eventId = await receive(lineEvent(userId, { type: 'text', text: code }));
    await settled(eventId);
    const message = await messageFor(eventId);
    expect(message?.bodyText).toBe('[link code]');
    const allBodies = await owner().select({ body: schema.message.bodyText }).from(schema.message);
    expect(JSON.stringify(allBodies)).not.toContain(code);
    expect(classifierSeen.join('\n')).not.toContain(code);
    // The org-B contact and ticket are untouched; the code was not used.
    const [after] = await owner()
      .select()
      .from(schema.ticket)
      .where(eq(schema.ticket.id, ticketB?.id ?? ''));
    expect(after).toMatchObject({ orgId: orgB?.id, requesterContactId: holder?.id });
    const [unlinked] = await owner()
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.id, target?.id ?? ''));
    expect(unlinked?.lineUserId).toBeNull();
  });
});

describe('LINE events that fail for good (C-4)', () => {
  it('keeps neither the reply token nor a link code in the payload', async () => {
    const code = 'WT-ABCDE-FGHJK';
    const token = `tok-${randomBytes(8).toString('hex')}`;
    // Not a valid event (a user source without a user id): a permanent failure.
    const bad = {
      ...lineEvent(newUser(), { type: 'text', text: code }),
      source: { type: 'user' },
      replyToken: token,
    };
    const eventId = await receive(bad);
    const row = await settled(eventId);
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('line_invalid_event');
    const payload = JSON.stringify(row.payload);
    expect(payload).not.toContain(token);
    expect(payload).not.toContain(code);
    // What a person needs to look at is still there.
    expect(payload).toContain(bad.webhookEventId);
  });
});

describe('LINE quota reconcile (R-2.10)', () => {
  it('keeps the larger of the local and the reported usage and takes the limit from LINE', async () => {
    const [account] = await owner()
      .insert(schema.channelAccount)
      .values({ type: 'line', name: 'Second OA' })
      .returning();
    const accountId = account?.id ?? '';
    const period = line.quotaPeriod(new Date());
    await owner()
      .insert(schema.channelQuotaUsage)
      .values({ channelAccountId: accountId, period, used: 100, quotaLimit: 300 });
    const remote = new line.FakeLineTransport({ monthlyLimit: 500 });
    remote.addExternalConsumption(40);
    const database = createDatabase({
      url: testDb.appUrl,
      max: 2,
      applicationName: 'wt-line-reconcile',
    });
    try {
      const reconcile = createQuotaReconciler({
        database,
        transportFor: (candidate) => (candidate.id === accountId ? remote : undefined),
        logger: createLogger(config),
      });
      const result = await reconcile();
      // The other LINE account of this database has no transport: skipped, not failed.
      expect(result).toMatchObject({ reconciled: 1, failed: 0 });
      let [row] = await owner()
        .select()
        .from(schema.channelQuotaUsage)
        .where(eq(schema.channelQuotaUsage.channelAccountId, accountId));
      expect(row).toMatchObject({ used: 100, quotaLimit: 500 });
      expect(row?.reconciledAt).not.toBeNull();

      remote.addExternalConsumption(200);
      await reconcile();
      [row] = await owner()
        .select()
        .from(schema.channelQuotaUsage)
        .where(eq(schema.channelQuotaUsage.channelAccountId, accountId));
      expect(row?.used).toBe(240);
      const audit = await owner()
        .select()
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.action, AUDIT_ACTIONS.lineQuotaReconciled),
            eq(schema.auditLog.targetId, accountId),
          ),
        );
      expect(audit).toHaveLength(2);
    } finally {
      await database.close();
    }
  });

  it('survives an account that LINE refuses and goes on with the others', async () => {
    const [account] = await owner()
      .insert(schema.channelAccount)
      .values({ type: 'line', name: 'Third OA' })
      .returning();
    const broken = new line.FakeLineTransport();
    broken.failNext(
      'message.quota',
      new ChannelError({ provider: 'line', operation: 'message.quota', kind: 'auth', status: 401 }),
    );
    const database = createDatabase({
      url: testDb.appUrl,
      max: 2,
      applicationName: 'wt-line-reconcile2',
    });
    try {
      const result = await createQuotaReconciler({
        database,
        transportFor: (candidate) => (candidate.id === account?.id ? broken : undefined),
        logger: createLogger(config),
      })();
      expect(result.failed).toBe(1);
    } finally {
      await database.close();
    }
  });
});
