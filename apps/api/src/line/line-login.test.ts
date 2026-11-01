import { describe, expect, it } from 'vitest';

import { lineLoginProviderFor } from './line-login.js';

// The fake LINE Login must never be on by accident (C-2): it needs the explicit flag, and the flag
// does nothing in production. (The boot guard that refuses the flag off a loopback APP_URL or with
// real credentials is tested in packages/shared config.test.ts.)
describe('lineLoginProviderFor', () => {
  it('is off by default, in development and in test', () => {
    expect(
      lineLoginProviderFor({ NODE_ENV: 'development', LINE_LOGIN_FAKE_ENABLED: false }),
    ).toBeNull();
    expect(lineLoginProviderFor({ NODE_ENV: 'test', LINE_LOGIN_FAKE_ENABLED: false })).toBeNull();
  });

  it('is the fake only with the explicit flag', () => {
    expect(
      lineLoginProviderFor({ NODE_ENV: 'development', LINE_LOGIN_FAKE_ENABLED: true }),
    ).not.toBeNull();
  });

  it('is never available in production, flag or not', () => {
    expect(
      lineLoginProviderFor({ NODE_ENV: 'production', LINE_LOGIN_FAKE_ENABLED: true }),
    ).toBeNull();
    expect(
      lineLoginProviderFor({ NODE_ENV: 'production', LINE_LOGIN_FAKE_ENABLED: false }),
    ).toBeNull();
  });
});
