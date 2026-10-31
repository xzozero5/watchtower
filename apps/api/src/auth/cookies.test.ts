import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import {
  HOST_PREFIX,
  accessCookieOptions,
  clearOidcCookie,
  clearSessionCookies,
  cookieNames,
  hasDuplicateCookie,
  oidcCookieOptions,
  parseCookieHeader,
  parseCookies,
  readCookie,
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

describe('cookie names (C-6)', () => {
  it('are bare on plain local http and carry the __Host- prefix when cookies are Secure', () => {
    expect(cookieNames({ cookieSecure: false })).toEqual({
      access: 'wt_at',
      refresh: 'wt_rt',
      oidc: 'wt_oidc',
    });
    expect(cookieNames({ cookieSecure: true })).toEqual({
      access: '__Host-wt_at',
      refresh: '__Host-wt_rt',
      oidc: '__Host-wt_oidc',
    });
    expect(HOST_PREFIX).toBe('__Host-');
  });

  it('are set and cleared under the prefixed name with the attributes __Host- requires', () => {
    const cookie = vi.fn();
    const clearCookie = vi.fn();
    const response = { cookie, clearCookie } as unknown as Response;
    const secure = { cookieSecure: true };
    setSessionCookies(response, secure, {
      accessToken: 'a',
      accessMaxAgeSeconds: 10,
      refreshToken: 'r',
      refreshMaxAgeSeconds: 20,
    });
    clearSessionCookies(response, secure);
    clearOidcCookie(response, secure);
    const sets = cookie.mock.calls as [string, string, Record<string, unknown>][];
    expect(sets.map((call) => call[0])).toEqual(['__Host-wt_at', '__Host-wt_rt']);
    const clears = clearCookie.mock.calls as [string, Record<string, unknown>][];
    expect(clears.map((call) => call[0])).toEqual([
      '__Host-wt_at',
      '__Host-wt_rt',
      '__Host-wt_oidc',
    ]);
    for (const [, options] of [...sets.map((c) => [c[0], c[2]] as const), ...clears]) {
      // A browser drops a __Host- cookie unless it is Secure, has Path=/ and has no Domain.
      expect(options).toMatchObject({ secure: true, path: '/', httpOnly: true });
      expect(options).not.toHaveProperty('domain');
    }
    expect(oidcCookieOptions(secure)).toMatchObject({ secure: true, path: '/', sameSite: 'lax' });
  });
});

describe('duplicate auth cookies (C-6)', () => {
  const requestWith = (cookie: string | undefined) =>
    ({ headers: cookie === undefined ? {} : { cookie } }) as unknown as Request;

  it('records which names were repeated', () => {
    const parsed = parseCookieHeader('wt_at=one; other=1; wt_at=two; wt_at=three');
    expect([...parsed.duplicates]).toEqual(['wt_at']);
    expect(parsed.values.get('wt_at')).toBe('one');
  });

  it('reads a single cookie normally', () => {
    expect(readCookie(requestWith('wt_at=abc; x=1'), 'wt_at')).toBe('abc');
    expect(readCookie(requestWith('x=1'), 'wt_at')).toBeUndefined();
    expect(readCookie(requestWith(undefined), 'wt_at')).toBeUndefined();
  });

  it('trusts neither copy of a repeated cookie: it reads as absent', () => {
    const request = requestWith('wt_at=planted; wt_at=real');
    expect(readCookie(request, 'wt_at')).toBeUndefined();
    expect(hasDuplicateCookie(request, 'wt_at')).toBe(true);
    expect(hasDuplicateCookie(request, 'wt_rt')).toBe(false);
    expect(hasDuplicateCookie(request, 'wt_rt', 'wt_at')).toBe(true);
    // Another repeated cookie does not make ours unreadable.
    expect(readCookie(requestWith('wt_at=real; tracking=1; tracking=2'), 'wt_at')).toBe('real');
  });
});
