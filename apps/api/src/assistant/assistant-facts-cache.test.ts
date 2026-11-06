import { describe, expect, it, vi } from 'vitest';

import { AssistantFactsCache, type AssistantCacheScope } from './assistant-facts-cache.js';

const scope: AssistantCacheScope = {
  userId: 'user-1',
  role: 'agent',
  permissions: ['b', 'a'],
  locale: 'en',
  starter: 'team_status',
  promptVersion: 'v1',
};
const facts = [{ text: '[NAME_1] has 2 tickets.', ref: { kind: 'user', id: 'person-1' } }];

describe('assistant deterministic fact cache (C-12)', () => {
  const setup = () => {
    const values = new Map<string, string>();
    const redis = {
      get: vi.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
      set: vi.fn((key: string, value: string) => {
        values.set(key, value);
        return Promise.resolve('OK' as const);
      }),
    };
    const cache = new AssistantFactsCache(redis, {
      APP_ENCRYPTION_KEY: 'test-only-key',
      RATE_LIMIT_NAMESPACE: 'test',
    });
    return { cache, redis, values };
  };

  it('keys by user, sorted permission set, role, starter, locale, prompt and fresh fact fingerprint', () => {
    const { cache } = setup();
    const key = cache.key(scope, facts);
    expect(cache.key({ ...scope, permissions: ['a', 'b'] }, facts)).toBe(key);
    for (const change of [
      { userId: 'user-2' },
      { permissions: ['a'] },
      { role: 'dev' },
      { starter: 'other' },
      { locale: 'th' },
      { promptVersion: 'v2' },
    ]) {
      expect(cache.key({ ...scope, ...change }, facts)).not.toBe(key);
    }
    expect(
      cache.key(scope, [{ text: 'different', ref: { kind: 'user', id: 'person-1' } }]),
    ).not.toBe(key);
  });

  it('stores only redacted text/ref, expires in ten minutes, and accepts only matching fresh payload', async () => {
    const { cache, redis, values } = setup();
    expect(await cache.resolve(scope, facts)).toEqual(facts);
    expect(redis.set).toHaveBeenCalledWith(
      cache.key(scope, facts),
      JSON.stringify(facts),
      'EX',
      600,
    );
    expect(await cache.resolve(scope, facts)).toEqual(facts);
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect([...values.values()].join('')).not.toMatch(/tokens|snapshot|tokenMap/);
    values.set(cache.key(scope, facts), JSON.stringify([{ ...facts[0], text: 'poisoned' }]));
    expect(await cache.resolve(scope, facts)).toEqual(facts);
    values.set(cache.key(scope, facts), '{bad json');
    expect(await cache.resolve(scope, facts)).toEqual(facts);
  });
});
