import { describe, expect, it } from 'vitest';

import type { PolicyGate } from '../policy.js';
import { evaluateBudget, type AiCaps, type BudgetMonitor } from './budget.js';
import { createAiGuard, IN_FLIGHT_TOKEN_RESERVE } from './guard.js';

// T-114a C-6: calls in flight count against the daily cap, so concurrent calls cannot all pass a
// nearly full budget.

const caps: AiCaps = { dailyCostUsd: 100, dailyTokens: 10_000, alertPercent: 80 };
const gate = { checkAiAction: () => Promise.resolve({ allowed: true }) } as unknown as PolicyGate;
const budget = (tokens: number): BudgetMonitor => ({
  check: () => Promise.resolve(evaluateBudget(caps, { costUsd: 0, tokens })),
});
const db = { select: () => ({ from: () => ({ where: () => ({ limit: () => [] }) }) }) } as never;
const request = { agent: 'classifier', ticketId: null, action: 'x', reserve: true } as const;

describe('createAiGuard in-flight reservation', () => {
  it('refuses a call that would pass only because others are still running', async () => {
    // 1_900 tokens left under the cap: one reserved call (4_000) already does not fit.
    const guard = createAiGuard({ policyGate: gate, db, budget: budget(8_100), caps });
    expect(await guard.check(request)).toMatchObject({ allowed: false, reason: 'budget_stop' });
  });

  it('counts calls in flight and frees them on release', async () => {
    const room = 2 * IN_FLIGHT_TOKEN_RESERVE;
    const guard = createAiGuard({
      policyGate: gate,
      db,
      budget: budget(caps.dailyTokens - room - 1),
      caps,
    });
    const first = await guard.check(request);
    const second = await guard.check(request);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    // Two are running; a third would take the usage past the cap.
    expect(await guard.check(request)).toMatchObject({ allowed: false, reason: 'budget_stop' });
    if (first.allowed) first.release?.();
    if (first.allowed) first.release?.(); // a second release changes nothing
    const again = await guard.check(request);
    expect(again.allowed).toBe(true);
  });

  it('does not reserve for an early check', async () => {
    const guard = createAiGuard({ policyGate: gate, db, budget: budget(9_999), caps });
    const early = await guard.check({ ...request, reserve: false });
    expect(early).toEqual({ allowed: true });
  });
});
