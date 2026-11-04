import { describe, expect, it } from 'vitest';

import { ApiRequestError } from '@/lib/api/errors';

import { canMarkGolden, goldenErrorKey } from './golden';

describe('canMarkGolden', () => {
  const reply = {
    direction: 'outbound',
    visibility: 'public',
    deliveryStatus: 'delivered',
  } as const;
  it('accepts a delivered reply, and a reply on a channel with no delivery step', () => {
    expect(canMarkGolden(reply)).toBe(true);
    expect(canMarkGolden({ ...reply, deliveryStatus: 'not_applicable' })).toBe(true);
  });
  it('refuses anything the customer did not receive', () => {
    for (const deliveryStatus of ['pending', 'scheduled', 'cancelled', 'failed'] as const) {
      expect(canMarkGolden({ ...reply, deliveryStatus })).toBe(false);
    }
    expect(canMarkGolden({ ...reply, direction: 'inbound' })).toBe(false);
    expect(canMarkGolden({ ...reply, direction: 'internal', visibility: 'internal' })).toBe(false);
  });
});

describe('goldenErrorKey', () => {
  const error = (status: number, message: string) =>
    new ApiRequestError(status, 'unknown', message);
  it('maps the answers the api gives to one sentence each', () => {
    expect(goldenErrorKey(error(409, 'Set the intent of the ticket before marking'))).toBe(
      'noIntent',
    );
    expect(goldenErrorKey(error(409, 'This reply is already a golden answer'))).toBe('already');
    expect(goldenErrorKey(error(400, 'This reply cannot be redacted safely'))).toBe('redact');
    expect(goldenErrorKey(error(400, 'Only a reply that was sent'))).toBe('notSent');
    expect(goldenErrorKey(error(500, 'boom'))).toBe('generic');
    expect(goldenErrorKey(new Error('network'))).toBe('generic');
  });
});
