import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import {
  isUuid,
  type ChannelType,
  type MessageVisibility,
  type RealtimeEvent,
  type TicketPriority,
  type TicketStatus,
} from '@watchtower/shared';
import { and, eq, sql, type SQL } from 'drizzle-orm';

import { badRequest, notFound } from '../errors.js';
import type { MessageRow, TicketRow } from '../rows.js';
import { TicketKeys } from '../ticket-keys.js';
import type { Actor, DbTransaction, DomainContext } from '../types.js';

/** Who writes a message: a staff member, a signed-in client user, or a requester with a tracking link. */
export type Sender =
  | { readonly kind: 'staff'; readonly userId: string }
  | {
      readonly kind: 'client';
      readonly userId: string;
      readonly orgId: string;
      readonly email: string;
      readonly name: string;
    }
  /**
   * The requester writing through the portal with a tracking link: no account, only the contact the
   * link was issued to. It can answer its own ticket and nobody else's.
   */
  | { readonly kind: 'contact'; readonly contactId: string; readonly orgId: string };

export const ticketKeysOf = (ctx: DomainContext): TicketKeys =>
  new TicketKeys(ctx.config.ticketKeyPrefix);

/**
 * Where a public message stands when it is saved. A reply on the portal is visible to the customer
 * as soon as it is written. Every other channel needs its adapter to send it: `pending` until the
 * outbox of that adapter delivers it. Something the customer wrote has nothing to deliver.
 */
export function replyDeliveryStatus(
  sender: Sender['kind'],
  channel: string,
): 'not_applicable' | 'pending' | 'delivered' {
  if (sender !== 'staff') return 'not_applicable';
  return channel === 'portal' ? 'delivered' : 'pending';
}

/** What an audit entry records about a ticket: ids, status and dates, never the text. */
export function ticketSnapshot(row: TicketRow): Record<string, unknown> {
  return {
    id: row.id,
    number: row.number,
    orgId: row.orgId,
    status: row.status,
    priority: row.priority,
    intentId: row.intentId,
    assigneeId: row.assigneeId,
    queueId: row.queueId,
    slaPolicyId: row.slaPolicyId,
    firstResponseDueAt: row.firstResponseDueAt?.toISOString() ?? null,
    resolutionDueAt: row.resolutionDueAt?.toISOString() ?? null,
    parentTicketId: row.parentTicketId,
  };
}

export function ticketEvent(
  ctx: DomainContext,
  type: 'ticket.created' | 'ticket.updated',
  row: TicketRow,
  changed: string[],
): RealtimeEvent {
  return {
    id: randomUUID(),
    type,
    occurredAt: ctx.now().toISOString(),
    orgId: row.orgId,
    ticketId: row.id,
    ticketKey: ticketKeysOf(ctx).format(row.number),
    data: {
      subject: row.subject,
      status: row.status as TicketStatus,
      priority: row.priority as TicketPriority,
      assigneeId: row.assigneeId,
      queueId: row.queueId,
      changed,
    },
  };
}

export function messageEvent(
  ctx: DomainContext,
  row: TicketRow,
  message: MessageRow,
): RealtimeEvent {
  return {
    id: randomUUID(),
    type: 'message.created',
    occurredAt: ctx.now().toISOString(),
    orgId: row.orgId,
    ticketId: row.id,
    ticketKey: ticketKeysOf(ctx).format(row.number),
    data: {
      messageId: message.id,
      direction: message.direction as 'inbound' | 'outbound' | 'internal',
      visibility: message.visibility as MessageVisibility,
    },
  };
}

/** Appends one row to the ticket's event log (the timeline). */
export async function recordTicketEvent(
  tx: DbTransaction,
  ticketId: string,
  type: string,
  actor: Actor,
  visibility: 'public' | 'internal',
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.insert(schema.ticketEvent).values({
    ticketId,
    type,
    actorType: actor.type,
    actorId: actor.id,
    visibility,
    payload,
  });
}

/**
 * `uuid` or `OPS-1234` (with this instance's prefix) as a WHERE condition on the ticket table. Text
 * that is neither is "no such ticket", never a query: a uuid column would reject it with an error.
 */
