/**
 * BullMQ queue names and job defaults, shared by apps/api (producer) and apps/worker (consumer).
 * apps cannot import each other, so the contract lives here. Add a queue here first, then the
 * payload schema next to it (docs/04-ARCHITECTURE.md section 2: enqueue after commit, every job
 * has an idempotency key used as its jobId).
 */
export const QUEUE_NAMES = {
  /** Liveness and plumbing checks. Carries no business data. */
  system: 'system',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const SYSTEM_JOBS = {
  ping: 'ping',
} as const;

/** Retry with exponential backoff; keep a bounded history of finished jobs for the head to inspect. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;
