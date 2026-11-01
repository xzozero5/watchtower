import { describe, expect, it } from 'vitest';

import {
  DEFAULT_JOB_OPTIONS,
  LOG_REDACT_PATHS,
  QUEUE_NAMES,
  parseRedisUrl,
  sanitizeUrlForLog,
  serializeErrorForLog,
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

describe('serializeErrorForLog', () => {
  class WithFields extends Error {
    override readonly name = 'WithFields';
    constructor(
      readonly code: string,
      readonly responseBody: string,
      options?: { cause?: unknown },
    ) {
      super('failed', options);
    }
  }

  it('keeps type, message, stack and flat fields, and drops payload fields', () => {
    const out = serializeErrorForLog(new WithFields('E1', 'SECRET-BODY')) as Record<
      string,
      unknown
    >;
    expect(out).toMatchObject({ type: 'WithFields', message: 'failed', code: 'E1' });
    expect(typeof out.stack).toBe('string');
    expect(JSON.stringify(out)).not.toContain('SECRET-BODY');
  });

  it('replaces the cause chain, including an AggregateError, with type names only', () => {
    const inner = Object.assign(new TypeError('INNER-MESSAGE'), { requestBodyValues: 'X' });
    const error = new WithFields('E2', 'b', {
      cause: new AggregateError([inner, new RangeError('RANGE-MESSAGE')], 'AGG-MESSAGE', {
        cause: inner,
      }),
    });
    const out = serializeErrorForLog(error) as Record<string, unknown>;
    const json = JSON.stringify(out);
    for (const text of ['INNER-MESSAGE', 'RANGE-MESSAGE', 'AGG-MESSAGE']) {
      expect(json).not.toContain(text);
    }
    expect(out.causeTypes).toEqual(['AggregateError', 'TypeError', 'TypeError', 'RangeError']);
    expect(out).not.toHaveProperty('cause');
  });

  it('passes a primitive through and does not walk an object that is not an Error', () => {
    expect(serializeErrorForLog('plain')).toBe('plain');
    expect(serializeErrorForLog({ secret: 'x' })).toEqual({ type: 'NonError' });
  });

  it('stops at a deep or circular chain', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    const b: Error & { cause?: unknown } = new Error('b');
    a.cause = b;
    b.cause = a;
    const out = serializeErrorForLog(a) as { causeTypes: string[] };
    expect(out.causeTypes.length).toBeLessThanOrEqual(10);
  });
});
