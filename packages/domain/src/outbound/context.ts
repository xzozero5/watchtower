import { schema } from '@watchtower/db';
import { and, desc, eq, inArray, like } from 'drizzle-orm';

import type { ContactRow, MessageRow, OutboundDeliveryRow, TicketRow } from '../rows.js';
import type { ReadExecutor } from '../types.js';

/**
 * Everything the worker needs to build the provider call for one delivery: the message, the ticket,
 * the account, the person we write to and the mail we answer. The domain reads it (it knows the
 * tables); the worker turns it into a Gmail or LINE request (it knows the adapters).
 */
export interface ParentMail {
  /** Normalised RFC 5322 Message-ID of the mail being answered. */
  readonly rfc822MessageId: string | null;
  readonly subject: string;
  readonly fromAddress: string | null;
  readonly fromName: string | null;
  /** Chronological, oldest first, as `References` wants them. */
  readonly references: readonly string[];
}

export interface DeliveryContext {
  readonly ticket: TicketRow;
  readonly message: MessageRow;
  readonly account: { readonly id: string; readonly type: string; readonly name: string };
  readonly requester: ContactRow | null;
  /** The newest customer mail on the ticket; null for a ticket that did not start from mail. */
  readonly parent: ParentMail | null;
  /** The Gmail thread of the conversation (`gmail:<id>` without the prefix), if the ticket has one. */
  readonly gmailThreadId: string | null;
  /** LINE: the user, group or room the conversation is with (`line:<id>` thread key). */
  readonly lineConversationId: string | null;
}

function referencesOf(candidates: unknown): string[] {
  if (!Array.isArray(candidates)) return [];
  const values: string[] = [];
  for (const candidate of candidates as unknown[]) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const { kind, value } = candidate as { kind?: unknown; value?: unknown };
    if (kind === 'references' && typeof value === 'string') values.push(value);
  }
  // The adapter lists them newest first; the header wants oldest first.
  return values.reverse();
}

/** Null when the message, the ticket or the account no longer exists. */
export async function loadDeliveryContext(
  db: ReadExecutor,
  delivery: Pick<OutboundDeliveryRow, 'messageId' | 'ticketId' | 'channelAccountId'>,
): Promise<DeliveryContext | null> {
  const [message] = await db
    .select()
    .from(schema.message)
    .where(eq(schema.message.id, delivery.messageId))
    .limit(1);
  const [ticket] = await db
    .select()
    .from(schema.ticket)
    .where(eq(schema.ticket.id, delivery.ticketId))
    .limit(1);
  const [account] = await db
    .select({
      id: schema.channelAccount.id,
      type: schema.channelAccount.type,
      name: schema.channelAccount.name,
    })
    .from(schema.channelAccount)
    .where(eq(schema.channelAccount.id, delivery.channelAccountId))
    .limit(1);
  if (message === undefined || ticket === undefined || account === undefined) return null;

  const requester =
    ticket.requesterContactId === null
      ? null
      : ((
          await db
            .select()
            .from(schema.contact)
            .where(eq(schema.contact.id, ticket.requesterContactId))
            .limit(1)
        )[0] ?? null);

  const [parentRow] = await db
    .select()
    .from(schema.inboundMessage)
    .where(
      and(
        eq(schema.inboundMessage.ticketId, ticket.id),
        eq(schema.inboundMessage.channelAccountId, account.id),
        inArray(schema.inboundMessage.disposition, ['ticket', 'appended']),
      ),
    )
    .orderBy(desc(schema.inboundMessage.receivedAt))
    .limit(1);

  const threadOf = async (prefix: string): Promise<string | null> => {
    const [row] = await db
      .select({ threadKey: schema.message.threadKey })
      .from(schema.message)
      .where(
        and(eq(schema.message.ticketId, ticket.id), like(schema.message.threadKey, `${prefix}%`)),
      )
      .orderBy(desc(schema.message.createdAt))
      .limit(1);
    return row?.threadKey?.slice(prefix.length) ?? null;
  };

  return {
    ticket,
    message,
    account,
    requester,
    parent:
      parentRow === undefined
        ? null
        : {
            rfc822MessageId: parentRow.rfc822MessageId,
            subject: parentRow.subject,
            fromAddress: parentRow.fromAddress,
            fromName: parentRow.fromName,
            references: referencesOf(parentRow.threadCandidates),
          },
    gmailThreadId: account.type === 'gmail' ? await threadOf('gmail:') : null,
    lineConversationId: account.type === 'line' ? await threadOf('line:') : null,
  };
}
