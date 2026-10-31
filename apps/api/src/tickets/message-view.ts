import type { schema } from '@watchtower/db';
import { type ChannelType, type Message, type TimelineEntry } from '@watchtower/shared';

export type MessageRow = typeof schema.message.$inferSelect;
export type TicketEventRow = typeof schema.ticketEvent.$inferSelect;

export type Audience = 'staff' | 'client';

export interface MessageContext {
  /** The display key of the ticket, `OPS-1234` with this instance's prefix. */
  readonly ticketKey: string;
  readonly channel: ChannelType;
  /** Name of `sender_user_id`, when the message has one. */
  readonly senderUserName: string | null;
  /** Role of `sender_user_id`; a client only learns who a staff sender is when this is `client`. */
  readonly senderUserRole: string | null;
  readonly senderContactName: string | null;
  readonly audience: Audience;
}

/**
 * A message as the API returns it. For a client, a staff member is shown without name or id (the
 * UI says "Support"): customers see that the support team answered, not which employee, and staff
 * ids are never handed to a client. People of the client's own organization keep their names.
 */
export function toMessage(row: MessageRow, context: MessageContext): Message {
  let sender: Message['sender'];
  if (row.senderUserId !== null) {
    const hidden = context.audience === 'client' && context.senderUserRole !== 'client';
    sender = {
      type: 'user',
      id: hidden ? null : row.senderUserId,
      name: hidden ? null : context.senderUserName,
    };
  } else if (row.senderContactId !== null) {
    sender = { type: 'contact', id: row.senderContactId, name: context.senderContactName };
  } else {
    sender = { type: 'system', id: null, name: null };
  }
  return {
    id: row.id,
    ticketId: row.ticketId,
    ticketKey: context.ticketKey,
    channel: context.channel,
    direction: row.direction as Message['direction'],
    visibility: row.visibility as Message['visibility'],
    sender,
    bodyText: row.bodyText,
    deliveryStatus: row.deliveryStatus as Message['deliveryStatus'],
    attachments: (Array.isArray(row.attachments) ? row.attachments : []) as Record<
      string,
      unknown
    >[],
    createdAt: row.createdAt.toISOString(),
  };
}

/** Event payload keys a client may see, per event type. Everything else is staff-only. */
const CLIENT_PAYLOAD_KEYS: Readonly<Record<string, readonly string[]>> = {
  'ticket.status_changed': ['from', 'to'],
  'ticket.merged': ['intoKey'],
  'ticket.created': [],
};

export interface EventContext {
  readonly ticketKey: string;
  readonly actorName: string | null;
  readonly audience: Audience;
}

/**
 * A ticket event as the API returns it. A client sees only the events marked public, only the
 * payload keys listed above (so a staff reason or an internal id never leaves), and no actor.
 */
export function toTimelineEvent(
  row: TicketEventRow,
  context: EventContext,
): Extract<TimelineEntry, { kind: 'event' }> {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const allowed = CLIENT_PAYLOAD_KEYS[row.type] ?? [];
  const visiblePayload =
    context.audience === 'staff'
      ? payload
      : Object.fromEntries(Object.entries(payload).filter(([key]) => allowed.includes(key)));
  const actorType = row.actorType as 'user' | 'system' | 'ai' | 'anonymous';
  return {
    kind: 'event',
    id: row.id,
    ticketId: row.ticketId,
    ticketKey: context.ticketKey,
    type: row.type,
    actor:
      context.audience === 'staff'
        ? { type: actorType, id: row.actorId, name: context.actorName }
        : { type: actorType === 'system' ? 'system' : 'user', id: null, name: null },
    visibility: row.visibility as 'public' | 'internal',
    payload: visiblePayload,
    createdAt: row.createdAt.toISOString(),
  };
}
