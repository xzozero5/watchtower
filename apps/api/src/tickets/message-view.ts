import type { schema } from '@watchtower/db';
import { MASKED_ATTACHMENT_NAME } from '../masking/pii-masker.js';
import {
  type ChannelType,
  type DeliverySummary,
  type Message,
  type TimelineEntry,
} from '@watchtower/shared';

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
  /** The delivery behind an outbound reply on Gmail or LINE. Shown to staff only. */
  readonly delivery?: DeliverySummary | null;
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
    ...(context.audience === 'staff' && context.delivery !== undefined
      ? { delivery: context.delivery }
      : {}),
    attachments: viewAttachments(row.attachments, context.audience),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The attachments of a message as the caller may see them. Staff get the stored records. A client
 * gets name, type and size only: the storage key and the content hash stay on the server, and the
 * file itself is fetched through the authorised download route by its position.
 */
export function viewAttachments(value: unknown, audience: Audience): Record<string, unknown>[] {
  const list = (Array.isArray(value) ? value : []) as Record<string, unknown>[];
  if (audience === 'staff') return list;
  return list.map((attachment) => ({
    ...(typeof attachment.filename === 'string' ? { filename: attachment.filename } : {}),
    ...(typeof attachment.contentType === 'string' ? { contentType: attachment.contentType } : {}),
    ...(typeof attachment.size === 'number' ? { size: attachment.size } : {}),
  }));
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

export interface MessageMasker {
  text(value: string): string;
  name(value: string | null): string | null;
}

/** A message as a masked reader gets it (see `maskEntry`). */
export function maskMessage<T extends Message>(message: T, session: MessageMasker): T {
  return {
    ...message,
    bodyText: session.text(message.bodyText),
    sender:
      message.sender.type === 'contact'
        ? { ...message.sender, name: session.name(message.sender.name) }
        : message.sender,
    attachments: message.attachments.map((attachment) => ({
      name: MASKED_ATTACHMENT_NAME,
      ...(typeof attachment.contentType === 'string'
        ? { contentType: attachment.contentType }
        : {}),
      ...(typeof attachment.size === 'number' ? { size: attachment.size } : {}),
    })),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every string of an event payload through the masking session, except ids (a uuid is not text and the
 * redactor would only garble it). Numbers, booleans and structure pass unchanged.
 */
export function maskPayload(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === 'string') return UUID.test(value) ? value : mask(value);
  if (Array.isArray(value)) return value.map((item) => maskPayload(item, mask));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        maskPayload(item, mask),
      ]),
    );
  }
  return value;
}

/**
 * A timeline entry as a masked reader (`dev`, T-137) gets it: message text through the redactor, a
 * customer's name reduced to initials, attachment names and links dropped (a file name is personal data
 * too), event payload strings masked. Staff names stay: they are the colleagues, not the customers.
 */
export function maskEntry(entry: TimelineEntry, session: MessageMasker): TimelineEntry {
  if (entry.kind === 'message') return { ...maskMessage(entry, session), kind: 'message' };
  return {
    ...entry,
    payload: maskPayload(entry.payload, (text) => session.text(text)) as Record<string, unknown>,
  };
}
