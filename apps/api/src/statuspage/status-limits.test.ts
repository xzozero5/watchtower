import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RateLimitedError } from '../auth/http-errors.js';
import { StatusLimits, STATUS_LIMIT_POLICY, type HitCounter } from './status-limits.js';

/** A counter in memory with the same fixed-window rule as the Redis one. */
function memoryCounter(): HitCounter & { keys: string[] } {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    hit(scope, subject, limit) {
      const key = `${scope}|${subject}`;
      keys.push(key);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return Promise.resolve({ allowed: count <= limit, retryAfterSeconds: 30, count });
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StatusLimits (T-207a C-3)', () => {
  it('counts every address of one IPv6 /64 as one caller, and an IPv4-mapped address as its IPv4', async () => {
    const counter = memoryCounter();
    const limits = new StatusLimits(counter);
    const allowed = STATUS_LIMIT_POLICY['subscribe-ip'].limit;
    for (let i = 0; i < allowed; i += 1) {
      await limits.enforce('subscribe-ip', `2001:db8:1:2:${i.toString(16)}:aaaa:bbbb:cccc`);
    }
    await expect(limits.enforce('subscribe-ip', '2001:db8:1:2::99')).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    // Another /64 is another caller.
    await expect(limits.enforce('subscribe-ip', '2001:db8:1:3::1')).resolves.toBeUndefined();
    await limits.enforce('read-ip', '::ffff:203.0.113.7');
    expect(counter.keys).toContain('status-read-ip|203.0.113.7');
  });

  it('does not rewrite a subject that is not an address (an email, a domain, "all")', async () => {
    const counter = memoryCounter();
    const limits = new StatusLimits(counter);
    await limits.enforce('subscribe-email', 'a@b.test');
    await limits.enforce('subscribe-domain', 'b.test');
    await limits.enforce('subscribe-global-hour', 'all');
    expect(counter.keys).toEqual([
      'status-subscribe-email|a@b.test',
      'status-subscribe-domain|b.test',
      'status-subscribe-global-hour|all',
    ]);
  });

  it.each(['subscribe-global-hour', 'subscribe-global-day'] as const)(
    'refuses past the %s ceiling and logs an error, which the per-caller scopes do not',
    async (scope) => {
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const limits = new StatusLimits(memoryCounter());
      const { limit } = STATUS_LIMIT_POLICY[scope];
      for (let i = 0; i < limit; i += 1) await limits.enforce(scope, 'all');
      expect(error).not.toHaveBeenCalled();
      await expect(limits.enforce(scope, 'all')).rejects.toBeInstanceOf(RateLimitedError);
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]?.[0])).toContain(scope);

      const quiet = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      quiet.mockClear();
      const perCaller = new StatusLimits(memoryCounter());
      const max = STATUS_LIMIT_POLICY['subscribe-email'].limit;
      for (let i = 0; i < max; i += 1) await perCaller.enforce('subscribe-email', 'x@y.test');
      await expect(perCaller.enforce('subscribe-email', 'x@y.test')).rejects.toBeInstanceOf(
        RateLimitedError,
      );
      expect(quiet).not.toHaveBeenCalled();
    },
  );

  it('keeps the page-wide ceilings above what one caller and one domain may use', () => {
    expect(STATUS_LIMIT_POLICY['subscribe-global-hour'].limit).toBeGreaterThan(
      STATUS_LIMIT_POLICY['subscribe-domain'].limit,
    );
    expect(STATUS_LIMIT_POLICY['subscribe-global-day'].limit).toBeGreaterThan(
      STATUS_LIMIT_POLICY['subscribe-global-hour'].limit,
    );
  });
});
