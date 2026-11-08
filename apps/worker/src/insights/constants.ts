import { QUEUE_NAMES, type QueueName } from '@watchtower/shared';

/**
 * BullMQ queue name for embedded insights background work (T-418, ADR-029 section 9.4).
 * Kept strictly isolated from the main `ai` queue so insight narration never blocks
 * customer-facing drafts and investigations.
 */
export const INSIGHTS_QUEUE: QueueName = QUEUE_NAMES.insights;

export const INSIGHT_JOBS = {
  tick: 'insight_tick',
  narrate: 'narrate',
} as const;

export type InsightJobName = (typeof INSIGHT_JOBS)[keyof typeof INSIGHT_JOBS];

/** Default constants matching ADR-029 section 9.4 & config/budgets.yaml */
export const INSIGHT_DEFAULTS = {
  debounceMinutes: 3,
  maxWaitMinutes: 15,
  minIntervalMinutes: 30,
  viewedWithinHours: 24,
  narrationTtlHours: 6,
  buildersPerTick: 20,
  maxBatchElements: 4,
  stopAtDailyPercent: 60,
  callsPerHour: 6,
  callsPerDay: 60,
  dailyTokens: 150_000,
  userScopedCallsPerDay: 30,
  userScopedPerUserPerDay: 4,
  userScopedMinIntervalMinutes: 60,
  feedbackVoteThreshold: 20,
  feedbackPauseRatio: 0.5,
  feedbackWarningRatio: 0.3,
  feedbackWindowDays: 7,
} as const;
