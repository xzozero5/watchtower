import { createHmac } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import type { Redis } from 'ioredis';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { REDIS } from '../redis/redis.module.js';
import { RateLimitedError } from './http-errors.js';

/**
 * The part of a counter's Redis key that stands for the subject: an HMAC with a key derived from
 * `APP_ENCRYPTION_KEY`, not a bare hash. Anyone who can read Redis could test a guess of an IP
 * address or email against a plain SHA-256 (there are only 2^32 IPv4 addresses); without the key
 * they cannot. 128 bits are kept, which is plenty to avoid collisions.
 */
export function subjectDigest(key: Buffer, subject: string): string {
  return createHmac('sha256', key).update(subject).digest('hex').slice(0, 32);
}

export function rateLimitKey(config: Pick<ApiConfig, 'APP_ENCRYPTION_KEY'>): Buffer {
  return deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.rateLimit);
}

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Seconds until the window resets; use it for Retry-After. */
  readonly retryAfterSeconds: number;
  readonly count: number;
}

// INCR and the first EXPIRE in one atomic step, so a crash between them cannot leave a counter
// that never expires.
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {count, ttl}
`;

/**
 * Fixed-window counters in Redis. The subject (an IP address, an email) is HMAC'd (T-125) before it
 * becomes part of a key, so Redis holds no addresses and none can be guessed back from it. If Redis is down the call rejects and the
 * auth endpoint fails closed with 500/503 rather than letting attempts through unmetered.
 */
@Injectable()
export class RateLimiter {
  private readonly namespace: string;
  private readonly hmacKey: Buffer;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) config: Pick<ApiConfig, 'RATE_LIMIT_NAMESPACE' | 'APP_ENCRYPTION_KEY'>,
  ) {
    this.namespace = config.RATE_LIMIT_NAMESPACE;
    this.hmacKey = rateLimitKey(config);
  }

  async hit(
    scope: string,
    subject: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const digest = subjectDigest(this.hmacKey, subject);
    const key = `${this.namespace}:rl:${scope}:${digest}`;
    const reply = (await this.redis.eval(HIT_SCRIPT, 1, key, String(windowSeconds))) as [
      number,
      number,
    ];
    const [count, ttl] = reply;
    return { allowed: count <= limit, retryAfterSeconds: Math.max(1, ttl), count };
  }

  /**
   * Reads a counter without counting this call: true once `limit` hits were recorded in the current
   * window. For endpoints that count only failures and must refuse a blocked subject before doing
   * any work (a database lookup, a credential read, an HMAC).
   */
  async blocked(
    scope: string,
    subject: string,
    limit: number,
  ): Promise<{ readonly blocked: boolean; readonly retryAfterSeconds: number }> {
    const digest = subjectDigest(this.hmacKey, subject);
    const key = `${this.namespace}:rl:${scope}:${digest}`;
    const count = Number((await this.redis.get(key)) ?? 0);
    if (count < limit) return { blocked: false, retryAfterSeconds: 0 };
    return { blocked: true, retryAfterSeconds: Math.max(1, await this.redis.ttl(key)) };
  }

  /** Throws RateLimitedError (429) once `limit` is exceeded. */
  async enforce(
    scope: string,
    subject: string,
    limit: number,
    windowSeconds: number,
  ): Promise<void> {
    const result = await this.hit(scope, subject, limit, windowSeconds);
    if (!result.allowed) throw new RateLimitedError(result.retryAfterSeconds);
  }
}
