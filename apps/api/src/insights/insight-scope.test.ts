import { INSIGHT_ELEMENTS, insightsQuerySchema } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { daysOf, parseScopeKey, periodFor, scopeKeyFor } from './insight-scope.js';

const ID = '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11';
const NOW = new Date('2026-11-05T05:00:00Z');

describe('scope keys', () => {
  it('parses instance, user and row scopes, and nothing else', () => {
    expect(parseScopeKey('instance')).toEqual({ kind: 'instance' });
    expect(parseScopeKey('user')).toEqual({ kind: 'user' });
    expect(parseScopeKey(`org:${ID}`)).toEqual({ kind: 'org', id: ID });
    expect(parseScopeKey(`intent:${ID}`)).toEqual({ kind: 'intent', id: ID });
    for (const bad of ['', 'org', 'org:1', `org:${ID}:x`, `user:${ID}`, `team:${ID}`, 'Instance']) {
      expect(parseScopeKey(bad), bad).toBeNull();
    }
  });

  it('gives each element its own scope when none is named, and refuses a scope of another kind', () => {
    expect(scopeKeyFor(INSIGHT_ELEMENTS['alerts.noise'], undefined)).toBe('instance');
    expect(scopeKeyFor(INSIGHT_ELEMENTS['home.my_work'], undefined)).toBe('user');
    expect(scopeKeyFor(INSIGHT_ELEMENTS['org.health'], undefined)).toBeNull();
    expect(scopeKeyFor(INSIGHT_ELEMENTS['org.health'], `org:${ID}`)).toBe(`org:${ID}`);
    expect(scopeKeyFor(INSIGHT_ELEMENTS['org.health'], `intent:${ID}`)).toBeNull();
    expect(scopeKeyFor(INSIGHT_ELEMENTS['alerts.noise'], `org:${ID}`)).toBeNull();
    expect(scopeKeyFor(INSIGHT_ELEMENTS['home.my_work'], 'instance')).toBeNull();
  });
});

describe('period (C-11)', () => {
  it('defaults to the first period the element has', () => {
    expect(periodFor(INSIGHT_ELEMENTS['dashboard.ops.sla'], undefined, NOW)).toBe('d7');
    expect(periodFor(INSIGHT_ELEMENTS['incidents.open'], undefined, NOW)).toBe('now');
    expect(periodFor(INSIGHT_ELEMENTS['home.my_work'], undefined, NOW)).toBe('-');
  });

  it('accepts only what the PeriodSpec of the element allows', () => {
    const sla = INSIGHT_ELEMENTS['dashboard.ops.sla'];
    expect(periodFor(sla, 'd30', NOW)).toBe('d30');
    expect(periodFor(sla, 'd90', NOW)).toBe('d90');
    for (const bad of ['d0', 'd91', 'd999', 'now', '-', 'w2026-45', `shift:${ID}`, 'd7; DROP']) {
      expect(periodFor(sla, bad, NOW), bad).toBeNull();
    }
    expect(periodFor(INSIGHT_ELEMENTS['incidents.open'], 'd7', NOW)).toBeNull();
    expect(periodFor(INSIGHT_ELEMENTS['incidents.open'], 'now', NOW)).toBe('now');
  });

  it('reads the days of a period', () => {
    expect(daysOf('d14')).toBe(14);
  });
});

describe('the query', () => {
  it('takes at most 12 distinct elements', () => {
    const ok = insightsQuerySchema.safeParse({ elements: 'a.b, a.b ,c' });
    expect(ok.success && ok.data.elements).toEqual(['a.b', 'c']);
    const twelve = Array.from({ length: 12 }, (_, i) => `e${String(i)}`).join(',');
    expect(insightsQuerySchema.safeParse({ elements: twelve }).success).toBe(true);
    expect(insightsQuerySchema.safeParse({ elements: `${twelve},e12` }).success).toBe(false);
    expect(insightsQuerySchema.safeParse({ elements: '' }).success).toBe(false);
    expect(insightsQuerySchema.safeParse({ elements: 'UPPER' }).success).toBe(false);
  });

  it('refuses a scope or a period of the wrong shape', () => {
    expect(insightsQuerySchema.safeParse({ elements: 'a', scope: 'org:1' }).success).toBe(false);
    expect(insightsQuerySchema.safeParse({ elements: 'a', scope: `org:${ID}` }).success).toBe(true);
    expect(insightsQuerySchema.safeParse({ elements: 'a', period: 'last week' }).success).toBe(
      false,
    );
    expect(insightsQuerySchema.safeParse({ elements: 'a', period: 'd7' }).success).toBe(true);
    expect(insightsQuerySchema.safeParse({ elements: 'a', locale: 'fr' }).success).toBe(false);
  });
});
