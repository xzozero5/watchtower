/**
 * Notifications (T-105): this feature's own audit actions, ticket event types and queue names (T-123a),
 * and the contract of the in-app notification center.
 *
 * Scope of Phase 1 (po, T-011): in-app realtime and the P1 sticky banner. Web Push, the focus-mode
 * digest and sound come after T-113 and are not here.
 *
 * Keys are camelCase; values are lowercase strings. Start a value with the feature name so
 * collisions are unlikely (`assertDisjoint` in `./index.ts` enforces it).
 */
import { z } from 'zod';

import { cursorSchema, pageLimit } from '../common.js';
import { ticketPrioritySchema } from '../sla.js';

/** Audit `action` strings written by this feature. */
export const NOTIFICATIONS_AUDIT_ACTIONS = {
  notificationRead: 'notification.read',
  notificationReadAll: 'notification.read_all',
  notificationPreferencesSet: 'notification.preferences.set',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const NOTIFICATIONS_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: api, consumer: worker). */
export const NOTIFICATIONS_QUEUES = {} as const satisfies Record<string, string>;

/**
 * What a notification is about.
 *  - `ticket.p1`: a P1 ticket was created or raised to P1 (sticky banner until read);
 *  - `ticket.assigned`: a ticket was handed to you by someone else;
 *  - `shift.handoff_overdue`, `shift.no_show`: for leads (R-7.3, AC-7), raised from the shift overview.
 */
export const NOTIFICATION_KINDS = [
  'ticket.p1',
  'ticket.assigned',
  'shift.handoff_overdue',
  'shift.no_show',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);

/** `critical` is what the sticky banner shows. */
export const NOTIFICATION_SEVERITIES = ['critical', 'high', 'normal'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];
export const notificationSeveritySchema = z.enum(NOTIFICATION_SEVERITIES);

/** Kinds a person cannot turn off: missing a P1 is not a preference `[ASSUMED]`. */
export const MANDATORY_NOTIFICATION_KINDS = [
  'ticket.p1',
] as const satisfies readonly NotificationKind[];

export function isMandatoryNotification(kind: NotificationKind): boolean {
  return (MANDATORY_NOTIFICATION_KINDS as readonly NotificationKind[]).includes(kind);
}

/** Kinds that are meant for leads and heads only, whatever a user's preferences say. */
export const LEAD_NOTIFICATION_KINDS = [
  'shift.handoff_overdue',
  'shift.no_show',
] as const satisfies readonly NotificationKind[];

/** Small, non-personal facts a notification shows (counts, ids). Never message text or a name. */
export const notificationDataSchema = z.record(z.string(), z.union([z.string(), z.number()]));

/** The ticket a notification points at, read from the ticket at the time of the request. */
export const notificationTicketSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  subject: z.string(),
  priority: ticketPrioritySchema,
  status: z.string(),
});

export const notificationSchema = z.object({
  id: z.uuid(),
  kind: notificationKindSchema,
  severity: notificationSeveritySchema,
  /** The facets the "N new" pill and the center filter by. */
  orgId: z.uuid().nullable(),
  queueId: z.uuid().nullable(),
  channel: z.string().nullable(),
  ticket: notificationTicketSchema.nullable(),
  data: notificationDataSchema,
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationListQuerySchema = z.object({
  limit: pageLimit(30, 100),
  cursor: cursorSchema.optional(),
  /** `true`: only the unread ones. */
  unread: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

export const notificationPageSchema = z.object({
  items: z.array(notificationSchema),
  /** All unread notifications of the caller, not only those on this page. */
  unreadCount: z.number().int().min(0),
  nextCursor: z.string().nullable(),
});
export type NotificationPage = z.infer<typeof notificationPageSchema>;

export const notificationReadAllResultSchema = z.object({ updated: z.number().int().min(0) });

export const notificationPreferenceSchema = z.object({
  kind: notificationKindSchema,
  inApp: z.boolean(),
  /** True when the preference cannot be turned off. */
  mandatory: z.boolean(),
});

export const notificationPreferencesSchema = z.object({
  preferences: z.array(notificationPreferenceSchema),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const setNotificationPreferencesSchema = z
  .object({
    preferences: z
      .array(z.object({ kind: notificationKindSchema, inApp: z.boolean() }))
      .min(1)
      .max(NOTIFICATION_KINDS.length),
  })
  .refine(
    ({ preferences }) =>
      new Set(preferences.map((entry) => entry.kind)).size === preferences.length,
    { message: 'Each kind may appear once', path: ['preferences'] },
  )
  .refine(
    ({ preferences }) =>
      preferences.every((entry) => entry.inApp || !isMandatoryNotification(entry.kind)),
    { message: 'ticket.p1 cannot be turned off', path: ['preferences'] },
  );
export type SetNotificationPreferences = z.infer<typeof setNotificationPreferencesSchema>;
