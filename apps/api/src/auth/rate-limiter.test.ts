import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { RateLimiter, rateLimitKey, subjectDigest } from './rate-limiter.js';

// T-125: the subject part of a counter key is an HMAC, so someone who can read Redis cannot test a
// guess ("is 203.0.113.9 in there?") with a plain hash.

const CONFIG = { RATE_LIMIT_NAMESPACE: 'wt-test', APP_ENCRYPTION_KEY: 'a'.repeat(32) };

describe('subjectDigest', () => {
  it('is not the plain SHA-256 of the subject, and is stable for the same key', () => {
    const key = rateLimitKey(CONFIG);
    const plain = createHash('sha256').update('203.0.113.9').digest('hex').slice(0, 32);
    expect(subjectDigest(key, '203.0.113.9')).not.toBe(plain);
    expect(subjectDigest(key, '203.0.113.9')).toBe(subjectDigest(key, '203.0.113.9'));
    expect(subjectDigest(key, '203.0.113.9')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('changes with the key and with the subject', () => {
    const key = rateLimitKey(CONFIG);
    const other = rateLimitKey({ ...CONFIG, APP_ENCRYPTION_KEY: 'b'.repeat(32) });
    expect(subjectDigest(key, 'x')).not.toBe(subjectDigest(other, 'x'));
    expect(subjectDigest(key, 'x')).not.toBe(subjectDigest(key, 'y'));
  });
});

describe('RateLimiter keys', () => {
  it('writes the HMAC, never the plain hash or the subject, into the Redis key', async () => {
    const keys: string[] = [];
    const redis = {
      eval: (_script: string, _count: number, key: string) => {
        keys.push(key);
        return Promise.resolve([1, 60]);
      },
    };
    const limiter = new RateLimiter(redis as never, CONFIG);
    await limiter.hit('bg-ip', '203.0.113.9', 10, 60);
    const plain = createHash('sha256').update('203.0.113.9').digest('hex').slice(0, 32);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(`wt-test:rl:bg-ip:${subjectDigest(rateLimitKey(CONFIG), '203.0.113.9')}`);
    expect(keys[0]).not.toContain(plain);
    expect(keys[0]).not.toContain('203.0.113.9');
  });
});
