import { z } from 'zod';

import { cursorSchema, pageLimit, pageOf } from './common.js';

/**
 * HTTP contract of the head's view of the transactional outbox (T-121a, PRD section 8.3: the
 * dead-letter queue is visible to the head). Nothing here carries a payload: a row's payload can hold
 * a sealed one-time link, and a dead row's payload is blanked anyway (ADR-006).
 */

/**
 * The oldest due pending row is late by this many seconds `[ASSUMED]`: the relay polls every second,
 * so a row that has waited 2 minutes means the relay or Redis is down; 10 minutes is an incident.
 */
export const OUTBOX_AGE_WARNING_SECONDS = 120;
export const OUTBOX_AGE_CRITICAL_SECONDS = 600;

export const OUTBOX_HEALTH_STATUSES = ['ok', 'warning', 'critical'] as const;
export const outboxHealthStatusSchema = z.enum(OUTBOX_HEALTH_STATUSES);
export type OutboxHealthStatus = (typeof OUTBOX_HEALTH_STATUSES)[number];

/** `ok`, `warning` or `critical` from the age of the oldest pending row that was due. */
export function outboxHealthStatus(oldestPendingSeconds: number): OutboxHealthStatus {
  if (oldestPendingSeconds >= OUTBOX_AGE_CRITICAL_SECONDS) return 'critical';
  if (oldestPendingSeconds >= OUTBOX_AGE_WARNING_SECONDS) return 'warning';
  return 'ok';
}

export const outboxQueueCountSchema = z.object({
  queue: z.string(),
  pending: z.number().int().min(0),
  dead: z.number().int().min(0),
});

export const outboxHealthSchema = z.object({
  generatedAt: z.iso.datetime(),
  pending: z.number().int().min(0),
  dead: z.number().int().min(0),
  /**
   * Seconds since the oldest pending row became due (a row held back on purpose, such as a send in
   * its undo window, is not late); 0 when nothing waits.
   */
  oldestPendingSeconds: z.number().int().min(0),
  status: outboxHealthStatusSchema,
  warningSeconds: z.number().int(),
  criticalSeconds: z.number().int(),
  byQueue: z.array(outboxQueueCountSchema),
});
export type OutboxHealth = z.infer<typeof outboxHealthSchema>;

export const deadOutboxQuerySchema = z.object({
  queue: z.string().trim().min(1).max(64).optional(),
  limit: pageLimit(50, 200),
  cursor: cursorSchema.optional(),
});
export type DeadOutboxQuery = z.infer<typeof deadOutboxQuerySchema>;

/**
 * What a resend would set going, said without the content: a message to a customer, or a received
 * event processed for the first time (a dead row was never published): that opens a ticket and, on
 * LINE, may send the automatic acknowledgement (through the outbound gate). Never a body, an address
 * or a name: the head sees where it goes (channel, account, ticket), not what it says.
 */
export const OUTBOX_EFFECT_KINDS = ['customer_message', 'reprocess_inbound'] as const;
export const outboxEffectKindSchema = z.enum(OUTBOX_EFFECT_KINDS);
export type OutboxEffectKind = (typeof OUTBOX_EFFECT_KINDS)[number];

export const deadOutboxEffectSchema = z.object({
  kind: outboxEffectKindSchema,
  /** `gmail`, `line`, `portal`...: the channel the message leaves by, or arrived on. */
  channel: z.string(),
  /** The channel account's display name (an instance label such as the mailbox name). */
  channelAccountName: z.string(),
  /** Why the message exists (`reply`, `auto_ack`...); null for a received event. */
  origin: z.string().nullable(),
  /** The ticket the message belongs to (display it with the instance's key prefix); null for a received event. */
  ticketNumber: z.number().int().positive().nullable(),
  /**
   * True when processing can send the customer an automatic acknowledgement (a LINE message does:
   * the same job opens the ticket and acknowledges it). False for a message to a customer already
   * (that is the effect) and for channels that do not acknowledge on arrival.
   */
  mayAcknowledge: z.boolean(),
});
export type DeadOutboxEffect = z.infer<typeof deadOutboxEffectSchema>;

export const deadOutboxItemSchema = z.object({
  id: z.uuid(),
  queue: z.string(),
  jobName: z.string(),
  jobId: z.string(),
  attempts: z.number().int().min(0),
  /** Why the row was given up on: one line, never a payload. */
  lastError: z.string().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  /** Whether "resend" can rebuild this job from its source record. */
  replayable: z.boolean(),
  notReplayableReason: z.string().nullable(),
  /** What a resend would do; null when the row cannot be replayed. */
  effect: deadOutboxEffectSchema.nullable(),
});
export type DeadOutboxItem = z.infer<typeof deadOutboxItemSchema>;
export const deadOutboxPageSchema = pageOf(deadOutboxItemSchema);

export const resendOutboxResultSchema = z.object({
  id: z.uuid(),
  queue: z.string(),
  /** The new BullMQ job id; the old one may still be remembered by the queue. */
  jobId: z.string(),
  status: z.literal('pending'),
});
export type ResendOutboxResult = z.infer<typeof resendOutboxResultSchema>;
