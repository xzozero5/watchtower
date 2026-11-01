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
