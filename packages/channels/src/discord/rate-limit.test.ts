import { describe, expect, it } from 'vitest';

import { DiscordRateLimiter, MAX_RATE_LIMIT_WAIT_MS, boundedWaitMs } from './rate-limit.js';

const observation = (status: number, headers: Record<string, string>, body?: number) => ({
  status,
  headers: new Headers(headers),
  bodyRetryAfterSeconds: body,
});

describe('boundedWaitMs', () => {
  it('rounds up fractional seconds and never exceeds the ceiling', () => {
    expect(boundedWaitMs(1.2)).toBe(1200);
    expect(boundedWaitMs(99_999_999)).toBe(MAX_RATE_LIMIT_WAIT_MS);
    expect(boundedWaitMs(1e308)).toBe(MAX_RATE_LIMIT_WAIT_MS);
  });
});

describe('DiscordRateLimiter ceiling (F-5)', () => {
  it('a global 429 with a huge Retry-After holds every webhook for the ceiling, not until restart', () => {
    let now = 1_000;
    const limiter = new DiscordRateLimiter(() => now);
    limiter.observe(
      'a',
      observation(429, { 'retry-after': '99999999', 'x-ratelimit-global': 'true' }),
    );
    expect(limiter.waitMs('other')).toBe(MAX_RATE_LIMIT_WAIT_MS);
    now += MAX_RATE_LIMIT_WAIT_MS + 1;
    expect(limiter.waitMs('other')).toBe(0);
  });

  it('a huge body value (1e308) and a huge reset-after are bounded too', () => {
    const limiter = new DiscordRateLimiter(() => 0);
    limiter.observe('a', observation(429, {}, 1e308));
    expect(limiter.waitMs('a')).toBe(MAX_RATE_LIMIT_WAIT_MS);
    limiter.observe(
      'b',
      observation(200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '1e308' }),
    );
    expect(limiter.waitMs('b')).toBe(MAX_RATE_LIMIT_WAIT_MS);
  });
});
