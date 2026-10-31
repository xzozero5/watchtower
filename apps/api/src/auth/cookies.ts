import { ACCESS_COOKIE, REFRESH_COOKIE } from '@watchtower/shared';
import type { CookieOptions, Request, Response } from 'express';

import type { ApiConfig } from '../config/config.js';

/** Base name of the cookie that carries the OIDC state, PKCE verifier and nonce between /start and /callback. */
export const OIDC_COOKIE = 'wt_oidc';

/** `__Host-` makes a browser accept the cookie only if it is Secure, host-only and Path=/. */
export const HOST_PREFIX = '__Host-';

type CookieSettings = Pick<ApiConfig, 'cookieSecure'>;

export interface CookieNames {
  readonly access: string;
  readonly refresh: string;
  readonly oidc: string;
}

/**
 * The names the api sets and reads. When cookies are Secure they carry the `__Host-` prefix, so a
 * sibling subdomain (or a plain-http page) cannot plant a cookie of the same name that the
 * browser would then send in place of ours (cookie tossing / session fixation): the browser
 * refuses to store a `__Host-` cookie that has a Domain attribute or is not Secure. On plain local
 * http (cookieSecure false) the prefix is impossible, so the bare names are used.
 */
export function cookieNames(settings: CookieSettings): CookieNames {
  const prefix = settings.cookieSecure ? HOST_PREFIX : '';
  return {
    access: `${prefix}${ACCESS_COOKIE}`,
    refresh: `${prefix}${REFRESH_COOKIE}`,
    oidc: `${prefix}${OIDC_COOKIE}`,
  };
}

export interface ParsedCookies {
  /** The first value of each name. */
  readonly values: Map<string, string>;
  /** Names that appeared more than once. */
  readonly duplicates: Set<string>;
}

/** Parses a Cookie request header and records which names were repeated. */
export function parseCookieHeader(header: string | undefined): ParsedCookies {
  const values = new Map<string, string>();
  const duplicates = new Set<string>();
  if (!header) return { values, duplicates };
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (values.has(name)) {
      duplicates.add(name);
      continue;
    }
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    try {
      values.set(name, decodeURIComponent(value));
    } catch {
      values.set(name, value);
    }
  }
  return { values, duplicates };
}

/** Parses a Cookie request header. Later duplicates of a name are ignored; see `parseCookieHeader` to detect them. */
export function parseCookies(header: string | undefined): Map<string, string> {
  return parseCookieHeader(header).values;
}

/**
 * The value of a cookie, or undefined when it is absent **or sent more than once**. Two cookies of
 * one name mean something other than our own response set them (a sibling subdomain, a proxy, a
 * script on another path); which one the browser lists first is not under our control, so we trust
 * neither and the request is treated as having no credentials (401).
 */
export function readCookie(request: Request, name: string): string | undefined {
  const { values, duplicates } = parseCookieHeader(request.headers.cookie);
  return duplicates.has(name) ? undefined : values.get(name);
}

/** True when the request repeats any of the named cookies. */
export function hasDuplicateCookie(request: Request, ...names: readonly string[]): boolean {
  const { duplicates } = parseCookieHeader(request.headers.cookie);
  return names.some((name) => duplicates.has(name));
}

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
  const names = cookieNames(settings);
  response.cookie(
    names.access,
    tokens.accessToken,
    accessCookieOptions(settings, tokens.accessMaxAgeSeconds),
  );
  response.cookie(
    names.refresh,
    tokens.refreshToken,
    refreshCookieOptions(settings, tokens.refreshMaxAgeSeconds),
  );
}

export function clearSessionCookies(response: Response, settings: CookieSettings): void {
  // Attributes must match the ones the cookie was set with, or the browser keeps the old cookie.
  const names = cookieNames(settings);
  response.clearCookie(names.access, {
    httpOnly: true,
    secure: settings.cookieSecure,
    sameSite: 'lax',
    path: '/',
  });
  response.clearCookie(names.refresh, {
    httpOnly: true,
    secure: settings.cookieSecure,
    sameSite: 'strict',
    path: '/',
  });
}

/** The OIDC state cookie: short-lived, HttpOnly, Lax (the redirect back from Google is a top-level GET). */
export function oidcCookieOptions(settings: CookieSettings): CookieOptions {
  return {
    httpOnly: true,
    secure: settings.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60 * 1000,
  };
}

export function clearOidcCookie(response: Response, settings: CookieSettings): void {
  // A `__Host-` cookie can only be overwritten or expired by a Set-Cookie that is Secure with Path=/.
  response.clearCookie(cookieNames(settings).oidc, {
    httpOnly: true,
    secure: settings.cookieSecure,
    sameSite: 'lax',
    path: '/',
  });
}
