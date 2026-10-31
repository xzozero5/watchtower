import { MAINTENANCE_JOBS, QUEUE_NAMES, type QueueName } from '@watchtower/shared';
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

  // --- inbound (T-122) ---

  // --- outbound (T-122d) ---

  // --- gmail (T-102): watch renewal, heartbeat ---

  // --- line (T-103) ---

  // --- discord (T-104) ---

  // --- notifications (T-105) ---

  // --- ai (T-106, T-108) ---

  // --- kb (T-107) ---

  // --- csat (T-110) ---

  // --- shifts (T-111) ---

  // --- autonomy (T-112) ---

  // --- credentials (T-116) ---

  // --- views (T-119) ---
];
