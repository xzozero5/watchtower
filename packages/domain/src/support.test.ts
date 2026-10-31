import { describe, expect, it } from 'vitest';

import { pickNextMember } from './assignment.js';
import { DomainError } from './errors.js';
import { TicketKeys } from './ticket-keys.js';
import { replyDeliveryStatus, ticketRefCondition } from './tickets/support.js';

describe('ticketRefCondition', () => {
  const keys = new TicketKeys('OPS');

  it('accepts a uuid or a key of this instance', () => {
    expect(() => ticketRefCondition('3f2b8c1e-9d4a-4e6b-8a1c-0d5e7f9a2b3c', keys)).not.toThrow();
    expect(() => ticketRefCondition('ops-1001', keys)).not.toThrow();
  });

  it('is "no such ticket" for anything else, including another prefix', () => {
    for (const ref of ['SUP-1001', 'nonsense', '', '1001']) {
      expect(() => ticketRefCondition(ref, keys), ref).toThrow(DomainError);
    }
    expect(() => ticketRefCondition('SUP-1001', keys)).toThrow('No such ticket');
  });
});

describe('replyDeliveryStatus', () => {
  it('delivers a staff reply on the portal at once and leaves other channels pending', () => {
    expect(replyDeliveryStatus('staff', 'portal')).toBe('delivered');
    expect(replyDeliveryStatus('staff', 'line')).toBe('pending');
    expect(replyDeliveryStatus('contact', 'portal')).toBe('not_applicable');
  });
});

describe('pickNextMember', () => {
  it('walks the members in id order and wraps', () => {
    expect(pickNextMember(['a', 'b', 'c'], null)).toBe('a');
    expect(pickNextMember(['a', 'b', 'c'], 'c')).toBe('a');
    expect(pickNextMember(['a', 'c'], 'b')).toBe('c');
    expect(pickNextMember([], null)).toBeNull();
  });
});
