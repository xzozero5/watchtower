import { describe, expect, it } from 'vitest';

import { DomainError } from './errors.js';
import { requireCustomerSend, type CustomerSendRequest, type PolicyGate } from './policy.js';

const request: CustomerSendRequest = {
  ticketId: 't-1',
  channel: 'line',
  intentId: null,
  actor: { type: 'ai', id: null },
};

describe('requireCustomerSend', () => {
  it('fails closed when no gate is configured', async () => {
    const error = await requireCustomerSend({}, request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code: 'policy_denied', details: { reason: 'no_policy_gate' } });
  });

  it('passes when the gate allows, and says what it was asked', async () => {
    const seen: CustomerSendRequest[] = [];
    const gate: PolicyGate = {
      check: (asked) => {
        seen.push(asked);
        return Promise.resolve({ allowed: true });
      },
    };
    await expect(requireCustomerSend({ policyGate: gate }, request)).resolves.toBeUndefined();
    expect(seen).toEqual([request]);
  });

  it('refuses with the gate reason when the gate says no', async () => {
    const gate: PolicyGate = {
      check: () => Promise.resolve({ allowed: false, reason: 'autonomy_stage_below_3' }),
    };
    await expect(requireCustomerSend({ policyGate: gate }, request)).rejects.toMatchObject({
      code: 'policy_denied',
      details: { reason: 'autonomy_stage_below_3' },
    });
  });

  it('does not turn a gate that fails into permission', async () => {
    const gate: PolicyGate = { check: () => Promise.reject(new Error('gate unavailable')) };
    await expect(requireCustomerSend({ policyGate: gate }, request)).rejects.toThrow(
      'gate unavailable',
    );
  });
});
