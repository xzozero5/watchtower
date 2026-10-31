import { SYSTEM_JOBS } from '@watchtower/shared';
import type { Job } from 'bullmq';
import { z } from 'zod';

export const pingResultSchema = z.object({ pong: z.literal(true), handledAt: z.string() });
export type PingResult = z.infer<typeof pingResultSchema>;

/**
 * Processor for the `system` queue. It carries no business data; it exists so the api, the tests
 * and operators can prove the producer, Redis and a consumer are wired together.
 */
export function processSystemJob(job: Job): Promise<PingResult> {
  if (job.name === SYSTEM_JOBS.ping) {
    return Promise.resolve({ pong: true, handledAt: new Date().toISOString() });
  }
  return Promise.reject(new Error(`unknown system job "${job.name}"`));
}
