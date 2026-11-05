import { describe, expect, it } from 'vitest';

import type { PolicyGate } from '../policy.js';
import { evaluateBudget, type AiCaps, type BudgetMonitor } from './budget.js';
import { createAiGuard, IN_FLIGHT_TOKEN_RESERVE } from './guard.js';

// T-114a C-6: calls in flight count against the daily cap, so concurrent calls cannot all pass a
// nearly full budget.

const caps: AiCaps = { dailyCostUsd: 100, dailyTokens: 10_000, dailyEmbeddingTokens: 5_000_000, alertPercent: 80 };
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

// T-435 C-1: an embedding call is judged by the embedding cap only; its tokens never stop the LLM.
describe('createAiGuard embedding cap', () => {
  const embedRequest = { agent: 'embedder', ticketId: null, action: 'kb_index' } as const;
  // `readEmbeddingTokens` awaits `select().from().where()`.
  const usedDb = (tokens: number) =>
    ({
      select: () => ({
        from: () => ({ where: () => Promise.resolve([{ tokens: String(tokens) }]) }),
      }),
    }) as never;
  const embCaps: AiCaps = { ...caps, dailyEmbeddingTokens: 1_000 };

  it('allows an embedding call below its own cap even when the LLM budget is at its stop', async () => {
    const guard = createAiGuard({
      policyGate: gate,
      db: usedDb(999),
      budget: budget(caps.dailyTokens),
      caps: embCaps,
    });
    expect(await guard.check(embedRequest)).toEqual({ allowed: true });
  });

  it('stops an embedding call at the embedding cap, with budget_stop', async () => {
    const guard = createAiGuard({
      policyGate: gate,
      db: usedDb(1_000),
      budget: budget(0),
      caps: embCaps,
    });
    expect(await guard.check(embedRequest)).toMatchObject({
      allowed: false,
      reason: 'budget_stop',
    });
  });

  it('does not let a spent embedding cap stop an LLM call', async () => {
    const guard = createAiGuard({
      policyGate: gate,
      db: usedDb(9_999_999),
      budget: budget(0),
      caps: embCaps,
    });
    expect(await guard.check({ ...request, reserve: false })).toEqual({ allowed: true });
  });

  it('still honours the kill switch for an embedding call', async () => {
    const off = {
      checkAiAction: () => Promise.resolve({ allowed: false, reason: 'kill_switch_on' }),
    } as unknown as PolicyGate;
    const guard = createAiGuard({
      policyGate: off,
      db: usedDb(0),
      budget: budget(0),
      caps: embCaps,
    });
    expect(await guard.check(embedRequest)).toMatchObject({
      allowed: false,
      reason: 'kill_switch_on',
    });
  });
});
