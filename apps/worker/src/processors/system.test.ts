import { SYSTEM_JOBS } from '@watchtower/shared';
import type { Job } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { pingResultSchema, processSystemJob } from './system.js';

// A BullMQ Job is a large class; the processor only reads `name`.
const jobNamed = (name: string) => ({ name }) as Job;

describe('processSystemJob', () => {
  it('answers a ping with pong and a timestamp', async () => {
    const result = await processSystemJob(jobNamed(SYSTEM_JOBS.ping));
    expect(pingResultSchema.parse(result).pong).toBe(true);
  });

  it('fails an unknown job so BullMQ retries or dead-letters it', async () => {
    await expect(processSystemJob(jobNamed('mystery'))).rejects.toThrow(/unknown system job/);
  });
});
