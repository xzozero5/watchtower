import { DomainError } from '@watchtower/domain';
import { describe, expect, it } from 'vitest';

import { ExternalRecipientsError, toHttpError } from './domain-errors.js';

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

  it('keeps the other mappings and passes unknown errors through', () => {
    expect(
      (toHttpError(new DomainError('not_found', 'x')) as { getStatus: () => number }).getStatus(),
    ).toBe(404);
    const other = new Error('boom');
    expect(toHttpError(other)).toBe(other);
  });
});
