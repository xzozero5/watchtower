import { describe, expect, it } from 'vitest';

import { DomainError } from './errors.js';
import {
  requireAiAction,
  requireCustomerSend,
  type CustomerSendRequest,
  type PolicyGate,
} from './policy.js';

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
        return Promise.resolve({ allowed: true, reason: 'test_allow' });
      },
      checkAiAction: () => Promise.resolve({ allowed: true, reason: 'test_allow' }),
    };
    await expect(requireCustomerSend({ policyGate: gate }, request)).resolves.toBeUndefined();
    expect(seen).toEqual([request]);
  });

  it('refuses with the gate reason when the gate says no', async () => {
    const gate: PolicyGate = {
      check: () => Promise.resolve({ allowed: false, reason: 'autonomy_stage_below_3' }),
      checkAiAction: () => Promise.resolve({ allowed: false, reason: 'kill_switch_on' }),
    };
    await expect(requireCustomerSend({ policyGate: gate }, request)).rejects.toMatchObject({
      code: 'policy_denied',
      details: { reason: 'autonomy_stage_below_3' },
    });
  });

  it('does not turn a gate that fails into permission', async () => {
    const gate: PolicyGate = {
      check: () => Promise.reject(new Error('gate unavailable')),
      checkAiAction: () => Promise.reject(new Error('gate unavailable')),
    };
    await expect(requireCustomerSend({ policyGate: gate }, request)).rejects.toThrow(
      'gate unavailable',
    );
  });
});

describe('requireAiAction', () => {
  const action = {
    ticketId: null,
    intentId: null,
    actor: { type: 'ai', id: null },
    action: 'classify',
  } as const;

  it('fails closed when no gate is configured', async () => {
    await expect(requireAiAction({}, action)).rejects.toMatchObject({
      code: 'policy_denied',
      details: { reason: 'no_policy_gate' },
    });
  });

  it('passes the request context to the gate and obeys its answer', async () => {
    const seen: unknown[] = [];
    const gate = (allowed: boolean): PolicyGate => ({
      check: () => Promise.resolve({ allowed: true, reason: 'x' }),
      checkAiAction: (asked) => {
        seen.push(asked.auditMeta);
        return Promise.resolve(
          allowed ? { allowed, reason: 'ok' } : { allowed, reason: 'kill_switch_on' },
        );
      },
    });
    const auditMeta = { ip: '203.0.113.1', requestId: 'r-1' };
    await expect(
      requireAiAction({ policyGate: gate(true), auditMeta }, action),
    ).resolves.toBeUndefined();
    await expect(
      requireAiAction({ policyGate: gate(false), auditMeta }, action),
    ).rejects.toMatchObject({
      details: { reason: 'kill_switch_on' },
    });
    expect(seen).toEqual([auditMeta, auditMeta]);
  });
});
