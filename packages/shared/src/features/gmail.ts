/**
 * Gmail adapter (T-102): this feature's own audit actions, ticket event types and queue names (T-123a).
 *
 * The task that owns this feature adds entries here and nowhere else in `packages/shared`. The
 * global `AUDIT_ACTIONS`, `TICKET_EVENT_TYPES` and `QUEUE_NAMES` are composed from these records
 * (see `./index.ts`), and importing `@watchtower/shared` throws if two features use the same key
 * or the same value. Keys are camelCase; values are lowercase strings (dotted for audit actions and
 * ticket events, the BullMQ queue name for queues). Start a value with the feature name so
 * collisions are unlikely.
 */
import { z } from 'zod';

/** Audit `action` strings written by this feature. Metadata holds counts and codes, never an address or a body. */
export const GMAIL_AUDIT_ACTIONS = {
  /** `history.list` could not be used (404) or there was no cursor, so a bounded full sync ran (R-2.1). */
  gmailFullSync: 'gmail.full_sync',
  /** `users.watch` failed; the mailbox may stop pushing within 7 days (R-2.1). */
  gmailWatchFailed: 'gmail.watch_failed',
  /** No push for the configured window: the mailbox is marked unhealthy (R-2.8). */
  gmailHeartbeatStale: 'gmail.heartbeat_stale',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const GMAIL_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: api receiver and worker, consumer: worker). */
export const GMAIL_QUEUES = {
  /** History sync, watch renewal and heartbeat of the Gmail mailboxes (T-102b to T-102d). */
  gmail: 'gmail',
} as const satisfies Record<string, string>;

export const GMAIL_JOBS = {
  /** Read what is new in one mailbox (from a push, the heartbeat or a continuation) and queue it for ingestion. */
  sync: 'sync',
  /** `users.watch` for every mailbox, once a day (the watch expires after 7 days, R-2.1). */
  renewWatch: 'renew-watch',
  /** Marks mailboxes that stopped pushing (R-2.8). */
  heartbeat: 'heartbeat',
} as const;

/** Why a sync job exists. Only for logs and the audit trail; the work is the same. */
export const GMAIL_SYNC_REASONS = ['push', 'heartbeat', 'continuation', 'renew', 'manual'] as const;

/** Payload of a `sync` job. The job id is built by the producer so a repeat is the same job. */
export const gmailSyncJobSchema = z.object({
  channelAccountId: z.uuid(),
  reason: z.enum(GMAIL_SYNC_REASONS),
  /** The history id the push announced; informational (the cursor in the database is what is read from). */
  pushHistoryId: z.string().regex(/^[0-9]{1,20}$/).optional(),
});
export type GmailSyncJob = z.infer<typeof gmailSyncJobSchema>;

/** `sync` jobs are repeatable and idempotent: retry a few times with backoff, then keep the failure for a week. */
export const GMAIL_SYNC_OUTBOX_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

/** `channel_account.health` values written by this feature. */
export const GMAIL_CHANNEL_HEALTH = ['unknown', 'healthy', 'unhealthy'] as const;
export type GmailChannelHealth = (typeof GMAIL_CHANNEL_HEALTH)[number];

/**
 * The Pub/Sub push request body (wrapped delivery, the default; Pub/Sub push docs read 2026-11-01).
 * `message.data` is base64; Gmail's payload inside it is `{emailAddress, historyId}` (see the Gmail
 * adapter). Extra fields are ignored: Pub/Sub adds some (`orderingKey`, `deliveryAttempt`).
 */
export const pubsubPushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string().min(1).max(4096),
    messageId: z.string().regex(/^[0-9]{1,30}$/),
    publishTime: z.string().max(64).optional(),
  }),
  subscription: z.string().max(300).optional(),
});
export type PubsubPushEnvelope = z.infer<typeof pubsubPushEnvelopeSchema>;

/** A Gmail address as the push payload and the state row spell it: compare in lower case. */
export function normaliseMailboxAddress(value: string): string {
  return value.trim().toLowerCase();
}
