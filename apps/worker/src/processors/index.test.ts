import { QUEUE_NAMES } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { SCHEDULES } from '../schedules.js';
import { PROCESSORS } from './index.js';

describe('processor registry', () => {
  it('registers every declared queue exactly once, and nothing else', () => {
    const registered = PROCESSORS.map((registration) => registration.queue).toSorted();
    const expected = Object.values(QUEUE_NAMES).toSorted();
    expect(registered).toEqual(expected);
  });

  it('keeps the core queues the worker has always consumed', () => {
    const queues = PROCESSORS.map((registration) => registration.queue);
    expect(queues).toEqual(
      expect.arrayContaining([QUEUE_NAMES.system, QUEUE_NAMES.email, QUEUE_NAMES.maintenance]),
    );
  });

  it('only overrides concurrency with a positive integer', () => {
    for (const registration of PROCESSORS) {
      if (registration.concurrency !== undefined) {
        expect(Number.isInteger(registration.concurrency) && registration.concurrency > 0).toBe(
          true,
        );
      }
    }
  });
});

describe('schedule registry', () => {
  it('has unique ids, each on a queue that has a processor', () => {
    const ids = SCHEDULES.map((schedule) => `${schedule.queue}/${schedule.id}`);
    expect(new Set(ids).size).toBe(ids.length);
    const consumed = new Set<string>(PROCESSORS.map((registration) => registration.queue));
    for (const schedule of SCHEDULES) {
      expect(consumed.has(schedule.queue), `${schedule.id} has no consumer`).toBe(true);
    }
  });

  it('keeps the daily partition maintenance, run once at start', () => {
    const schedule = SCHEDULES.find((entry) => entry.id === 'ensure-partitions');
    expect(schedule).toMatchObject({
      queue: QUEUE_NAMES.maintenance,
      repeat: { pattern: '0 3 * * *', tz: 'UTC' },
      runAtBoot: true,
    });
  });
});
