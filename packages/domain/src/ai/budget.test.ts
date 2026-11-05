import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AI_BUDGET_ALERT_PERCENT,
  DEFAULT_AI_DAILY_COST_CAP_USD,
  DEFAULT_AI_DAILY_TOKEN_CAP,
  DEFAULT_EMBEDDING_DAILY_TOKEN_CAP,
  evaluateBudget,
  resolveAiCaps,
  utcDayStart,
} from './budget.js';

const caps = {
  dailyCostUsd: 10,
  dailyTokens: 1000,
  dailyEmbeddingTokens: 5_000_000,
  alertPercent: 80,
};

describe('evaluateBudget', () => {
  it('stops a provider that costs nothing (claude-cli priced 0) on tokens, with AI_DAILY_TOKEN_CAP empty (T-155a)', () => {
    // Empty variables arrive as undefined, so the default token cap of config/budgets.yaml applies.
    const defaults = resolveAiCaps({});
    expect(defaults.dailyTokens).toBe(500_000);
    expect(evaluateBudget(defaults, { costUsd: 0, tokens: 499_999 }).level).toBe('alert');
    expect(evaluateBudget(defaults, { costUsd: 0, tokens: 500_000 })).toMatchObject({
      level: 'stop',
      findings: [{ dimension: 'tokens', level: 'stop' }],
    });
  });

  it('is ok below the alert level', () => {
    expect(evaluateBudget(caps, { costUsd: 7.99, tokens: 799 })).toMatchObject({
      level: 'ok',
      findings: [],
    });
  });

  it('alerts from the alert percentage of either cap', () => {
    expect(evaluateBudget(caps, { costUsd: 8, tokens: 0 })).toMatchObject({
      level: 'alert',
      findings: [{ dimension: 'cost', level: 'alert', spent: 8, cap: 10 }],
    });
    expect(evaluateBudget(caps, { costUsd: 0, tokens: 800 }).findings).toEqual([
      { dimension: 'tokens', level: 'alert', spent: 800, cap: 1000 },
    ]);
  });

  it('stops at the cap itself, and stop wins over alert', () => {
    expect(evaluateBudget(caps, { costUsd: 10, tokens: 0 }).level).toBe('stop');
    expect(evaluateBudget(caps, { costUsd: 9, tokens: 1000 })).toMatchObject({
      level: 'stop',
      findings: [
        { dimension: 'cost', level: 'alert' },
        { dimension: 'tokens', level: 'stop' },
      ],
    });
  });

  it('honours another alert percentage', () => {
    expect(evaluateBudget({ ...caps, alertPercent: 50 }, { costUsd: 5, tokens: 0 }).level).toBe(
      'alert',
    );
  });
});

describe('resolveAiCaps', () => {
  it('uses the defaults when the environment is silent, and an override otherwise', () => {
    expect(resolveAiCaps({})).toEqual({
      dailyCostUsd: DEFAULT_AI_DAILY_COST_CAP_USD,
      dailyTokens: DEFAULT_AI_DAILY_TOKEN_CAP,
      dailyEmbeddingTokens: DEFAULT_EMBEDDING_DAILY_TOKEN_CAP,
      alertPercent: DEFAULT_AI_BUDGET_ALERT_PERCENT,
    });
    expect(
      resolveAiCaps({
        AI_DAILY_COST_CAP_USD: 3,
        AI_DAILY_TOKEN_CAP: 99,
        AI_BUDGET_ALERT_PERCENT: 60,
      }),
    ).toEqual({
      dailyCostUsd: 3,
      dailyTokens: 99,
      dailyEmbeddingTokens: 5_000_000,
      alertPercent: 60,
    });
  });

  it('keeps the defaults in step with config/budgets.yaml (app_ai_daily)', () => {
    const file = readFileSync(
      fileURLToPath(new URL('../../../../config/budgets.yaml', import.meta.url)),
      'utf8',
    );
    const block = /^app_ai_daily:[^\n]*\n((?:[ \t]+[^\n]*\n)+)/m.exec(file)?.[1] ?? '';
    const read = (key: string): number => Number(new RegExp(`${key}:\\s*(\\d+)`).exec(block)?.[1]);
    expect(read('usd')).toBe(DEFAULT_AI_DAILY_COST_CAP_USD);
    expect(read('tokens')).toBe(DEFAULT_AI_DAILY_TOKEN_CAP);
    expect(read('embedding_tokens')).toBe(DEFAULT_EMBEDDING_DAILY_TOKEN_CAP);
    expect(read('alert_percent')).toBe(DEFAULT_AI_BUDGET_ALERT_PERCENT);
  });
});

describe('utcDayStart', () => {
  it('is midnight UTC of the same UTC day, whatever the clock offset', () => {
    expect(utcDayStart(new Date('2026-11-01T23:59:59Z')).toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
    expect(utcDayStart(new Date('2026-11-02T00:00:00Z')).toISOString()).toBe(
      '2026-11-02T00:00:00.000Z',
    );
  });
});
