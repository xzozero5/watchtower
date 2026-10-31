import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import {
  accessCookieOptions,
  clearSessionCookies,
  parseCookies,
  refreshCookieOptions,
  setSessionCookies,
} from './cookies.js';

describe('parseCookies', () => {
  it('reads name=value pairs, decoding values', () => {
    const cookies = parseCookies('wt_at=abc.def; wt_rt=x%20y; other="quoted"');
    expect(cookies.get('wt_at')).toBe('abc.def');
    expect(cookies.get('wt_rt')).toBe('x y');
    expect(cookies.get('other')).toBe('quoted');
  });

  it('keeps the first of a duplicated name and ignores junk', () => {
    const cookies = parseCookies('a=1; a=2; ; =3; novalue; b=%E0%A4%A');
    expect(cookies.get('a')).toBe('1');
    expect(cookies.has('novalue')).toBe(false);
    expect(cookies.get('b')).toBe('%E0%A4%A');
  });

  it('returns nothing for a missing header', () => {
    expect(parseCookies(undefined).size).toBe(0);
    expect(parseCookies('').size).toBe(0);
  });
});

describe('session cookie attributes', () => {
  it('are HttpOnly with the right SameSite, host-only, path / and Secure when asked', () => {
    const access = accessCookieOptions({ cookieSecure: true }, 900);
    const refresh = refreshCookieOptions({ cookieSecure: true }, 3600);
    expect(access).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 900_000,
    });
    expect(refresh).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 3_600_000,
    });
    expect(access).not.toHaveProperty('domain');
    expect(accessCookieOptions({ cookieSecure: false }, 1).secure).toBe(false);
  });

  it('are set and cleared with the same attributes', () => {
    const cookie = vi.fn();
    const clearCookie = vi.fn();
    const response = { cookie, clearCookie } as unknown as Response;
    setSessionCookies(
      response,
      { cookieSecure: false },
      {
        accessToken: 'a',
        accessMaxAgeSeconds: 10,
        refreshToken: 'r',
        refreshMaxAgeSeconds: 20,
      },
    );
    clearSessionCookies(response, { cookieSecure: false });
    expect(cookie).toHaveBeenCalledTimes(2);
    expect(clearCookie).toHaveBeenCalledTimes(2);
    for (const [index, name] of ['wt_at', 'wt_rt'].entries()) {
      const set = cookie.mock.calls[index] as [string, string, Record<string, unknown>];
      const cleared = clearCookie.mock.calls[index] as [string, Record<string, unknown>];
      expect(set[0]).toBe(name);
      expect(cleared[0]).toBe(name);
      expect(cleared[1]).toMatchObject({
        httpOnly: true,
        sameSite: set[2].sameSite,
        path: set[2].path,
        secure: set[2].secure,
      });
    }
  });
});
