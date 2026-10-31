import { randomUUID } from 'node:crypto';

import { gmail } from '@watchtower/channels';
import { enqueueOutbox, schema, type Database } from '@watchtower/db';
import { INBOUND_QUEUES, INGEST_JOBS, INGEST_OUTBOX_JOB_OPTIONS } from '@watchtower/shared';
import { and, eq } from 'drizzle-orm';

/**
 * The fake channel (T-122c): a way to put an inbound message into the system without Gmail or
 * LINE, for e2e tests and a developer's machine. It is NOT an HTTP endpoint (nothing public, nothing
 * to authenticate): a function and a CLI (`pnpm --filter @watchtower/api inbound:fake`) that write
 * what the real webhook receivers (T-102b, T-103b) will write: one `inbound_event` row and one
 * `ingest` outbox job in one transaction. The relay of the worker turns the job into a BullMQ job,
 * and the `ingest` consumer does the rest exactly as it would for a real message.
 *
 * Messages are embedded in the event payload (a raw RFC 5322 mail, a LINE event object); the worker
 * accepts that only outside production.
 */

export type FakeInbound =
  | {
      readonly channel: 'gmail';
      readonly from: string;
      readonly fromName?: string;
      readonly subject: string;
      readonly body: string;
      readonly html?: string;
      /** Gmail thread id. Default: one per call, so each message is its own conversation. */
      readonly threadId?: string;
      /** RFC Message-ID without brackets. Default: random. */
      readonly messageId?: string;
      readonly inReplyTo?: string;
      readonly references?: readonly string[];
      /** Gmail message id, the dedupe key. Default: random. */
      readonly providerMessageId?: string;
      readonly headers?: Readonly<Record<string, string>>;
      /** Shortcuts for the two classes of machine mail. */
      readonly kind?: 'person' | 'auto_reply' | 'newsletter';
    }
  | {
      readonly channel: 'line';
      readonly userId: string;
      readonly text: string;
      /** Defaults to the user id (a one-to-one chat). */
      readonly conversationId?: string;
      /** LINE message id, the dedupe key. Default: random. */
      readonly messageId?: string;
      /** LINE `webhookEventId`. Default: random. */
      readonly webhookEventId?: string;
    };

export interface FakeInboundResult {
  readonly inboundEventId: string;
  readonly channelAccountId: string;
  readonly providerEventId: string;
  /** The same provider event id was enqueued before: nothing new was written. */
  readonly duplicate: boolean;
}

const ACCOUNT_NAME = { gmail: 'Fake Gmail mailbox (test)', line: 'Fake LINE OA (test)' } as const;

const MACHINE_HEADERS = {
  person: {},
  auto_reply: { 'Auto-Submitted': 'auto-replied' },
  newsletter: { 'List-Unsubscribe': '<mailto:unsubscribe@fake.example.test>', Precedence: 'bulk' },
} as const;

async function fakeAccountId(database: Database, channel: 'gmail' | 'line'): Promise<string> {
  const find = async (): Promise<string | undefined> => {
    const [row] = await database.db
      .select({ id: schema.channelAccount.id })
      .from(schema.channelAccount)
      .where(
        and(
          eq(schema.channelAccount.type, channel),
          eq(schema.channelAccount.name, ACCOUNT_NAME[channel]),
        ),
      )
      .limit(1);
    return row?.id;
  };
  const existing = await find();
  if (existing !== undefined) return existing;
  const [created] = await database.db
    .insert(schema.channelAccount)
    .values({ type: channel, name: ACCOUNT_NAME[channel] })
    .returning({ id: schema.channelAccount.id });
  if (!created) throw new Error('channel account insert returned no row');
  return created.id;
}

/** The provider event id and the payload the worker's ingestor reads for this message. */
export function fakePayload(input: FakeInbound): {
  readonly providerEventId: string;
  readonly payload: Record<string, unknown>;
} {
  if (input.channel === 'gmail') {
    const providerMessageId = input.providerMessageId ?? `fake-g-${randomUUID()}`;
    const mime = gmail.buildFakeMime({
      from: input.from,
      ...(input.fromName === undefined ? {} : { fromName: input.fromName }),
      subject: input.subject,
      body: input.body,
      ...(input.html === undefined ? {} : { html: input.html }),
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
      ...(input.references === undefined ? {} : { references: input.references }),
      headers: { ...MACHINE_HEADERS[input.kind ?? 'person'], ...input.headers },
    });
    return {
      providerEventId: providerMessageId,
      payload: {
        id: providerMessageId,
        threadId: input.threadId ?? `fake-t-${randomUUID()}`,
        labelIds: ['INBOX', 'UNREAD'],
        raw: mime.rawBase64Url,
      },
    };
  }
  const webhookEventId =
    input.webhookEventId ?? `01FAKE${randomUUID().replaceAll('-', '').toUpperCase().slice(0, 20)}`;
  return {
    providerEventId: webhookEventId,
    payload: {
      type: 'message',
      mode: 'active',
      timestamp: Date.now(),
      webhookEventId,
      deliveryContext: { isRedelivery: false },
      source: { type: 'user', userId: input.userId },
      replyToken: `fake-reply-${randomUUID()}`,
      message: {
        type: 'text',
        id: input.messageId ?? `fake-l-${randomUUID()}`,
        text: input.text,
      },
    },
  };
}

/**
 * Writes the event and its outbox job in one transaction (what a receiver does). Enqueuing the same
 * provider event id again is a no-op, like a redelivery.
 */
export async function enqueueFakeInbound(
  database: Database,
  input: FakeInbound,
): Promise<FakeInboundResult> {
  const channelAccountId = await fakeAccountId(database, input.channel);
  const { providerEventId, payload } = fakePayload(input);
  return database.db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schema.inboundEvent)
      .values({ channelAccountId, providerEventId, payload })
      .onConflictDoNothing({
        target: [schema.inboundEvent.channelAccountId, schema.inboundEvent.providerEventId],
      })
      .returning({ id: schema.inboundEvent.id });
    if (!inserted) {
      const [existing] = await tx
        .select({ id: schema.inboundEvent.id })
        .from(schema.inboundEvent)
        .where(
          and(
            eq(schema.inboundEvent.channelAccountId, channelAccountId),
            eq(schema.inboundEvent.providerEventId, providerEventId),
          ),
        )
        .limit(1);
      if (!existing) throw new Error('inbound_event vanished after a conflict');
      return { inboundEventId: existing.id, channelAccountId, providerEventId, duplicate: true };
    }
    await enqueueOutbox(tx, {
      queue: INBOUND_QUEUES.ingest,
      jobName: INGEST_JOBS.process,
      jobId: inserted.id,
      payload: { inboundEventId: inserted.id },
      options: { ...INGEST_OUTBOX_JOB_OPTIONS },
    });
    return { inboundEventId: inserted.id, channelAccountId, providerEventId, duplicate: false };
  });
}
