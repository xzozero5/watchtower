import { describe, expect, it } from 'vitest';

import { replyDeliveryStatus } from './tickets.service.js';

describe('replyDeliveryStatus', () => {
  it('delivers a staff reply on the portal as soon as it is saved', () => {
    expect(replyDeliveryStatus('staff', 'portal')).toBe('delivered');
  });

  it('leaves a staff reply on any other channel pending for its adapter', () => {
    for (const channel of ['gmail', 'line', 'discord', 'webhook']) {
      expect(replyDeliveryStatus('staff', channel), channel).toBe('pending');
    }
  });

  it('has nothing to deliver for what a customer wrote', () => {
    for (const channel of ['portal', 'gmail', 'line']) {
      expect(replyDeliveryStatus('client', channel), channel).toBe('not_applicable');
    }
  });
});
