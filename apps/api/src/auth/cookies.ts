import { ACCESS_COOKIE, REFRESH_COOKIE } from '@watchtower/shared';
import type { CookieOptions, Request, Response } from 'express';

import type { ApiConfig } from '../config/config.js';

/** Cookie that carries the OIDC state, PKCE verifier and nonce between /start and /callback. */
export const OIDC_COOKIE = 'wt_oidc';

/** Parses a Cookie request header. Later duplicates of a name are ignored. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (cookies.has(name)) continue;
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      cookies.set(name, value);
    }
  }
  return cookies;
}

export function readCookie(request: Request, name: string): string | undefined {
  return parseCookies(request.headers.cookie).get(name);
}

type CookieSettings = Pick<ApiConfig, 'cookieSecure'>;

/**
 * Both session cookies are HttpOnly (no script can read a token) and Secure outside local http.
 * The access cookie is SameSite=Lax; the refresh cookie is SameSite=Strict because only a
 * same-site fetch to /v1/auth/refresh ever needs it. Neither sets Domain (host-only) or a path
 * narrower than `/`: a reverse proxy may mount the api under a prefix such as /api, and a cookie
 * path would then silently stop matching.
 */
export function accessCookieOptions(
  settings: CookieSettings,
  maxAgeSeconds: number,
): CookieOptions {
  return {
    httpOnly: true,
    secure: settings.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  };
}

export function refreshCookieOptions(
  settings: CookieSettings,
  maxAgeSeconds: number,
): CookieOptions {
  return {
    httpOnly: true,
    secure: settings.cookieSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  };
}

export interface CookieTokens {
  readonly accessToken: string;
  readonly accessMaxAgeSeconds: number;
  readonly refreshToken: string;
  readonly refreshMaxAgeSeconds: number;
}

export function setSessionCookies(
  response: Response,
  settings: CookieSettings,
  tokens: CookieTokens,
): void {
  response.cookie(
    ACCESS_COOKIE,
    tokens.accessToken,
    accessCookieOptions(settings, tokens.accessMaxAgeSeconds),
  );
  response.cookie(
    REFRESH_COOKIE,
    tokens.refreshToken,
    refreshCookieOptions(settings, tokens.refreshMaxAgeSeconds),
  );
}

export function clearSessionCookies(response: Response, settings: CookieSettings): void {
  // Attributes must match the ones the cookie was set with, or the browser keeps the old cookie.
  response.clearCookie(ACCESS_COOKIE, {
    httpOnly: true,
    secure: settings.cookieSecure,
    sameSite: 'lax',
    path: '/',
  });
  response.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: settings.cookieSecure,
    sameSite: 'strict',
    path: '/',
  });
}
