import { HttpException, HttpStatus } from '@nestjs/common';
import { isDomainError, type DomainErrorCode } from '@watchtower/domain';

import {
  badRequest,
  conflict,
  channelNoOutbound,
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
  channel_no_outbound: channelNoOutbound,
  bad_request: badRequest,
  policy_denied: forbidden,
  forbidden,
  // Built with its domains in `toHttpError`; this entry is only the fallback without them.
  external_recipients: conflict,
};

/** 409 `external_recipients`: the body also carries the `domains` the person has to confirm (T-171 C-2). */
export class ExternalRecipientsError extends HttpException {
  readonly code = 'external_recipients';

  constructor(
    message: string,
    readonly domains: readonly string[],
  ) {
    super(
      {
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: 'external_recipients',
        message,
        domains,
      },
      HttpStatus.CONFLICT,
    );
  }
}

/** A reason code is a short snake_case word: anything else (free text, an internal) is never sent to a client. */
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * 403 `forbidden` for a `policy_denied` refusal. The body also carries `reason`, the machine-readable code the
 * domain gave (`report_not_green`, `confirm_key_mismatch`, ...), so a client can say why (B-011).
 */
export class PolicyDeniedError extends HttpException {
  readonly code = 'forbidden';

  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(
      { statusCode: HttpStatus.FORBIDDEN, error: 'Forbidden', code: 'forbidden', message, reason },
      HttpStatus.FORBIDDEN,
    );
  }
}

/** A `DomainError` becomes its HTTP error; anything else passes through untouched. */
export function toHttpError(error: unknown): unknown {
  if (!isDomainError(error)) return error;
  if (error.code === 'external_recipients') {
    const domains = error.details?.domains;
    return new ExternalRecipientsError(
      error.message,
      Array.isArray(domains) ? (domains as string[]) : [],
    );
  }
  if (error.code === 'policy_denied') {
    const reason = error.details?.reason;
    if (typeof reason === 'string' && REASON_CODE.test(reason)) {
      return new PolicyDeniedError(error.message, reason);
    }
  }
  return HTTP_ERRORS[error.code](error.message);
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
