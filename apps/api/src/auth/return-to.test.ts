import { describe, expect, it } from 'vitest';

import { sanitizeReturnTo } from './google-oidc.service.js';

describe('sanitizeReturnTo (T-306k C-17)', () => {
  it.each([
    '/.//evil.example',
    '/..//evil.example',
    '/a/..//evil.example',
    '/%2e//evil.example',
    '//evil.example',
    '/\\evil.example',
    'https://evil.example',
    '',
  ])('refuses %j and falls back to /', (value) => {
    expect(sanitizeReturnTo(value)).toBe('/');
  });

  it('returns the normalized path of a safe target', () => {
    expect(sanitizeReturnTo('/admin/intents/1?tab=stage3')).toBe('/admin/intents/1?tab=stage3');
    expect(sanitizeReturnTo('/a/./b/../c?x=1')).toBe('/a/c?x=1');
  });
});
