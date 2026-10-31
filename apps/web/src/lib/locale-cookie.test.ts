import { describe, expect, it } from 'vitest';

import { localeCookieValue, saveLocale } from './locale-cookie';

describe('locale cookie', () => {
  it('writes the name, value, path, lifetime and SameSite', () => {
    expect(localeCookieValue('th')).toBe('wt-locale=th; Path=/; Max-Age=31536000; SameSite=Lax');
  });

  it('saves through document.cookie', () => {
    const doc = { cookie: '' };
    saveLocale('en', doc);
    expect(doc.cookie).toContain('wt-locale=en');
  });
});
