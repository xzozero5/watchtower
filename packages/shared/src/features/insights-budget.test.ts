import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { phase2EnvShape } from '../config.js';

const budgets = readFileSync(new URL('../../../../config/budgets.yaml', import.meta.url), 'utf8');

/** The `insights:` block of config/budgets.yaml as key -> number (the file is flat enough to read without a parser). */
function insightBudgets(): Record<string, number> {
  const start = budgets.indexOf('\ninsights:');
  expect(start).toBeGreaterThan(-1);
  const out: Record<string, number> = {};
  for (const line of budgets
    .slice(start + 1)
    .split('\n')
    .slice(1)) {
    const match = /^ {2}([a-z_]+): (\d+)/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) break;
    out[match[1]] = Number(match[2]);
  }
  return out;
}

describe('insights budget (ADR-029 9.4)', () => {
  const shape = phase2EnvShape as unknown as Record<
    string,
    { parse: (value: unknown) => unknown } | undefined
  >;

  it('has one INSIGHT_* variable per budgets.yaml key, and its default is the yaml value', () => {
    const yaml = insightBudgets();
    expect(Object.keys(yaml)).toHaveLength(14);
    for (const [key, value] of Object.entries(yaml)) {
      const name = `INSIGHT_${key.toUpperCase()}`;
      const field = shape[name];
      expect(field, `${name} is missing from the config schema`).toBeDefined();
      expect(field?.parse(undefined), name).toBe(value);
      expect(field?.parse(''), `${name} empty = default`).toBe(value);
    }
  });

  it('keeps the user-scoped calls inside the overall calls and the tokens under 30% of the daily cap', () => {
    const yaml = insightBudgets();
    expect(yaml.user_scoped_calls_per_day).toBeLessThanOrEqual(yaml.calls_per_day ?? 0);
    expect(yaml.daily_tokens).toBeLessThanOrEqual(500_000 * 0.3);
    expect(yaml.stop_at_daily_percent).toBe(60);
  });

  it('refuses a value out of range', () => {
    expect(() => shape.INSIGHT_MAX_BATCH_ELEMENTS?.parse('13')).toThrow();
    expect(() => shape.INSIGHT_CALLS_PER_HOUR?.parse('0')).toThrow();
  });
});
