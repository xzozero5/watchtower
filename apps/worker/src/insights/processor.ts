import type { Job, Processor } from 'bullmq';

import type { ProcessorContext } from '../processors/index.js';
import { INSIGHT_JOBS } from './constants.js';
import { runInsightTick, type TickResult } from './tick.js';

/**
 * Creates the BullMQ processor for the `insights` queue (T-418, ADR-029 section 9.4).
 * Concurrency 1, isolated from the main `ai` queue.
 */
export function createInsightsProcessor(context: ProcessorContext): Processor {
  const { config, logger, database, ai, redis, aiQueue } = context;

  if (!redis) {
    throw new Error('insights processor requires redis in ProcessorContext');
  }

  return async (job: Job): Promise<TickResult | { status: string }> => {
    switch (job.name) {
      case INSIGHT_JOBS.tick:
        return await runInsightTick({
          database,
          redis,
          config,
          logger,
          ai,
          aiQueue,
        });

      default:
        logger.warn({ jobName: job.name, jobId: job.id }, 'unrecognized insight job name');
        return { status: 'unrecognized' };
    }
  };
}
