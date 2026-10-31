import { describe, expect, it } from 'vitest';

import {
  DEFAULT_JOB_OPTIONS,
  LOG_REDACT_PATHS,
  QUEUE_NAMES,
  parseRedisUrl,
  sanitizeUrlForLog,
} from './index.js';

describe('parseRedisUrl', () => {
  it('splits host, port and database', () => {
    expect(parseRedisUrl('redis://cache.internal:6380/2')).toEqual({
      host: 'cache.internal',
      port: 6380,
      db: 2,
    });
  });

  it('defaults the port and keeps credentials out of the host', () => {
    expect(parseRedisUrl('redis://user:p%40ss@localhost')).toEqual({
      host: 'localhost',
      port: 6379,
      username: 'user',
      password: 'p@ss',
    });
  });

  it('enables TLS for rediss', () => {
    expect(parseRedisUrl('rediss://localhost:6379').tls).toEqual({});
  });

  it('rejects other schemes and bad databases', () => {
    expect(() => parseRedisUrl('http://localhost')).toThrow(/scheme/);
    expect(() => parseRedisUrl('redis://localhost/abc')).toThrow(/database/);
  });
});

describe('sanitizeUrlForLog', () => {
  it('drops the query string, which may carry a token', () => {
    expect(sanitizeUrlForLog('/portal/track?token=abc123')).toBe('/portal/track');
  });

  it('drops credentials from absolute urls', () => {
    expect(sanitizeUrlForLog('postgres://user:pw@db:5432/app?sslmode=require')).toBe(
      'postgres://db:5432/app',
    );
  });
});

describe('logging and queue constants', () => {
  it('censors the usual credential fields', () => {
    expect(LOG_REDACT_PATHS).toEqual(
      expect.arrayContaining([
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.token',
      ]),
    );
  });

  it('names the system queue and retries with backoff', () => {
    expect(QUEUE_NAMES.system).toBe('system');
    expect(DEFAULT_JOB_OPTIONS.attempts).toBeGreaterThan(1);
  });
});
