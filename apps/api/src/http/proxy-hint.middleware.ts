import { isIP } from 'node:net';

import type { NextFunction, Request, Response } from 'express';

import type { ApiConfig } from '../config/config.js';
import type { AppLogger } from '../logging/logger.js';

/** At most one warning per this many milliseconds, so a busy api does not log it per request. */
const WARN_EVERY_MS = 10 * 60 * 1000;

/**
 * True for an address that is not on the public internet: loopback, RFC 1918, link-local, unique
 * local IPv6, and the IPv4-mapped form of those. A reverse proxy in front of the api (the compose
 * Caddy, a Cloud Run front end) shows up as one of these.
 */
export function isPrivateAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const text = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  const family = isIP(text);
  if (family === 4) {
    const [a = 0, b = 0] = text.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (family === 6) {
    const lower = text.toLowerCase();
    return (
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80')
    );
  }
  return false;
}

/**
 * Startup-time misconfiguration hint (C-8). With TRUST_PROXY_HOPS=0 Express ignores
 * X-Forwarded-For, which is right when clients reach the api directly. But if requests arrive
 * from a private address *with* that header, a proxy sits in front: the audit log and every rate
 * limit (per-IP login, portal, break-glass lockout) then see the proxy's address for all clients,
 * so one noisy client can lock out or throttle everyone. Warn once per window; change nothing.
 */
export function proxyHint(config: Pick<ApiConfig, 'TRUST_PROXY_HOPS'>, logger: AppLogger) {
  let lastWarned = 0;
  return (request: Request, _response: Response, next: NextFunction): void => {
    if (
      config.TRUST_PROXY_HOPS === 0 &&
      request.headers['x-forwarded-for'] !== undefined &&
      isPrivateAddress(request.socket.remoteAddress) &&
      Date.now() - lastWarned >= WARN_EVERY_MS
    ) {
      lastWarned = Date.now();
      logger.warn(
        { proxy: request.socket.remoteAddress },
        'requests carry X-Forwarded-For from a private address but TRUST_PROXY_HOPS=0: the audit log and rate limits see the proxy, not the client. If the api is reachable only through that proxy (the compose Caddy), set TRUST_PROXY_HOPS=1',
      );
    }
    next();
  };
}
