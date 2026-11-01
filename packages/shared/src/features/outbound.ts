/**
 * Outbound delivery (T-122d, ADR-010): this feature's own audit actions, ticket event types and queue names (T-123a).
 *
 * The task that owns this feature adds entries here and nowhere else in `packages/shared`. The
 * global `AUDIT_ACTIONS`, `TICKET_EVENT_TYPES` and `QUEUE_NAMES` are composed from these records
 * (see `./index.ts`), and importing `@watchtower/shared` throws if two features use the same key
 * or the same value. Keys are camelCase; values are lowercase strings (dotted for audit actions and
 * ticket events, the BullMQ queue name for queues). Start a value with the feature name so
 * collisions are unlikely.
 */
import { z } from 'zod';

/** Audit `action` strings written by this feature. Metadata never holds a body, a token or a raw header. */
export const OUTBOUND_AUDIT_ACTIONS = {
  /** A message was queued for delivery (origin, route, hold, approver, draft id; no text). */
  outboundScheduled: 'outbound.scheduled',
  /** A person undid a send inside the hold window. */
  outboundCancelled: 'outbound.cancelled',
  /** The provider accepted the message. */
  outboundSent: 'outbound.sent',
  /** Delivery ended without the provider accepting it (or with an unknown outcome). */
  outboundFailed: 'outbound.failed',
  /** The policy gate or the content check refused a send (N3). The gate also writes `autonomy.policy_denied`. */
  outboundPolicyDenied: 'outbound.policy_denied',
  /** The instance setting for the undo-send hold changed. */
  outboundSettingSet: 'outbound.setting_set',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const OUTBOUND_TICKET_EVENTS = {
  /** A reply never reached the customer (staff see a Retry bar, ADR-010 section 7). */
  messageDeliveryFailed: 'message.delivery_failed',
  /** A reply was undone before it was sent. */
  messageSendCancelled: 'message.send_cancelled',
} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: api, consumer: worker). */
export const OUTBOUND_QUEUES = {
  /** Triggers and housekeeping of `outbound_delivery`. The table is the source of truth, not the queue. */
  outbound: 'outbound',
} as const satisfies Record<string, string>;

export const OUTBOUND_JOBS = {
  /** Try to send one delivery. A repeat, or a job for a delivery no longer `scheduled`, does nothing. */
  dispatch: 'dispatch',
  /** Recover stuck `sending` rows and re-trigger overdue `scheduled` ones. */
  sweep: 'sweep',
} as const;

export const dispatchJobSchema = z.object({ deliveryId: z.uuid() });
export type DispatchJob = z.infer<typeof dispatchJobSchema>;

/** The trigger is only a nudge (the row decides), so BullMQ retries are cheap and safe. */
export const OUTBOUND_DISPATCH_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

// --- vocabulary shared by the domain, the api and the UI (ADR-010) ---

export const DELIVERY_STATES = ['scheduled', 'sending', 'sent', 'failed', 'cancelled'] as const;
export const deliveryStateSchema = z.enum(DELIVERY_STATES);
export type DeliveryState = z.infer<typeof deliveryStateSchema>;

/**
 * Where a delivery comes from. `ai_auto` is not here on purpose: Phase 1 has no path for an AI to
 * send on its own (N3), so the table refuses such a row (CHECK) as well as the gate. Phase 3 widens
 * this with its own ADR and migration.
 */
export const DELIVERY_ORIGINS = ['human', 'ai_approved', 'system_template'] as const;
export type DeliveryOrigin = (typeof DELIVERY_ORIGINS)[number];

export const DELIVERY_CHANNELS = ['gmail', 'line'] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

export const DELIVERY_ROUTES = ['line_reply', 'line_push', 'gmail_thread', 'gmail_new'] as const;
export type DeliveryRoute = (typeof DELIVERY_ROUTES)[number];

/** Undo-send hold, in seconds (UI spec section 17 Q1): the instance setting is 0-30, default 5. */
export const UNDO_SEND_MIN_SECONDS = 0;
export const UNDO_SEND_MAX_SECONDS = 30;
export const UNDO_SEND_DEFAULT_SECONDS = 5;
export const UNDO_SEND_SETTING_KEY = 'outbound.undo_send_seconds';

/** Automatic attempts before a delivery is `failed` (ADR-010 section 6). */
export const DELIVERY_MAX_ATTEMPTS = 5;
export const DELIVERY_BACKOFF_CAP_SECONDS = 300;
/** A `sending` row older than this lease is stuck (the worker died or hung). */
export const DELIVERY_LEASE_SECONDS = 120;
/**
 * How long a delivery may keep being retried with the same LINE retry key (`X-Line-Retry-Key` = the
 * delivery id). LINE remembers a key for 24 hours `[VERIFY]`; past that a repeat could be sent twice,
 * so the sweeper and the dispatcher stop with `outcome_unknown` well before. 20 hours `[ASSUMED]`;
 * the domain option `retryKeyMaxAgeSeconds` overrides it.
 */
export const DELIVERY_RETRY_KEY_MAX_AGE_SECONDS = 20 * 3600;

/** What the UI needs to draw the Undo toast and the delivery state of a reply (staff only). */
export const deliverySummarySchema = z.object({
  id: z.uuid(),
  state: deliveryStateSchema,
  origin: z.enum(DELIVERY_ORIGINS),
  channel: z.enum(DELIVERY_CHANNELS),
  /** When the message is sent (the end of the undo window); moves on a retry with backoff. */
  sendAt: z.iso.datetime(),
  /** True while Undo still works: `scheduled` and `sendAt` is in the future. */
  cancellable: z.boolean(),
  attempts: z.number().int().nonnegative(),
  /** Stable code (`channel_auth`, `quota_exhausted`, `policy_denied`, ...); null unless failed or cancelled by the system. */
  errorCode: z.string().nullable(),
  /** The provider may have sent it although we got no answer: a Retry may duplicate it. */
  outcomeUnknown: z.boolean(),
  sentAt: z.iso.datetime().nullable(),
});
export type DeliverySummary = z.infer<typeof deliverySummarySchema>;

export const deliveryParamSchema = z.object({
  id: z.string().trim().min(1).max(64),
  deliveryId: z.uuid(),
});
export type DeliveryParam = z.infer<typeof deliveryParamSchema>;

export const cancelSendResultSchema = z.object({
  delivery: deliverySummarySchema,
  /** The message stays in the timeline, marked `cancelled`, so staff can see what was undone. */
  messageId: z.uuid(),
  deliveryStatus: z.literal('cancelled'),
});
export type CancelSendResult = z.infer<typeof cancelSendResultSchema>;

export const outboundSettingsSchema = z.object({
  /** Seconds a staff reply waits before it is sent, so it can be undone. 0 sends at once. */
  undoSendSeconds: z.number().int().min(UNDO_SEND_MIN_SECONDS).max(UNDO_SEND_MAX_SECONDS),
});
export type OutboundSettings = z.infer<typeof outboundSettingsSchema>;
