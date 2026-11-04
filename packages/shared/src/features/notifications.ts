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
  webPushSubscribed: 'notification.web_push.subscribed',
  webPushUnsubscribed: 'notification.web_push.unsubscribed',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const NOTIFICATIONS_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: the outbox, consumer: worker). */
export const NOTIFICATIONS_QUEUES = {
  /** One job per (notification, browser subscription): the worker encrypts and sends one Web Push message. */
  webPush: 'notifications-web-push',
} as const satisfies Record<string, string>;

export const NOTIFICATIONS_JOBS = {
  webPush: 'send',
} as const;

/**
 * What a notification is about.
 *  - `ticket.p1`: a P1 ticket was created or raised to P1 (sticky banner until read);
 *  - `ticket.assigned`: a ticket was handed to you by someone else;
 *  - `shift.handoff_overdue`, `shift.no_show`: for leads (R-7.3, AC-7), raised from the shift overview;
 *  - `alert.fired`: an alert needs you (first step of its escalation policy: you are on shift);
 *  - `alert.escalated`: nobody acknowledged an alert in time and it reached you (lead or head);
 *  - `ops.*` (T-176): the system itself needs the head: the mail server refused our login, the
 *    instance-wide upload cap is full, outbox rows were given up on. At most one per kind per hour.
 */
export const NOTIFICATION_KINDS = [
  'ticket.p1',
  'ticket.assigned',
  'ticket.escalation_requested',
  'shift.handoff_overdue',
  'shift.no_show',
  'alert.fired',
  'alert.escalated',
  'ops.smtp_auth_failed',
  'ops.upload_quota_global',
  'ops.outbox_dead',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);

/** Kinds about the system, not a ticket. Sent to heads only (T-176), at most once an hour per kind. */
export const OPS_NOTIFICATION_KINDS = [
  'ops.smtp_auth_failed',
  'ops.upload_quota_global',
  'ops.outbox_dead',
] as const satisfies readonly NotificationKind[];
export type OpsNotificationKind = (typeof OPS_NOTIFICATION_KINDS)[number];
/** One system notice per kind per this many seconds, however often the fault repeats. */
export const OPS_NOTIFICATION_EVERY_SECONDS = 3600;

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

/**
 * Web Push (T-105, live; RFC 8030, VAPID RFC 8292, message encryption RFC 8291).
 *
 * The message carries a kind, a severity and an in-app link only (ids, no customer text, no subject): the
 * content is fetched after the app opens. `url` is a path on the app's own origin, never a full URL.
 */
export const webPushPayloadSchema = z.object({
  v: z.literal(1),
  kind: notificationKindSchema,
  severity: notificationSeveritySchema,
  /** Which notification: lets the service worker and the app find it. */
  notificationId: z.uuid(),
  /** In-app path starting with a single `/`, same origin only. */
  url: z
    .string()
    .max(200)
    .regex(/^\/(?!\/)[A-Za-z0-9/_\-.?=&%]*$/),
});
export type WebPushPayload = z.infer<typeof webPushPayloadSchema>;

/** The job on `QUEUE_NAMES.webPush`: ids only. */
export const webPushJobSchema = z.object({
  notificationId: z.uuid(),
  subscriptionId: z.uuid(),
});
export type WebPushJob = z.infer<typeof webPushJobSchema>;

/** A browser's `PushSubscription.toJSON()`: what `POST /v1/notifications/push/subscriptions` takes. */
export const webPushSubscribeSchema = z.object({
  endpoint: z.string().max(2048),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{20,30}$/),
  }),
  userAgent: z.string().max(300).optional(),
});
export type WebPushSubscribe = z.infer<typeof webPushSubscribeSchema>;

export const webPushUnsubscribeSchema = z.object({ endpoint: z.string().max(2048) });
export type WebPushUnsubscribe = z.infer<typeof webPushUnsubscribeSchema>;

/**
 * Whether Web Push is on for this instance and the public key to subscribe with. `publicKey` is null when it
 * is off (no complete VAPID credential). `subscribed` counts the caller's own browsers; endpoints are never returned.
 */
export const webPushStatusSchema = z.object({
  enabled: z.boolean(),
  publicKey: z.string().nullable(),
  subscribed: z.number().int().min(0),
});
export type WebPushStatus = z.infer<typeof webPushStatusSchema>;

/** TTL, urgency and topic of a push message by severity (RFC 8030): a critical alert is worth waking a phone for. */
export function webPushDelivery(
  kind: NotificationKind,
  severity: NotificationSeverity,
): { readonly ttlSeconds: number; readonly urgency: 'high' | 'normal'; readonly topic: string } {
  return {
    ttlSeconds: severity === 'critical' ? 4 * 3600 : severity === 'high' ? 3600 : 900,
    urgency: severity === 'normal' ? 'normal' : 'high',
    // A newer alert of the same kind replaces one still waiting for an offline browser.
    topic: `wt-${kind.replace(/[^A-Za-z0-9]/g, '_')}`.slice(0, 32),
  };
}

/**
 * Options of a Web Push job: retry with a growing wait (429, 5xx, a push service that is down), give up
 * after 6 tries. A finished job is removed at once: the message is kept nowhere but the push service.
 */
export const WEB_PUSH_JOB_OPTIONS = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  removeOnFail: { age: 24 * 3600 },
} as const;
