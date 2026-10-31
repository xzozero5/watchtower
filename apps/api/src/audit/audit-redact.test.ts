import { describe, expect, it } from 'vitest';

import { generateOpaqueToken } from '../auth/token.service.js';
import { REDACTED, redactForAudit } from './audit-redact.js';

describe('redactForAudit', () => {
  it('censors secret-looking keys at any depth, whatever their case or style', () => {
    const out = redactForAudit({
      password: 'p',
      Password: 'p',
      passwd: 'p',
      secret: 's',
      clientSecret: 's',
      token: 't',
      accessToken: 't',
      refresh_token: 't',
      tokenHash: 'h',
      passwordHash: 'h',
      authorization: 'Bearer x',
      cookie: 'a=b',
      apiKey: 'k',
      api_key: 'k',
      privateKey: 'k',
      csrfToken: 'c',
      codeChallenge: 'c',
      nested: { deeper: [{ password: 'p', fine: 'visible' }] },
    }) as Record<string, unknown>;
    const flat = JSON.stringify(out);
    for (const word of ['"p"', '"s"', '"t"', '"h"', '"k"', '"c"', 'Bearer x', 'a=b']) {
      expect(flat, word).not.toContain(word);
    }
    expect(out.password).toBe(REDACTED);
    expect(out.tokenHash).toBe(REDACTED);
    expect(out.nested).toEqual({ deeper: [{ password: REDACTED, fine: 'visible' }] });
  });

  it('keeps ordinary data, including the ids and names an audit trail exists for', () => {
    const input = {
      id: '6d8f0a1e-0000-4000-8000-000000000001',
      email: 'person@example.com',
      role: 'head',
      count: 3,
      active: true,
      empty: null,
      sessionId: '6d8f0a1e-0000-4000-8000-000000000002',
      when: new Date('2026-01-02T03:04:05.000Z'),
    };
    expect(redactForAudit(input)).toEqual({ ...input, when: '2026-01-02T03:04:05.000Z' });
  });

  it('censors credentials by the shape of the value, even under an innocent key', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const out = redactForAudit({
      note: jwt,
      header: 'Bearer abcdef.ghijkl',
      stored: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g',
      opaque: generateOpaqueToken(),
      plain: 'a normal sentence',
    }) as Record<string, string>;
    expect(out.note).toBe(REDACTED);
    expect(out.header).toBe(REDACTED);
    expect(out.stored).toBe(REDACTED);
    expect(out.opaque).toBe(REDACTED);
    expect(out.plain).toBe('a normal sentence');
  });

  it('bounds size: deep nesting, long arrays and long strings are cut', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    expect(JSON.stringify(redactForAudit(deep))).toContain('[TRUNCATED]');

    const many = redactForAudit(Array.from({ length: 500 }, (_, i) => i)) as unknown[];
    expect(many).toHaveLength(101);
    expect(many.at(-1)).toBe('[TRUNCATED]');

    const long = redactForAudit('x'.repeat(5000)) as string;
    expect(long.length).toBeLessThan(2100);
  });

  it('does not mutate its input', () => {
    const input = { password: 'p', list: [{ token: 't' }] };
    redactForAudit(input);
    expect(input).toEqual({ password: 'p', list: [{ token: 't' }] });
  });

  it('turns undefined into null and drops undefined fields', () => {
    expect(redactForAudit(undefined)).toBeNull();
    expect(redactForAudit({ a: undefined, b: 1 })).toEqual({ b: 1 });
  });
});
