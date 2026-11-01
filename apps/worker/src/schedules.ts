import {
  CLEANUP_JOBS,
  GMAIL_JOBS,
  DISCORD_JOBS,
  KB_JOBS,
  LINE_JOBS,
  MAINTENANCE_JOBS,
  OUTBOUND_JOBS,
  QUEUE_NAMES,
  type QueueName,
} from '@watchtower/shared';
import type { JobsOptions, RepeatOptions } from 'bullmq';

export interface ScheduleRegistration {
  readonly queue: QueueName;
  /** Stable id of the BullMQ job scheduler; upserting the same id again changes it in place. */
  readonly id: string;
  /** Cron pattern with a time zone, or a fixed interval. */
  readonly repeat: Omit<RepeatOptions, 'key'>;
  readonly job: {
    readonly name: string;
    readonly data?: Record<string, unknown>;
    readonly opts?: JobsOptions;
  };
  /**
   * Also add one job when the worker starts (job id `<id>-boot-<epoch ms>`), so a fresh install
   * does not wait for the first tick.
   */
  readonly runAtBoot?: boolean;
}

/**
 * Every repeating job of the worker (T-123a), upserted at start. To add one: add a line to your own
 * feature section and nothing else. Sections are separated by blank lines so two features adding a
 * line do not conflict. The processor for the queue goes in `./processors/index.ts`.
 */
export const SCHEDULES: readonly ScheduleRegistration[] = [
  // --- core ---
  {
    queue: QUEUE_NAMES.maintenance,
    id: MAINTENANCE_JOBS.ensurePartitions,
    // Partition maintenance at 03:00 UTC every day, and once at start so a fresh install is ready.
    repeat: { pattern: '0 3 * * *', tz: 'UTC' },
    job: {
      name: MAINTENANCE_JOBS.ensurePartitions,
      opts: { removeOnComplete: true, removeOnFail: { age: 7 * 24 * 3600 } },
    },
    runAtBoot: true,
  },
  {
    queue: QUEUE_NAMES.cleanup,
    id: CLEANUP_JOBS.purgeExpired,
    // Expired sessions, tokens and lockout counters at 03:30 UTC every day, after the partitions.
    // Not at boot: an install that has just started has nothing worth deleting.
    repeat: { pattern: '30 3 * * *', tz: 'UTC' },
    job: {
      name: CLEANUP_JOBS.purgeExpired,
      opts: { removeOnComplete: true, removeOnFail: { age: 7 * 24 * 3600 } },
    },
  },

  // --- inbound (T-122) ---

  // --- outbound (T-122d) ---
  {
    queue: QUEUE_NAMES.outbound,
    id: OUTBOUND_JOBS.sweep,
    // Stuck `sending`, late `scheduled` and stale reply tokens, every 30 s (ADR-010 section 7).
    repeat: { every: 30_000 },
    job: {
      name: OUTBOUND_JOBS.sweep,
      opts: { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
    },
  },

  // --- gmail (T-102): watch renewal, heartbeat ---
  {
    queue: QUEUE_NAMES.gmail,
    id: GMAIL_JOBS.renewWatch,
    // `users.watch` once a day at 02:15 UTC (09:15 Bangkok, before the working day is under way);
    // the watch lasts 7 days, so one failure leaves several retries (R-2.1). Also once at start, so a
    // fresh install does not wait a day. A failing renewal is retried with backoff.
    repeat: { pattern: '15 2 * * *', tz: 'UTC' },
    job: {
      name: GMAIL_JOBS.renewWatch,
      opts: {
        attempts: 4,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: true,
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    },
    runAtBoot: true,
  },
  {
    queue: QUEUE_NAMES.gmail,
    id: GMAIL_JOBS.heartbeat,
    // R-2.8: is push still arriving? Cheap (one query per mailbox), so every 10 minutes.
    repeat: { every: 10 * 60_000 },
    job: {
      name: GMAIL_JOBS.heartbeat,
      opts: { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
    },
  },

  // --- line (T-103) ---
  {
    queue: QUEUE_NAMES.line,
    id: LINE_JOBS.reconcileQuota,
    // Compare the push counter with LINE's own numbers once an hour (ADR-010 section 6, R-2.10).
    repeat: { pattern: '5 * * * *', tz: 'UTC' },
    job: {
      name: LINE_JOBS.reconcileQuota,
      opts: { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
    },
  },

  // --- discord (T-104) ---
  {
    queue: QUEUE_NAMES.discord,
    id: DISCORD_JOBS.sweep,
    // Due retries, abandoned claims and posts past their age, every minute.
    repeat: { every: 60_000 },
    job: {
      name: DISCORD_JOBS.sweep,
      opts: { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
    },
  },

  // --- notifications (T-105) ---

  // --- ai (T-106, T-108) ---

  // --- kb (T-107) ---
  {
    queue: QUEUE_NAMES.kb,
    id: KB_JOBS.reembedAll,
    // Brings every published article up to the active embedding model, and fills in vectors that
    // were skipped (kill switch, daily budget), at 04:00 UTC every day. Not at boot: publishing
    // queues its own embed job.
    repeat: { pattern: '0 4 * * *', tz: 'UTC' },
    job: {
      name: KB_JOBS.reembedAll,
      opts: { removeOnComplete: true, removeOnFail: { age: 7 * 24 * 3600 } },
    },
  },

  // --- csat (T-110) ---

  // --- shifts (T-111) ---

  // --- autonomy (T-112) ---

  // --- credentials (T-116) ---

  // --- views (T-119) ---
];
