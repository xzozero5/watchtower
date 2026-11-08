import {
  INSIGHT_ELEMENT_KEYS,
  INSIGHT_ELEMENTS,
  type InsightElementKey,
  type InsightEventKind,
  type InsightLocale,
} from '@watchtower/shared';
import type { Redis } from 'ioredis';

/** Dirty marks nobody turned into a narration expire by themselves. */
export const DIRTY_TTL_SECONDS = 24 * 3600;

/** `insight:viewed:{element}:{scope}:{period}`: a sorted set of `userId:locale` scored by timestamp. */
export const viewedKey = (element: string, scope: string, period: string): string =>
  `insight:viewed:${element}:${scope}:${period}`;

/** `insight:dirty:{element}:{scope}:{period}`: hash with `{firstAt, lastAt}`. */
export const dirtyKey = (element: string, scope: string, period: string): string =>
  `insight:dirty:${element}:${scope}:${period}`;

/** User-scoped dirty mark: `insight:dirty:user:{userId}:{element}`. */
export const userDirtyKey = (userId: string, element: string): string =>
  `insight:dirty:user:${userId}:${element}`;

const DIRTY_SCRIPT = `
redis.call('HSETNX', KEYS[1], 'firstAt', ARGV[1])
redis.call('HSET', KEYS[1], 'lastAt', ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;

export async function markDirty(
  redis: Redis,
  key: string,
  nowMs: number = Date.now(),
): Promise<void> {
  await redis.eval(DIRTY_SCRIPT, 1, key, String(nowMs), String(DIRTY_TTL_SECONDS));
}

export async function clearDirty(redis: Redis, key: string): Promise<void> {
  await redis.del(key);
}

export interface DirtyTimes {
  readonly firstAt: number;
  readonly lastAt: number;
}

export async function readDirtyTimes(redis: Redis, key: string): Promise<DirtyTimes | null> {
  const hash = await redis.hgetall(key);
  if (!hash.firstAt || !hash.lastAt) return null;
  const firstAt = Number(hash.firstAt);
  const lastAt = Number(hash.lastAt);
  if (!Number.isFinite(firstAt) || !Number.isFinite(lastAt)) return null;
  return { firstAt, lastAt };
}

export interface ViewedStats {
  readonly total: number;
  readonly uniqueUsers: number;
  readonly locales: readonly InsightLocale[];
  readonly userIds: readonly string[];
}

/**
 * Removes views older than the window, then calculates distinct viewers and requested locales (AC-J16).
 */
export async function getViewedStats(
  redis: Redis,
  element: string,
  scope: string,
  period: string,
  viewedWithinHours: number = 24,
  nowMs: number = Date.now(),
): Promise<ViewedStats> {
  const key = viewedKey(element, scope, period);
  const cutoff = nowMs - viewedWithinHours * 3600_000;

  // Prune expired views
  await redis.zremrangebyscore(key, '-inf', String(cutoff));

  // Retrieve remaining active viewers
  const members = await redis.zrange(key, '0', '-1');
  if (members.length === 0) {
    return { total: 0, uniqueUsers: 0, locales: [], userIds: [] };
  }

  const userIds = new Set<string>();
  const locales = new Set<InsightLocale>();

  for (const member of members) {
    const colon = member.lastIndexOf(':');
    if (colon > 0) {
      const uid = member.slice(0, colon);
      const loc = member.slice(colon + 1);
      if (uid) userIds.add(uid);
      if (loc === 'th' || loc === 'en') locales.add(loc);
    } else if (member) {
      userIds.add(member);
      locales.add('en');
    }
  }

  return {
    total: members.length,
    uniqueUsers: userIds.size,
    locales: [...locales],
    userIds: [...userIds],
  };
}

export interface DirtyCandidate {
  readonly dirtyKey: string;
  readonly element: InsightElementKey;
  readonly scopeKey: string;
  readonly period: string;
  readonly isUserScoped: boolean;
  readonly subjectUserId?: string;
  readonly firstAt: number;
  readonly lastAt: number;
}

/**
 * Scans Redis for all dirty marks and parses their element and scope identifiers.
 */
export async function listDirtyCandidates(redis: Redis): Promise<DirtyCandidate[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', 'insight:dirty:*', 'COUNT', 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');

  const candidates: DirtyCandidate[] = [];

  for (const key of keys) {
    const times = await readDirtyTimes(redis, key);
    if (times === null) continue;

    // Pattern 1: user scoped `insight:dirty:user:{userId}:{element}`
    if (key.startsWith('insight:dirty:user:')) {
      const rest = key.slice('insight:dirty:user:'.length);
      const colon = rest.indexOf(':');
      if (colon > 0) {
        const userId = rest.slice(0, colon);
        const elementStr = rest.slice(colon + 1) as InsightElementKey;
        if (INSIGHT_ELEMENT_KEYS.includes(elementStr)) {
          candidates.push({
            dirtyKey: key,
            element: elementStr,
            scopeKey: `user:${userId}`,
            period: '-',
            isUserScoped: true,
            subjectUserId: userId,
            firstAt: times.firstAt,
            lastAt: times.lastAt,
          });
        }
      }
      continue;
    }

    // Pattern 2: standard `insight:dirty:{element}:{scope}:{period}`
    const parts = key.slice('insight:dirty:'.length).split(':');
    if (parts.length >= 3) {
      const elementStr = parts[0] as InsightElementKey;
      const period = parts[parts.length - 1];
      const scope = parts.slice(1, -1).join(':');

      if (INSIGHT_ELEMENT_KEYS.includes(elementStr) && period) {
        candidates.push({
          dirtyKey: key,
          element: elementStr,
          scopeKey: scope,
          period,
          isUserScoped: false,
          firstAt: times.firstAt,
          lastAt: times.lastAt,
        });
      }
    }
  }

  return candidates;
}

export interface MarkInsightDirtyOptions {
  readonly scopeKey?: string;
  readonly userId?: string;
  readonly nowMs?: number;
}

/**
 * Marks dirty any element whose trigger list includes `eventKind` (ADR-029 section 9.4).
 * O(1) Redis call. Best-effort.
 */
export async function markInsightDirty(
  redis: Redis,
  eventKind: InsightEventKind,
  options?: MarkInsightDirtyOptions,
): Promise<void> {
  const now = options?.nowMs ?? Date.now();

  for (const key of INSIGHT_ELEMENT_KEYS) {
    const el = INSIGHT_ELEMENTS[key];
    if (el.mode === 'X') continue;
    if (!el.triggers.includes(eventKind)) continue;

    if (el.scope === 'user') {
      if (options?.userId) {
        await markDirty(redis, userDirtyKey(options.userId, key), now);
      }
      continue;
    }

    if (el.scope === 'instance') {
      const scopeKey = options?.scopeKey ?? 'instance';
      if (scopeKey !== 'instance') continue;

      for (const spec of el.periods) {
        const period = spec.kind === 'now' ? 'now' : spec.kind === 'none' ? '-' : 'd7';
        await markDirty(redis, dirtyKey(key, 'instance', period), now);
      }
    }
  }
}
