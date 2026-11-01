import { isDomainError, type DomainErrorCode } from '@watchtower/domain';

import {
  badRequest,
  conflict,
  forbidden,
  invalidTransition,
  mergeNotAllowed,
  notFound,
  ticketNotOpen,
  type ApiHttpError,
} from '../auth/http-errors.js';

/**
 * The one table that turns a `DomainError` into the HTTP error the api always answered with (ADR-009).
 * The status, `code` and message of each stay exactly as they were before the logic moved.
 */
const HTTP_ERRORS: Readonly<Record<DomainErrorCode, (message: string) => ApiHttpError>> = {
  not_found: notFound,
  conflict,
  invalid_transition: invalidTransition,
  merge_not_allowed: mergeNotAllowed,
  ticket_not_open: ticketNotOpen,
  bad_request: badRequest,
  policy_denied: forbidden,
  forbidden,
};

/** A `DomainError` becomes its HTTP error; anything else passes through untouched. */
export function toHttpError(error: unknown): unknown {
  return isDomainError(error) ? HTTP_ERRORS[error.code](error.message) : error;
}

/** Runs domain work and answers its refusals with the api's HTTP errors. */
export async function translating<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toHttpError(error);
  }
}

/** The synchronous form, for a domain function that does not touch the database. */
export function translatingSync<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw toHttpError(error);
  }
}
