/**
 * BullMQ queue names and job defaults, shared by apps/api (producer) and apps/worker (consumer).
 * apps cannot import each other, so the contract lives here. Add a queue here first, then the
 * payload schema next to it (docs/04-ARCHITECTURE.md section 2: enqueue after commit, every job
 * has an idempotency key used as its jobId).
 */
import { z } from 'zod';

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
]);
export type EmailJob = z.infer<typeof emailJobSchema>;

/** Retry with exponential backoff; keep a bounded history of finished jobs for the head to inspect. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;
