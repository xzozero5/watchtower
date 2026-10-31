import { describe, expect, it } from 'vitest';

import { EMAIL_OUTBOX_JOB_OPTIONS, outboxJobOptionsSchema } from './queues.js';

describe('outboxJobOptionsSchema', () => {
  it('accepts the options of the email job', () => {
    expect(outboxJobOptionsSchema.parse(EMAIL_OUTBOX_JOB_OPTIONS)).toEqual(
      EMAIL_OUTBOX_JOB_OPTIONS,
    );
    expect(outboxJobOptionsSchema.parse({})).toEqual({});
  });

  it('refuses an option nobody reviewed, and values out of range', () => {
    expect(outboxJobOptionsSchema.safeParse({ repeat: { every: 1 } }).success).toBe(false);
    expect(outboxJobOptionsSchema.safeParse({ jobId: 'other' }).success).toBe(false);
    expect(outboxJobOptionsSchema.safeParse({ attempts: 0 }).success).toBe(false);
    expect(outboxJobOptionsSchema.safeParse({ attempts: 1000 }).success).toBe(false);
    expect(
      outboxJobOptionsSchema.safeParse({ backoff: { type: 'linear', delay: 5 } }).success,
    ).toBe(false);
    expect(outboxJobOptionsSchema.safeParse({ removeOnFail: { count: 5 } }).success).toBe(false);
  });
});
