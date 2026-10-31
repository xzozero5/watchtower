/**
 * BullMQ queue names and job defaults, shared by apps/api (producer) and apps/worker (consumer).
 * apps cannot import each other, so the contract lives here. Add a queue here first, then the
 * payload schema next to it (docs/04-ARCHITECTURE.md section 2: enqueue after commit, every job
 * has an idempotency key used as its jobId).
 */
import { z } from 'zod';

import { customerStatusSchema, portalLocaleSchema } from './portal.js';

export const QUEUE_NAMES = {
  /** Liveness and plumbing checks. Carries no business data. */
  system: 'system',
  /** Outbound email, delivered over SMTP (Mailpit locally). */
  email: 'email',
  /** Scheduled housekeeping, for example creating next month's partitions. */
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const SYSTEM_JOBS = {
  ping: 'ping',
} as const;

export const EMAIL_JOBS = {
  send: 'send',
} as const;

export const MAINTENANCE_JOBS = {
  ensurePartitions: 'ensure-partitions',
} as const;

const portalEmailBase = {
  to: z.string().min(3).max(254),
  locale: portalLocaleSchema,
  ticketKey: z.string().min(3).max(32),
  /** The ticket subject as the customer wrote it (no line breaks). */
  subject: z.string().max(300),
  trackingUrl: z.url().max(1000),
};

function portalEmailVariants() {
  return [
    z.object({
      kind: z.literal('portal_confirmation'),
      ...portalEmailBase,
      expectedFirstResponseAt: z.iso.datetime().nullable(),
    }),
    z.object({
      kind: z.literal('portal_update'),
      ...portalEmailBase,
      reason: z.enum(['staff_reply', 'status_change']),
      status: customerStatusSchema,
      /** First name of the staff member who replied; null for a status change. */
      agentName: z.string().max(100).nullable(),
    }),
    z.object({
      kind: z.literal('portal_merged'),
      ...portalEmailBase,
      intoKey: z.string().min(3).max(32),
    }),
    z.object({
      kind: z.literal('portal_link'),
      ...portalEmailBase,
    }),
  ] as const;
}

/**
 * Payload of an `email` job. The api builds the whole message content-free (kind + parameters) and
 * the worker renders it, so wording lives in one place. A magic link is a secret until used: the
 * job that carries it is removed as soon as it succeeds and kept for an hour at most when it fails.
 */
export const emailJobSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('magic_link'),
    to: z.string().min(3).max(254),
    link: z.url(),
    expiresInMinutes: z.number().int().min(1).max(1440),
  }),
  // Client portal emails (T-007). The api writes parameters; the worker renders TH or EN. The
  // tracking URL carries the access token in its fragment, so like a magic link it is a secret
  // until the row is sent (the outbox relay blanks the payload then, ADR-006).
  ...portalEmailVariants(),
]);
export type EmailJob = z.infer<typeof emailJobSchema>;

/** Retry with exponential backoff; keep a bounded history of finished jobs for the head to inspect. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

const keepRule = z.union([
  z.boolean(),
  z.object({ age: z.number().int().min(0), count: z.number().int().min(0).optional() }),
]);

/**
 * BullMQ options a transactional-outbox row may carry (ADR-006). A closed list on purpose: the row
 * is data in the database, and the relay passes it to `queue.add` after parsing it with this schema,
 * so a damaged or hostile row cannot set an option nobody reviewed.
 */
export const outboxJobOptionsSchema = z
  .object({
    attempts: z.number().int().min(1).max(50).optional(),
    backoff: z
      .object({
        type: z.enum(['exponential', 'fixed']),
        delay: z.number().int().min(100).max(3_600_000),
      })
      .optional(),
    removeOnComplete: keepRule.optional(),
    removeOnFail: keepRule.optional(),
    delay: z
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 3600 * 1000)
      .optional(),
  })
  .strict();
export type OutboxJobOptions = z.infer<typeof outboxJobOptionsSchema>;

/**
 * Options of an outbound email job. The payload carries a one-time secret (a magic link), so a
 * finished job is deleted at once and a failed one is kept for an hour only.
 */
export const EMAIL_OUTBOX_JOB_OPTIONS: OutboxJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: true,
  removeOnFail: { age: 3600 },
};
