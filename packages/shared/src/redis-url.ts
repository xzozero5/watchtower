export interface RedisConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly db?: number;
  /** Present when the URL scheme is `rediss:`. */
  readonly tls?: Record<string, never>;
}

/**
 * Splits a Redis URL into connection options. BullMQ and ioredis accept these directly, which
 * avoids sharing one ioredis instance (and its type) across package versions.
 */
export function parseRedisUrl(url: string): RedisConnectionOptions {
  const parsed = new URL(url);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`Unsupported Redis URL scheme "${parsed.protocol}"`);
  }
  const dbSegment = parsed.pathname.replace(/^\//, '');
  const db = dbSegment === '' ? undefined : Number(dbSegment);
  if (db !== undefined && (!Number.isInteger(db) || db < 0)) {
    throw new Error('Redis URL database must be a non-negative integer');
  }
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? 6379 : Number(parsed.port),
    ...(parsed.username === '' ? {} : { username: decodeURIComponent(parsed.username) }),
    ...(parsed.password === '' ? {} : { password: decodeURIComponent(parsed.password) }),
    ...(db === undefined ? {} : { db }),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}