export function ticketRefCondition(ref: string, keys: TicketKeys): SQL {
  if (isUuid(ref)) return eq(schema.ticket.id, ref);
  const number = keys.parse(ref);
  if (number === null) throw notFound('No such ticket');
  return eq(schema.ticket.number, number);
}

/** Loads and locks a ticket for the rest of the transaction. */
export async function lockTicketRow(
  tx: DbTransaction,
  ctx: DomainContext,
  ref: string,
): Promise<TicketRow> {
  const [row] = await tx
    .select()
    .from(schema.ticket)
    .where(ticketRefCondition(ref, ticketKeysOf(ctx)))
    .for('update');
  if (!row) throw notFound('No such ticket');
  return row;
}

export async function ticketIdOf(
  tx: DbTransaction,
  ctx: DomainContext,
  ref: string,
): Promise<string> {
  const [row] = await tx
    .select({ id: schema.ticket.id })
    .from(schema.ticket)
    .where(ticketRefCondition(ref, ticketKeysOf(ctx)))
    .limit(1);
  if (!row) throw notFound('No such ticket');
  return row.id;
}

/** The queue named by id, or the default queue when none is named. Null when there is no default. */
export async function resolveQueue(tx: DbTransaction, queueId: string | undefined) {
  const [queue] =
    queueId === undefined
      ? await tx
          .select()
          .from(schema.teamQueue)
          .where(eq(schema.teamQueue.isDefault, true))
          .limit(1)
      : await tx.select().from(schema.teamQueue).where(eq(schema.teamQueue.id, queueId)).limit(1);
  if (queueId !== undefined && !queue) throw badRequest('queueId does not refer to a queue');
  return queue ?? null;
}

export async function channelAccountIdOf(tx: DbTransaction, type: ChannelType): Promise<string> {
  const [account] = await tx
    .select({ id: schema.channelAccount.id })
    .from(schema.channelAccount)
    .where(eq(schema.channelAccount.type, type))
    .limit(1);
  if (account) return account.id;
  if (type !== 'portal') throw badRequest(`No ${type} channel account is configured`);
  // The portal account is created by migration 0002; recreate it if someone removed it.
  await tx
    .insert(schema.channelAccount)
    .values({ type: 'portal', name: 'Client portal' })
    .onConflictDoNothing();
  const [created] = await tx
    .select({ id: schema.channelAccount.id })
    .from(schema.channelAccount)
    .where(eq(schema.channelAccount.type, 'portal'))
    .limit(1);
  if (!created) throw new Error('the portal channel account could not be created');
  return created.id;
}

export async function findByExternalId(
  tx: DbTransaction,
  accountId: string,
  externalId: string,
): Promise<{ ticket: TicketRow; message: MessageRow } | null> {
  const [message] = await tx
    .select()
    .from(schema.message)
    .where(
      and(
        eq(schema.message.channelAccountId, accountId),
        eq(schema.message.externalId, externalId),
      ),
    )
    .limit(1);
  if (!message) return null;
  const [ticket] = await tx
    .select()
    .from(schema.ticket)
    .where(eq(schema.ticket.id, message.ticketId))
    .limit(1);
  return ticket ? { ticket, message } : null;
}

/**
 * When a message happened: the database clock, as on `ticket_event`. The timeline orders the two
 * tables together, and this process does not share a clock with the database. Statement time, so a
 * message stays after the event its transaction opened with.
 */
export const MESSAGE_CLOCK = sql`clock_timestamp()`;

/**
 * Saves a message on a ticket and touches the ticket's `updated_at` (the shared tail of a reply and
 * a note). Returns the message and the ticket row as the update left it.
 */
export async function insertMessage(
  tx: DbTransaction,
  values: typeof schema.message.$inferInsert,
  ticketPatch: Partial<typeof schema.ticket.$inferInsert>,
): Promise<{ message: MessageRow; touched: TicketRow | undefined }> {
  const [message] = await tx
    .insert(schema.message)
    .values({ ...values, createdAt: MESSAGE_CLOCK })
    .returning();
  if (!message) throw new Error('message insert returned no row');
  const [touched] = await tx
    .update(schema.ticket)
    .set(ticketPatch)
    .where(eq(schema.ticket.id, values.ticketId))
    .returning();
  return { message, touched };
}
