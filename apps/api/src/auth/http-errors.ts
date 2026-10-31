import { HttpException, HttpStatus } from '@nestjs/common';
import type { AuthErrorCode } from '@watchtower/shared';

const REASONS: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
};

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

export const invalidTransition = (message: string): ApiHttpError =>
  new ApiHttpError(HttpStatus.CONFLICT, 'invalid_transition', message);

export const mergeNotAllowed = (message: string): ApiHttpError =>
  new ApiHttpError(HttpStatus.CONFLICT, 'merge_not_allowed', message);

export const ticketNotOpen = (message: string): ApiHttpError =>
  new ApiHttpError(HttpStatus.CONFLICT, 'ticket_not_open', message);

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
