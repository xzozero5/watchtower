import { describe, expect, it } from 'vitest';

import { safeReturnPath, stepUpUrl } from './providers';

describe('safeReturnPath normalization (T-306k C-17)', () => {
  it('resolves dot segments and keeps the query', () => {
    expect(safeReturnPath('/a/./b/../c?x=1#h')).toBe('/a/c?x=1#h');
  });
});

describe('stepUpUrl', () => {
  it('points at the api step-up route with the return path', () => {
    const url = stepUpUrl('http://api.test', '/admin/intents/1?tab=stage3&approve=2');
    expect(url).not.toBeNull();
    const parsed = new URL(url ?? '');
    expect(parsed.origin + parsed.pathname).toBe('http://api.test/v1/auth/google/step-up');
    expect(parsed.searchParams.get('returnTo')).toBe('/admin/intents/1?tab=stage3&approve=2');
  });

  it.each([
    '',
    'https://evil.example/x',
    '//evil.example',
    '/a\\b',
    '/.//evil.example',
    '/..//evil.example',
    '/a/..//evil.example',
    '/%2e//evil.example',
    '/a\nb',
    `/${'x'.repeat(200)}`,
  ])('refuses a return path that is not same-origin and safe: %j', (value) => {
    expect(safeReturnPath(value)).toBeNull();
    expect(stepUpUrl('http://api.test', value)).toBeNull();
  });
});
