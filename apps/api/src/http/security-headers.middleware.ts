import type { NextFunction, Request, Response } from 'express';

import type { ApiConfig } from '../config/config.js';

/** One year; the browser then refuses plain http for this host (production only). */
export const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

type SecurityHeaderSettings = Pick<ApiConfig, 'NODE_ENV'>;

/** True for `/v1/auth` and everything under it. */
export function isAuthPath(path: string): boolean {
  return path === '/v1/auth' || path.startsWith('/v1/auth/');
}

/**
 * Response headers for every reply of the api, errors included (they are set before routing):
 *
 *  - `X-Content-Type-Options: nosniff`: a JSON body is never reinterpreted as script or HTML.
 *  - `Content-Security-Policy: frame-ancestors 'none'`: nothing the api serves may be framed
 *    (clickjacking). It is the only directive on purpose: the api returns JSON, and the Swagger UI
 *    under /docs needs its own inline scripts, so a fuller policy would break it for no gain.
 *  - `Referrer-Policy: no-referrer`: the api's URLs (tracking, callbacks) are not shared onward.
 *  - `Cache-Control: no-store` on `/v1/auth/*`: sessions, CSRF tokens and sign-in results must not
 *    sit in a browser or proxy cache. Other routes keep Express' defaults (the portal sets its own).
 *  - `Strict-Transport-Security` only in production: sent over plain local http it is ignored by
 *    browsers at best, and a pinned `localhost` at worst.
 */
export function securityHeaders(settings: SecurityHeaderSettings) {
  const production = settings.NODE_ENV === 'production';
  return (request: Request, response: Response, next: NextFunction): void => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (isAuthPath(request.path)) response.setHeader('Cache-Control', 'no-store');
    if (production) response.setHeader('Strict-Transport-Security', HSTS_VALUE);
    next();
  };
}
