import { describe, expect, it } from 'vitest';

import { makeMessage, makeTicket } from '@/test/fixtures';

import { awaitsFirstAnswer } from './waiting-on-customer';

const ticket = makeTicket(1);
const inbound = (n: number) => ({
  ...makeMessage(n, ticket, { direction: 'inbound' }),
  kind: 'message' as const,
});
const outbound = (n: number, extra: Parameters<typeof makeMessage>[2] = {}) => ({
  ...makeMessage(n, ticket, { direction: 'outbound', ...extra }),
  kind: 'message' as const,
});

describe('awaitsFirstAnswer', () => {
  it('is true when the customer wrote last and nobody answered', () => {
    expect(awaitsFirstAnswer([inbound(1)])).toBe(true);
    expect(awaitsFirstAnswer([inbound(1), outbound(2), inbound(3)])).toBe(true);
  });

  it('is false once a public reply follows the customer', () => {
    expect(awaitsFirstAnswer([inbound(1), outbound(2)])).toBe(false);
  });

  it('does not count an internal note, an undone reply or a failed one', () => {
    expect(awaitsFirstAnswer([inbound(1), outbound(2, { visibility: 'internal' })])).toBe(true);
    expect(awaitsFirstAnswer([inbound(1), outbound(2, { deliveryStatus: 'cancelled' })])).toBe(
      true,
    );
    expect(awaitsFirstAnswer([inbound(1), outbound(2, { deliveryStatus: 'failed' })])).toBe(true);
  });

  it('counts a reply held for the undo window', () => {
    expect(awaitsFirstAnswer([inbound(1), outbound(2, { deliveryStatus: 'scheduled' })])).toBe(
      false,
    );
  });

  it('is false when the customer never wrote', () => {
    expect(awaitsFirstAnswer([])).toBe(false);
    expect(awaitsFirstAnswer([outbound(1)])).toBe(false);
  });
});
