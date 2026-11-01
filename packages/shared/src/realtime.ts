import { z } from 'zod';

import {
  messageDirectionSchema,
  messageVisibilitySchema,
  ticketStatusSchema,
} from './ticketing.js';
import { ticketPrioritySchema } from './sla.js';
import { notificationKindSchema, notificationSeveritySchema } from './features/notifications.js';

/**
 * Realtime contract (PRD section 8.3: updates in under 2 seconds).
 *
 * apps/api publishes a `RealtimeEvent` on a Redis pub/sub channel after the database transaction
 * commits. Every api instance subscribes and pushes the event to the WebSocket clients that may see
 * it. Events carry identifiers and small fields only, never message text: a client that wants the
 * content asks the REST API, which applies the same access rules.
 */

/** WebSocket endpoint of the api. Authenticated by the `wt_at` cookie of the handshake request. */
export const REALTIME_PATH = '/v1/realtime';

/** Redis pub/sub channel the api instances share. */
export const REALTIME_CHANNEL = 'watchtower:realtime';

export const REALTIME_EVENT_TYPES = [
  'ticket.created',
  'ticket.updated',
  'message.created',
  'notification.created',
] as const;
export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

/** Close codes the server uses (4000 to 4999 are application codes). */
export const REALTIME_CLOSE_CODES = {
  /** No valid session, the session ended, or the access token expired: refresh, then reconnect. */
  unauthenticated: 4401,
  /** The caller may not listen to tickets at all. Do not retry. */
  forbidden: 4403,
  /** Too many sockets for this user; the oldest is closed. */
  tooManyConnections: 4429,
} as const;

/** Ticket fields a client may be told changed. */
export const CLIENT_VISIBLE_CHANGES = ['subject', 'status', 'priority', 'intent'] as const;

const base = {
  id: z.uuid(),
  occurredAt: z.iso.datetime(),
  orgId: z.uuid(),
  ticketId: z.uuid(),
  ticketKey: z.string(),
};

export const ticketEventDataSchema = z.object({
  subject: z.string(),
  status: ticketStatusSchema,
  priority: ticketPrioritySchema,
  /** Staff only: dropped before an event goes to a client. */
  assigneeId: z.uuid().nullable().optional(),
  queueId: z.uuid().nullable().optional(),
  /**
   * The channel the ticket came in on (`gmail`, `line`, `portal`...). With `orgId` and `queueId` it
   * lets the "N new" pill count only the tickets that match the filter the agent has on. Staff only.
   */
  channel: z.string().nullable().optional(),
  /** Which fields changed: subject, status, priority, intent, assignee, queue, tags, customFields, sla. */
  changed: z.array(z.string()),
});

export type TicketEventData = z.infer<typeof ticketEventDataSchema>;

export const messageEventDataSchema = z.object({
  messageId: z.uuid(),
  direction: messageDirectionSchema,
  visibility: messageVisibilitySchema,
});

/**
 * A notification for one person (T-105). It is addressed: only `recipientId` hears it, and a client
 * never does. It carries ids and small facts, never text; the center fetches the rest over REST.
 * `orgId`, `queueId` and `channel` are the facets of the ticket it is about (all null for a shift alert).
 */
export const notificationEventSchema = z.object({
  id: z.uuid(),
  type: z.literal('notification.created'),
  occurredAt: z.iso.datetime(),
  recipientId: z.uuid(),
  data: z.object({
    notificationId: z.uuid(),
    kind: notificationKindSchema,
    severity: notificationSeveritySchema,
    orgId: z.uuid().nullable(),
    queueId: z.uuid().nullable(),
    channel: z.string().nullable(),
    ticketId: z.uuid().nullable(),
    ticketKey: z.string().nullable(),
  }),
});
export type NotificationEvent = z.infer<typeof notificationEventSchema>;

export const realtimeEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('ticket.created'), data: ticketEventDataSchema }),
  z.object({ ...base, type: z.literal('ticket.updated'), data: ticketEventDataSchema }),
  z.object({ ...base, type: z.literal('message.created'), data: messageEventDataSchema }),
  notificationEventSchema,
]);
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

/** First frame the server sends, once the socket is subscribed. */
export const realtimeReadySchema = z.object({
  type: z.literal('ready'),
  audience: z.enum(['staff', 'client']),
  /** When the access token behind this socket stops being accepted; the server closes with 4401 then. */
  accessExpiresAt: z.iso.datetime(),
});

export type RealtimeAudience =
  | { readonly kind: 'staff'; readonly userId?: string }
  | { readonly kind: 'client'; readonly orgId: string };

function clientTicketData(data: TicketEventData, changed: string[]): TicketEventData {
  return { subject: data.subject, status: data.status, priority: data.priority, changed };
}

/**
 * What one listener may receive of an event, or null for nothing. This is the single place that
 * decides it, so the rules are tested once:
 *  - staff receive every event;
 *  - a client receives only events of their own organization;
 *  - a client never receives anything about an internal note, and never staff-only fields;
 *  - a notification goes to its recipient alone, never to another staff member, never to a client.
 */
export function realtimeEventFor(
  audience: RealtimeAudience,
  event: RealtimeEvent,
): RealtimeEvent | null {
  if (event.type === 'notification.created') {
    return audience.kind === 'staff' && audience.userId === event.recipientId ? event : null;
  }
  if (audience.kind === 'staff') return event;
  if (event.orgId !== audience.orgId) return null;

  switch (event.type) {
    case 'message.created':
      return event.data.visibility === 'public' ? event : null;
    case 'ticket.created':
      return { ...event, data: clientTicketData(event.data, []) };
    case 'ticket.updated': {
      const changed = event.data.changed.filter((field) =>
        (CLIENT_VISIBLE_CHANGES as readonly string[]).includes(field),
      );
      if (changed.length === 0) return null;
      return { ...event, data: clientTicketData(event.data, changed) };
    }
  }
}
