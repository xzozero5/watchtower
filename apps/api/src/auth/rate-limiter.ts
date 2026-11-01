import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { REDIS } from '../redis/redis.module.js';
import { RateLimitedError } from './http-errors.js';

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
 * Fixed-window counters in Redis. The subject (an IP address, an email) is hashed before it
 * becomes part of a key, so Redis holds no addresses. If Redis is down the call rejects and the
 * auth endpoint fails closed with 500/503 rather than letting attempts through unmetered.
 */
@Injectable()
export class RateLimiter {
  private readonly namespace: string;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) config: Pick<ApiConfig, 'RATE_LIMIT_NAMESPACE'>,
  ) {
    this.namespace = config.RATE_LIMIT_NAMESPACE;
  }

  async hit(
    scope: string,
    subject: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const digest = createHash('sha256').update(subject).digest('hex').slice(0, 32);
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
    const digest = createHash('sha256').update(subject).digest('hex').slice(0, 32);
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
