/**
 * Why a domain operation refused. The api maps each code to the HTTP error it always sent (one
 * table, `apps/api/src/domain/domain-errors.ts`); the worker decides retryable or not.
 */
export const DOMAIN_ERROR_CODES = [
  'not_found',
  'conflict',
  'invalid_transition',
  'merge_not_allowed',
  'ticket_not_open',
  'bad_request',
  'policy_denied',
] as const;
export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: DomainErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

export const notFound = (message = 'Not found'): DomainError =>
  new DomainError('not_found', message);
export const conflict = (message: string): DomainError => new DomainError('conflict', message);
export const badRequest = (message: string): DomainError => new DomainError('bad_request', message);
export const invalidTransition = (message: string): DomainError =>
  new DomainError('invalid_transition', message);
export const mergeNotAllowed = (message: string): DomainError =>
  new DomainError('merge_not_allowed', message);
export const ticketNotOpen = (message: string): DomainError =>
  new DomainError('ticket_not_open', message);
