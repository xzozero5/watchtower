import { DomainError } from '@watchtower/domain';
import { describe, expect, it } from 'vitest';

import { ExternalRecipientsError, PolicyDeniedError, toHttpError } from './domain-errors.js';

describe('toHttpError', () => {
  it('answers external recipients with 409 and the domains to confirm in the body', () => {
    const error = toHttpError(
      new DomainError('external_recipients', 'Confirm the recipients', {
        domains: ['stranger.test', 'vendor.test'],
      }),
    );
    expect(error).toBeInstanceOf(ExternalRecipientsError);
    const http = error as ExternalRecipientsError;
    expect(http.getStatus()).toBe(409);
    expect(http.getResponse()).toMatchObject({
      statusCode: 409,
      code: 'external_recipients',
      domains: ['stranger.test', 'vendor.test'],
    });
  });

  it('answers policy_denied with 403, code forbidden and the reason code (B-011)', () => {
    const error = toHttpError(
      new DomainError('policy_denied', 'This intent cannot be promoted now', {
        reason: 'report_not_green',
      }),
    );
    expect(error).toBeInstanceOf(PolicyDeniedError);
    expect((error as PolicyDeniedError).getResponse()).toEqual({
      statusCode: 403,
      error: 'Forbidden',
      code: 'forbidden',
      message: 'This intent cannot be promoted now',
      reason: 'report_not_green',
    });
  });

  it('sends no reason that is not a plain code, or none at all', () => {
    for (const details of [{ reason: 'select * from secret where x = 1' }, { reason: 5 }, {}]) {
      const body = (
        toHttpError(new DomainError('policy_denied', 'No', details)) as {
          getResponse: () => Record<string, unknown>;
        }
      ).getResponse();
      expect(body).not.toHaveProperty('reason');
      expect(body.code).toBe('forbidden');
    }
  });

  it('keeps the other mappings and passes unknown errors through', () => {
    expect(
      (toHttpError(new DomainError('not_found', 'x')) as { getStatus: () => number }).getStatus(),
    ).toBe(404);
    const other = new Error('boom');
    expect(toHttpError(other)).toBe(other);
  });
});
