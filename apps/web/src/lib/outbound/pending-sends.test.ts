import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeScheduledReply, makeTicket } from '@/test/fixtures';

import {
  addPendingSend,
  isDraftPending,
  pendingSendOf,
  removePendingSend,
  resetPendingSends,
} from './pending-sends';

const ticket = makeTicket(1);

beforeEach(() => {
  vi.useFakeTimers();
  resetPendingSends();
});
afterEach(() => {
  resetPendingSends();
  vi.useRealTimers();
});

describe('pendingSendOf', () => {
  it('remembers a delivery the server still holds', () => {
    const message = makeScheduledReply(1, ticket, 5000);
    const send = pendingSendOf(message, ticket.key, 'draft-x');
    expect(send).toMatchObject({
      deliveryId: message.delivery?.id,
      ticketKey: ticket.key,
      aiDraftId: 'draft-x',
    });
    expect(send?.sendAt).toBeGreaterThan(Date.now());
  });

  it('remembers nothing for a reply that is sent at once (portal) or can no longer be cancelled', () => {
    expect(pendingSendOf({ delivery: null }, ticket.key)).toBeNull();
    expect(pendingSendOf({}, ticket.key)).toBeNull();
    const held = makeScheduledReply(1, ticket);
    if (!held.delivery) throw new Error('fixture has a delivery');
    expect(
      pendingSendOf({ delivery: { ...held.delivery, cancellable: false } }, ticket.key),
    ).toBeNull();
    expect(pendingSendOf({ delivery: { ...held.delivery, state: 'sent' } }, ticket.key)).toBeNull();
  });

  it('remembers nothing when the window has already passed', () => {
    const message = makeScheduledReply(1, ticket, -1000);
    expect(pendingSendOf(message, ticket.key)).toBeNull();
  });
});

describe('the store', () => {
  it('forgets a send when its window ends: undo would be too late', () => {
    const send = pendingSendOf(makeScheduledReply(1, ticket, 5000), ticket.key, 'd1');
    if (!send) throw new Error('expected a pending send');
    addPendingSend(send);
    expect(isDraftPending('d1')).toBe(true);
    vi.advanceTimersByTime(4900);
    expect(isDraftPending('d1')).toBe(true);
    vi.advanceTimersByTime(200);
    expect(isDraftPending('d1')).toBe(false);
  });

  it('removes a send that was undone', () => {
    const send = pendingSendOf(makeScheduledReply(1, ticket, 5000), ticket.key, 'd1');
    if (!send) throw new Error('expected a pending send');
    addPendingSend(send);
    removePendingSend(send.deliveryId);
    expect(isDraftPending('d1')).toBe(false);
  });
});
