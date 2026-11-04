import { HttpException, HttpStatus } from '@nestjs/common';
import type { AuthErrorCode } from '@watchtower/shared';

const REASONS: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
  [HttpStatus.BAD_GATEWAY]: 'Bad Gateway',
  [HttpStatus.GATEWAY_TIMEOUT]: 'Gateway Timeout',
};

/** 503: the system an investigation tool reaches (logs, product data, repository) is not connected on this instance. */
export const toolNotConnected = (): ApiHttpError =>
  new ApiHttpError(
    HttpStatus.SERVICE_UNAVAILABLE,
    'tool_not_connected',
    'That system is not connected on this instance',
  );

/** 503: ad-hoc statements are off because the product database login can do more than a reader may (ADR-016). */
export const toolNotHardened = (): ApiHttpError =>
  new ApiHttpError(
    HttpStatus.SERVICE_UNAVAILABLE,
    'tool_not_connected',
    'Ad-hoc statements are off: the product database login is not hardened; saved templates still run',
  );

/** 503: ad-hoc data statements are off unless the deployment turned them on (T-207a C-1, ADR-016). */
export const adhocDataOff = (): ApiHttpError =>
  new ApiHttpError(
    HttpStatus.SERVICE_UNAVAILABLE,
    'tool_not_connected',
    'Ad-hoc data statements are off (PRODUCT_DB_ADHOC_ENABLED); saved templates still run',
  );

/** 502 or 504: the system answered badly or too slowly. Says nothing about the query or the system. */
export const toolFailed = (timeout: boolean): ApiHttpError =>
  new ApiHttpError(
    timeout ? HttpStatus.GATEWAY_TIMEOUT : HttpStatus.BAD_GATEWAY,
    'tool_failed',
    timeout ? 'The system took too long to answer' : 'The system could not answer',
  );

/** 503: a knowledge base search ran past its time limit and was stopped; a shorter query may work. */
export const kbSearchTimeout = (): ApiHttpError =>
  new ApiHttpError(
    HttpStatus.SERVICE_UNAVAILABLE,
    'kb_search_timeout',
    'The search took too long; try fewer or more specific words',
  );

/**
 * An error whose body is `{ statusCode, error, code, message }` (apiErrorSchema in
 * @watchtower/shared). `code` is stable and machine-readable; `message` is for humans and never
 * says more than the caller may learn (for example, not which half of a credential was wrong).
 */
export class ApiHttpError extends HttpException {
  readonly code: AuthErrorCode;

  constructor(status: number, code: AuthErrorCode, message: string) {
    super({ statusCode: status, error: REASONS[status] ?? 'Error', code, message }, status);
    this.code = code;
  }
}

export const unauthenticated = (message = 'Authentication is required'): ApiHttpError =>
  new ApiHttpError(HttpStatus.UNAUTHORIZED, 'unauthenticated', message);

export const forbidden = (message = 'You do not have permission to do this'): ApiHttpError =>
  new ApiHttpError(HttpStatus.FORBIDDEN, 'forbidden', message);

export const notFound = (message = 'Not found'): ApiHttpError =>
  new ApiHttpError(HttpStatus.NOT_FOUND, 'not_found', message);

export const conflict = (message: string): ApiHttpError =>
  new ApiHttpError(HttpStatus.CONFLICT, 'conflict', message);

/** 400 for a request that is well formed but refers to something that does not exist or is not allowed. */
export const badRequest = (message: string): ApiHttpError =>
  new ApiHttpError(HttpStatus.BAD_REQUEST, 'validation_failed', message);

/** 409 for saving a credential field that an environment variable sets (ADR-012). */
export const credentialEnvLocked = (message: string): ApiHttpError =>
  new ApiHttpError(HttpStatus.CONFLICT, 'credential_env_locked', message);

export const invalidTransition = (message: string): ApiHttpError =>
  new ApiHttpError(HttpStatus.CONFLICT, 'invalid_transition', message);

export const mergeNotAllowed = (message: string): ApiHttpError =>
  new ApiHttpError(HttpStatus.CONFLICT, 'merge_not_allowed', message);

export const ticketNotOpen = (message: string): ApiHttpError =>
  new ApiHttpError(HttpStatus.CONFLICT, 'ticket_not_open', message);

/** 409: a public reply on a phone, walk-in, chat, other or internal ticket; nothing could be delivered. */
export const channelNoOutbound = (message: string): ApiHttpError =>
  new ApiHttpError(HttpStatus.CONFLICT, 'channel_no_outbound', message);

export const invalidCredentials = (): ApiHttpError =>
  new ApiHttpError(HttpStatus.UNAUTHORIZED, 'invalid_credentials', 'Invalid email or password');

export const invalidLink = (): ApiHttpError =>
  new ApiHttpError(
    HttpStatus.UNAUTHORIZED,
    'invalid_or_expired_link',
    'This sign-in link is invalid, expired or already used',
  );

export const invalidRefreshToken = (): ApiHttpError =>
  new ApiHttpError(
    HttpStatus.UNAUTHORIZED,
    'invalid_refresh_token',
    'The session cannot be renewed; sign in again',
  );

/** 429 with Retry-After. The header is set by RateLimitFilter from `retryAfterSeconds`. */
export class RateLimitedError extends ApiHttpError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(HttpStatus.TOO_MANY_REQUESTS, 'rate_limited', 'Too many attempts; try again later');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The public portal could not tell that a person is behind the form (ADR-007): no, wrong, expired,
 * reused or too-quick proof, or a filled honeypot. The reason goes to the audit log, never to the
 * caller; they get a challenge to solve again.
 */
export const verificationFailed = (): ApiHttpError =>
  new ApiHttpError(
    HttpStatus.BAD_REQUEST,
    'verification_failed',
    'Human verification failed; request a new challenge and try again',
  );

/**
 * A portal tracking link that does not open a ticket. One answer for every reason (unknown ticket,
 * wrong token, expired, revoked, token of another ticket) so a caller cannot tell them apart.
 */
export const invalidTrackingLink = (): ApiHttpError =>
  new ApiHttpError(
    HttpStatus.UNAUTHORIZED,
    'invalid_or_expired_link',
    'This link is invalid or has expired',
  );
