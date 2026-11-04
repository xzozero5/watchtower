import {
  AI_JOBS,
  ALERTS_JOBS,
  CLEANUP_JOBS,
  CSAT_JOBS,
  GMAIL_JOBS,
  DISCORD_JOBS,
  KB_JOBS,
  LINE_JOBS,
  MAINTENANCE_JOBS,
  USAGE_JOBS,
  SCAN_JOBS,
  SCAN_TICK_SECONDS,
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
  {
    queue: QUEUE_NAMES.ai,
    id: AI_JOBS.weeklyBrief,
    // The weekly brief of the CEO view (T-305c): every 10 minutes the job asks "is this week's slot made?"
    // (the day and time are settings, WEEKLY_BRIEF_*) and makes it at most once. Ticking, not a fixed cron,
    // so the day and time are an environment setting and a worker that was down at the time catches up. Also
    // once at start, for the same reason.
    repeat: { every: 10 * 60_000 },
    job: {
      name: AI_JOBS.weeklyBrief,
      opts: { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
    },
    runAtBoot: true,
  },

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
  {
    queue: QUEUE_NAMES.csat,
    id: CSAT_JOBS.sweep,
    // Surveys that are due, the one 48-hour reminder, and links that ran out, every minute.
    repeat: { every: 60_000 },
    job: {
      name: CSAT_JOBS.sweep,
      opts: { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
    },
  },

  // --- shifts (T-111) ---

  // --- autonomy (T-112) ---

  // --- credentials (T-116) ---

  // --- views (T-119) ---

  // --- alerts (T-201d) ---
  {
    queue: QUEUE_NAMES.alerts,
    id: ALERTS_JOBS.sweep,
    // Escalation steps that are due and chat posts that are owed, every 15 s `[ASSUMED]`: the
    // resolution of "unacknowledged for T1" is this interval. Not at boot: the first tick is soon enough.
    repeat: { every: 15_000 },
    job: {
      name: ALERTS_JOBS.sweep,
      opts: { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
    },
  },

  // --- usage (T-205b) ---
  {
    queue: QUEUE_NAMES.usage,
    id: USAGE_JOBS.tick,
    // The metrics that are due, every minute: each metric has its own interval (5 minutes to a day), and
    // "due" is the database clock's decision. With no product data port connected the tick does nothing.
    repeat: { every: 60_000 },
    job: {
      name: USAGE_JOBS.tick,
      opts: { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
    },
  },
  {
    queue: QUEUE_NAMES.usage,
    id: USAGE_JOBS.health,
    // The Client Health Score of every organization, daily at 02:30 UTC (T-205d). Also once at start, so a
    // fresh install shows "not enough data" rather than nothing.
    repeat: { pattern: '30 2 * * *', tz: 'UTC' },
    job: {
      name: USAGE_JOBS.health,
      opts: { removeOnComplete: true, removeOnFail: { age: 7 * 24 * 3600 } },
    },
    runAtBoot: true,
  },

  // --- uploads: malware scan, orphans, retention (T-155) ---
  {
    queue: QUEUE_NAMES.scan,
    id: SCAN_JOBS.tick,
    // New files are enrolled and the due ones scanned every few seconds, so a fresh upload is
    // openable soon after it arrives. Does nothing while neither the scan nor retention is on.
    repeat: { every: SCAN_TICK_SECONDS * 1000 },
    job: {
      name: SCAN_JOBS.tick,
      opts: { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
    },
  },
  {
    queue: QUEUE_NAMES.scan,
    id: SCAN_JOBS.housekeeping,
    // Daily at 04:00 UTC, and once at start: the one-off scan of files stored before the mode was
    // switched on (ADR-022), unattached staff uploads, and the retention.
    repeat: { pattern: '0 4 * * *', tz: 'UTC' },
    job: {
      name: SCAN_JOBS.housekeeping,
      opts: { removeOnComplete: true, removeOnFail: { age: 7 * 24 * 3600 } },
    },
    runAtBoot: true,
  },
];
