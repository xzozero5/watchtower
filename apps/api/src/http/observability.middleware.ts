import { randomUUID } from 'node:crypto';

import { sanitizeUrlForLog } from '@watchtower/shared';
import type { NextFunction, Request, Response } from 'express';

import type { AppLogger } from '../logging/logger.js';
import type { TelemetryService } from '../telemetry/telemetry.service.js';

export const REQUEST_ID_HEADER = 'x-request-id';

// Accept a caller-supplied id only when it is short and printable, so it cannot forge log lines.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Paths that are scraped or polled constantly; logged at debug so they do not drown real traffic. */
const QUIET_PATHS = new Set(['/health', '/health/ready', '/metrics']);

function matchedRoute(request: Request): string {
  const route: unknown = request.route;
  if (typeof route === 'object' && route !== null && 'path' in route) {
    const path = route.path;
    if (typeof path === 'string') return path;
  }
  return 'unmatched';
}

/**
 * One middleware for everything per-request: request id, access log, Prometheus histogram and a
 * trace span. The access log carries the path only; query strings can hold signed tokens.
 */
export function observability(logger: AppLogger, telemetry: TelemetryService) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const supplied = request.header(REQUEST_ID_HEADER);
    const requestId = supplied && SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID();
    response.setHeader(REQUEST_ID_HEADER, requestId);

    const path = sanitizeUrlForLog(request.originalUrl);
    const started = performance.now();
    const span = telemetry.startRequest(request.method, path);

    response.once('close', () => {
      const durationMs = performance.now() - started;
      const statusCode = response.statusCode;
      const route = matchedRoute(request);
      telemetry.finishRequest(span, {
        method: request.method,
        route,
        statusCode,
        durationSeconds: durationMs / 1000,
      });
      const level = statusCode >= 500 ? 'error' : QUIET_PATHS.has(path) ? 'debug' : 'info';
      logger[level](
        {
          requestId,
          req: { method: request.method, path },
          res: { statusCode },
          route,
          durationMs: Math.round(durationMs * 100) / 100,
          aborted: !response.writableFinished,
        },
        'request completed',
      );
    });
    next();
  };
}
