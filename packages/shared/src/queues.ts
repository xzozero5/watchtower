/**
 * BullMQ queue names and job defaults, shared by apps/api (producer) and apps/worker (consumer).
 * apps cannot import each other, so the contract lives here. Add a queue here first, then the
 * payload schema next to it (docs/04-ARCHITECTURE.md section 2: enqueue after commit, every job
 * has an idempotency key used as its jobId).
 */
import { z } from 'zod';

import { assertDisjoint } from './features/compose.js';
import { FEATURES, FEATURE_QUEUES } from './features/index.js';
import { customerStatusSchema, portalLocaleSchema } from './portal.js';

/** Queues of the core (Phase 0) features; Phase 1 features add theirs in `features/<feature>.ts`. */
export const CORE_QUEUE_NAMES = {
  /** Liveness and plumbing checks. Carries no business data. */
  system: 'system',
  /** Outbound email, delivered over SMTP (Mailpit locally). */
  email: 'email',
  /** Scheduled housekeeping, for example creating next month's partitions. */
  maintenance: 'maintenance',
  /** Deletes expired sessions, tokens and old lockout rows (T-117). */
  cleanup: 'cleanup',
} as const;

/** Every queue: core plus every feature. */
export const QUEUE_NAMES = { ...CORE_QUEUE_NAMES, ...FEATURE_QUEUES } as const;
assertDisjoint('QUEUE_NAMES', [CORE_QUEUE_NAMES, ...FEATURES.map((feature) => feature.queues)]);

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

export const CLEANUP_JOBS = {
  purgeExpired: 'purge-expired',
} as const;

const portalEmailBase = {
  to: z.string().min(3).max(254),
  locale: portalLocaleSchema,
  ticketKey: z.string().min(3).max(32),
  trackingUrl: z.url().max(1000),
};

/**
 * The ticket subject as it is shown to the customer (no line breaks). Only emails that follow a
 * staff action carry it. The confirmation and the new-link email do not: both can be provoked by
 * someone who types another person's address, so they must not repeat text that person chose
 * (C-11, ADR-007).
 */
const portalSubject = { subject: z.string().max(300) };

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
      ...portalSubject,
      reason: z.enum(['staff_reply', 'status_change']),
      status: customerStatusSchema,
      /** First name of the staff member who replied; null for a status change. */
      agentName: z.string().max(100).nullable(),
    }),
    z.object({
      kind: z.literal('portal_merged'),
      ...portalEmailBase,
      ...portalSubject,
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
 * the worker renders it, so wording lives in one place. A magic link is a secret until used: on the
 * wire it is sealed (`EMAIL_SECRET_FIELDS`), so a job kept for inspection after a failure holds
 * ciphertext only.
 */
export const emailJobSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('magic_link'),
    to: z.string().min(3).max(254),
    link: z.url(),
    expiresInMinutes: z.number().int().min(1).max(1440),
  }),
  // Client portal emails (T-007). The api writes parameters; the worker renders TH or EN. The
  // tracking URL carries the access token in its fragment, so like a magic link it is sealed on the
  // wire (EMAIL_SECRET_FIELDS) and the outbox relay blanks the row once sent (ADR-006).
  ...portalEmailVariants(),
]);
export type EmailJob = z.infer<typeof emailJobSchema>;

/**
 * Fields of an email job that are secret until used: the magic link and the tracking link both
 * carry a bearer token. The api seals exactly these fields (AES-256-GCM, a subkey of
 * APP_ENCRYPTION_KEY) before the job is written to the outbox, so neither Postgres nor Redis ever
 * holds them in the clear; the worker opens them just before it talks to SMTP (ADR-006).
 */
export const EMAIL_SECRET_FIELDS = ['link', 'trackingUrl'] as const;

/** Splits a validated email job into the fields that travel in the clear and the ones to seal. */
export function splitEmailSecrets(job: EmailJob): {
  readonly clear: Record<string, unknown>;
  readonly secret: Record<string, string>;
} {
  const clear: Record<string, unknown> = {};
  const secret: Record<string, string> = {};
  for (const [name, value] of Object.entries(emailJobSchema.parse(job))) {
    if ((EMAIL_SECRET_FIELDS as readonly string[]).includes(name) && typeof value === 'string') {
      secret[name] = value;
    } else {
      clear[name] = value;
    }
  }
  return { clear, secret };
}

/**
 * The wire shape of a sealed job, as stored in `outbox.payload` and as BullMQ job data: the
 * non-secret fields in the clear, the secret ones in `secret` (see `sealFields`), and `notAfter`
 * (epoch milliseconds, added by the relay from `outbox.expires_at`) after which a worker drops the
 * job unsent.
 */
export const sealedEnvelopeSchema = z.looseObject({
  secret: z.string().min(1).max(4000),
  notAfter: z.number().int().positive().optional(),
});
export type SealedEnvelope = z.infer<typeof sealedEnvelopeSchema>;

/** How long a customer tracking link email stays worth sending if the queue cannot deliver it. */
export const PORTAL_EMAIL_TTL_SECONDS = 24 * 3600;

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
    /** BullMQ priority: 1 runs first. Jobs without one run before every prioritized job. */
    priority: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type OutboxJobOptions = z.infer<typeof outboxJobOptionsSchema>;

/**
 * Options of an outbound email job. A finished job is deleted at once and a failed one is kept for
 * an hour only. The secret fields are sealed, so even that hour holds ciphertext, never a link.
 */
export const EMAIL_OUTBOX_JOB_OPTIONS: OutboxJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: true,
  removeOnFail: { age: 3600 },
};
