import type { schema } from '@watchtower/db';
import { AUDIT_ACTIONS, type Note, type Reply } from '@watchtower/shared';

import { recordAuditInTx } from '../audit.js';
import { findOrCreateContactByEmailIn } from '../contacts.js';
import { badRequest, notFound, ticketNotOpen } from '../errors.js';
import { requireCustomerSend } from '../policy.js';
import type { MessageRow, TicketRow } from '../rows.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import { applyStatus } from './status.js';
import {
  insertMessage,
  lockTicketRow,
  messageEvent,
  replyDeliveryStatus,
  ticketEvent,
  ticketKeysOf,
  type Sender,
} from './support.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReplyInput {
  /** A ticket id or key (`OPS-12`). */
  readonly ref: string;
  readonly reply: Reply;
  readonly sender: Sender;
}

export interface NoteInput {
  /** A ticket id or key (`OPS-12`). */
  readonly ref: string;
  readonly note: Note;
  readonly sender: { readonly userId: string };
}

export interface MessageResult {
  readonly message: MessageRow;
  readonly ticket: TicketRow;
}

/**
 * A public reply. Staff answer the customer (outbound; counts as the first response); a client
 * writes on a ticket of their own organization (inbound), which is also how a customer's message
 * is appended to an existing ticket. A customer's reply restarts a ticket that waits on the
 * customer and reopens one resolved within `reopenWindowDays` (R-1.10).
 *
 * A reply written by the AI (`ctx.actor.type === 'ai'`) goes to the customer, so it asks the
 * policy gate first and is refused when there is no gate (N3, fail closed).
 */
export async function replyToTicket(
  tx: DbTransaction,
  ctx: DomainContext,
  input: ReplyInput,
): Promise<DomainResult<MessageResult>> {
  const fx = new Effects();
  const { reply: body, sender } = input;
  let ticket = await lockTicketRow(tx, ctx, input.ref);
  const fromCustomer = sender.kind !== 'staff';
  if (sender.kind !== 'staff' && ticket.orgId !== sender.orgId) throw notFound('No such ticket');
  if (sender.kind === 'contact' && ticket.requesterContactId !== sender.contactId) {
    throw notFound('No such ticket');
  }
  if (fromCustomer && body.setStatus !== undefined) {
    throw badRequest('A client cannot set the status');
  }
  if (ticket.status === 'merged') {
    throw ticketNotOpen('This ticket was merged into another; reply there');
  }
  if (ticket.status === 'closed') {
    throw ticketNotOpen('This ticket is closed; open a new one');
  }
  const now = ctx.now();
  const windowDays = ctx.config.reopenWindowDays;
  if (
    fromCustomer &&
    ticket.status === 'resolved' &&
    (ticket.resolvedAt === null ||
      now.getTime() - ticket.resolvedAt.getTime() > windowDays * DAY_MS)
  ) {
    throw ticketNotOpen(
      `This ticket was resolved more than ${String(windowDays)} days ago; open a new one`,
    );
  }
  if (!fromCustomer && ctx.actor.type === 'ai') {
    await requireCustomerSend(ctx, {
      ticketId: ticket.id,
      channel: ticket.channel,
      intentId: ticket.intentId,
      actor: ctx.actor,
    });
  }

  let contactId: string | null = null;
  if (sender.kind === 'client') {
    contactId = (
      await findOrCreateContactByEmailIn(tx, ctx, fx, {
        orgId: ticket.orgId,
        email: sender.email,
        name: sender.name,
      })
    ).id;
  } else if (sender.kind === 'contact') {
    contactId = sender.contactId;
  }

  const set: Partial<typeof schema.ticket.$inferInsert> = { updatedAt: now };
  const firstResponse = sender.kind === 'staff' && ticket.firstRespondedAt === null;
  if (firstResponse) set.firstRespondedAt = now;
  const { message, touched } = await insertMessage(
    tx,
    {
      ticketId: ticket.id,
      channelAccountId: ticket.channelAccountId,
      direction: fromCustomer ? 'inbound' : 'outbound',
      senderUserId: sender.kind === 'contact' ? null : sender.userId,
      senderContactId: contactId,
      bodyText: body.body,
      visibility: 'public',
      deliveryStatus: replyDeliveryStatus(sender.kind, ticket.channel),
      createdAt: now,
    },
    set,
  );
  if (!touched) throw notFound('No such ticket');
  ticket = touched;

  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.ticketReply,
    targetType: 'ticket',
    targetId: ticket.id,
    metadata: {
      messageId: message.id,
      direction: message.direction,
      firstResponse,
    },
  });
  fx.emit(messageEvent(ctx, ticket, message));
  if (firstResponse) fx.emit(ticketEvent(ctx, 'ticket.updated', ticket, ['sla']));

  if (fromCustomer) {
    // The customer answered: the clock restarts, and a ticket resolved in the window reopens.
    if (ticket.status === 'waiting_on_customer' || ticket.status === 'resolved') {
      ticket = await applyStatus(tx, ctx, fx, ticket, 'open', {
        reason: 'customer_reply',
        automatic: true,
      });
    }
  } else if (body.setStatus !== undefined && body.setStatus !== ticket.status) {
    // "Reply and set status" (R-1.4). An invalid transition fails the whole request: the reply is not sent.
    ticket = await applyStatus(tx, ctx, fx, ticket, body.setStatus, { silent: true });
  }
  // One email for the reply, which also carries the status the ticket ended up in.
  if (sender.kind === 'staff') {
    await ctx.notifier.staffReply(tx, ticket, ticketKeysOf(ctx).format(ticket.number), message);
  }
  return fx.result({ message, ticket });
}

/** An internal note: staff only, never sent, never visible to a client. */
export async function addTicketNote(
  tx: DbTransaction,
  ctx: DomainContext,
  input: NoteInput,
): Promise<DomainResult<MessageResult>> {
  const fx = new Effects();
  const ticket = await lockTicketRow(tx, ctx, input.ref);
  if (ticket.status === 'merged') {
    throw ticketNotOpen('This ticket was merged into another; write the note there');
  }
  const now = ctx.now();
  const { message, touched } = await insertMessage(
    tx,
    {
      ticketId: ticket.id,
      channelAccountId: ticket.channelAccountId,
      direction: 'internal',
      senderUserId: input.sender.userId,
      bodyText: input.note.body,
      visibility: 'internal',
      deliveryStatus: 'not_applicable',
      createdAt: now,
    },
    { updatedAt: now },
  );
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.ticketNote,
    targetType: 'ticket',
    targetId: ticket.id,
    metadata: { messageId: message.id },
  });
  // The event says an internal note exists; the realtime filter keeps it from every client.
  fx.emit(messageEvent(ctx, ticket, message));
  return fx.result({ message, ticket: touched ?? ticket });
}
