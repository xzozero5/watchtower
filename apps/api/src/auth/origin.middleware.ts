import type { NextFunction, Request, Response } from 'express';

import type { ApiConfig } from '../config/config.js';
import type { AppLogger } from '../logging/logger.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence in depth, applied to every unsafe request before routing.
 *
 * A browser attaches an `Origin` header to every cross-origin POST/PUT/PATCH/DELETE. If it is
 * present it must be the web app (APP_URL) or the api's own origin (Swagger UI at /docs); anything
 * else, including `Origin: null`, is refused. A request with no Origin is not a browser form or
 * fetch from another site (curl, server-to-server), so cookie CSRF does not apply, and the
 * authenticated routes still demand the per-session `x-csrf-token`.
 *
 * Cookies are SameSite=Lax/Strict and CORS allows credentials for one origin only, so this is the
 * third layer, not the only one.
 */
export function originCheck(config: Pick<ApiConfig, 'APP_URL' | 'API_URL'>, logger: AppLogger) {
  const allowed = new Set([new URL(config.APP_URL).origin, new URL(config.API_URL).origin]);
  return (request: Request, response: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(request.method)) {
      next();
      return;
    }
    const origin = request.headers.origin;
    if (origin === undefined || allowed.has(origin)) {
      next();
      return;
    }
    logger.warn(
      { origin: origin.slice(0, 200), method: request.method },
      'refused request from a foreign origin',
    );
    response.status(403).json({
      statusCode: 403,
      error: 'Forbidden',
      code: 'origin_not_allowed',
      message: 'Requests from this origin are not allowed',
    });
  };
}
