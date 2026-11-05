import { Inject, Injectable } from '@nestjs/common';
import { INSIGHTS_VIEWED_MARKS_PER_HOUR, type InsightLocale } from '@watchtower/shared';
import type { Redis } from 'ioredis';

import { REDIS } from '../redis/redis.module.js';

/** `[ASSUMED]` ADR-029 section 9.2: viewers and dirty marks live 24 hours. */
const VIEWED_TTL_SECONDS = 24 * 3600;
/** A dirty mark nobody turned into a narration goes away by itself. */
const DIRTY_TTL_SECONDS = 24 * 3600;

/** `insight:viewed:{element}:{scope}:{period}`: a sorted set of `userId:locale` scored by the time they looked. */
export const viewedKey = (element: string, scope: string, period: string): string =>
  `insight:viewed:${element}:${scope}:${period}`;

/** `insight:dirty:{element}:{scope}:{period}`: `{firstAt, lastAt}`; a person's own: `insight:dirty:user:{userId}:{element}`. */
export const dirtyKey = (element: string, scope: string, period: string): string =>
  `insight:dirty:${element}:${scope}:${period}`;
export const userDirtyKey = (userId: string, element: string): string =>
  `insight:dirty:user:${userId}:${element}`;

/** How many distinct `(element, scope, period)` a person has marked this hour (set; expires an hour after the first). */
export const viewedBudgetKey = (userId: string): string => `insight:viewed-budget:${userId}`;

// SADD, a 1 h expiry on the first, and the size, in one step so a crash cannot leave a counter that never ends.
const BUDGET_SCRIPT = `
local added = redis.call('SADD', KEYS[1], ARGV[1])
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], 3600) end
return {added, redis.call('SCARD', KEYS[1])}
`;

// The first time the data went out of step is kept; the last time moves on. Both as milliseconds.
const DIRTY_SCRIPT = `
redis.call('HSETNX', KEYS[1], 'firstAt', ARGV[1])
redis.call('HSET', KEYS[1], 'lastAt', ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;

/**
 * The marks reading an insight leaves in Redis (ADR-029 sections 9.3 and 9.4), O(1) each. They are the only thing a
 * read writes: a read never starts a model call and never creates an `ai_run`; the worker's tick acts on the marks.
 */
@Injectable()
export class InsightMarks {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * Notes that `userId` looked at `(element, scope, period)` in `locale`, unless this person has already marked
   * `INSIGHTS_VIEWED_MARKS_PER_HOUR` different ones this hour (then the read still works and leaves no mark: C-11).
   * Returns whether the mark was made.
   */
  async markViewed(
    userId: string,
    locale: InsightLocale,
    element: string,
    scope: string,
    period: string,
  ): Promise<boolean> {
    const triple = `${element}|${scope}|${period}`;
    const [added, size] = (await this.redis.eval(
      BUDGET_SCRIPT,
      1,
      viewedBudgetKey(userId),
      triple,
    )) as [number, number];
    if (added === 1 && size > INSIGHTS_VIEWED_MARKS_PER_HOUR) {
      await this.redis.srem(viewedBudgetKey(userId), triple);
      return false;
    }
    const key = viewedKey(element, scope, period);
    await this.redis.zadd(key, Date.now(), `${userId}:${locale}`);
    await this.redis.expire(key, VIEWED_TTL_SECONDS);
    return true;
  }

  /** The data no longer matches the stored narration (or there is none): the tick should look at it. */
  async markDirty(key: string): Promise<void> {
    await this.redis.eval(DIRTY_SCRIPT, 1, key, String(Date.now()), String(DIRTY_TTL_SECONDS));
  }
}
