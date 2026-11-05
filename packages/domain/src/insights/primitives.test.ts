import { INSIGHT_MASKED_REF_KINDS, insightFactSchema, type InsightFact } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { deltaFact, driverFacts, finishFacts } from './facts.js';
import {
  bucketCount,
  bucketPercent,
  delta,
  dropMaskedRefs,
  factsFingerprint,
  isDriverGroupBy,
  isMaterialCountChange,
  share,
  topDrivers,
  type DriverGroupBy,
} from './primitives.js';

const metricFact = (id: string, value: number): InsightFact => ({
  id,
  kind: 'metric',
  value,
  display: { th: id, en: id },
});

describe('delta', () => {
  it('rounds the change against the 7-day baseline to a whole percent', () => {
    expect(delta(118, 100)).toEqual({ current: 118, baseline: 100, percent: 18, direction: 'up' });
    expect(delta(80, 100).percent).toBe(-20);
    expect(delta(80, 100).direction).toBe('down');
  });

  it('reads a change under 5 percent as flat', () => {
    expect(delta(103, 100).direction).toBe('flat');
    expect(delta(97, 100).direction).toBe('flat');
    expect(delta(105, 100).direction).toBe('up');
  });

  it('has no percent when the baseline is zero (never an infinite percentage)', () => {
    expect(delta(4, 0)).toEqual({ current: 4, baseline: 0, percent: null, direction: 'up' });
    expect(delta(0, 0).direction).toBe('flat');
  });

  it('refuses a negative baseline or a number that is not finite', () => {
    expect(() => delta(1, -1)).toThrow(RangeError);
    expect(() => delta(Number.NaN, 1)).toThrow(RangeError);
  });

  it('makes no delta fact when there is nothing to compare', () => {
    expect(deltaFact('d', { th: 'x', en: 'x' }, delta(4, 0))).toEqual([]);
    const [fact] = deltaFact('d', { th: 'ticket', en: 'tickets' }, delta(118, 100));
    expect(fact?.value).toBe(18);
    expect(fact?.display.en).toBe('tickets is up 18% on the 7-day average');
    expect(insightFactSchema.safeParse(fact).success).toBe(true);
  });
});

describe('share', () => {
  it('is the whole percent of the part in the whole, capped at 100', () => {
    expect(share(1, 3)).toBe(33);
    expect(share(2, 3)).toBe(67);
    expect(share(5, 5)).toBe(100);
    expect(share(0, 7)).toBe(0);
  });

  it('is null when there is no whole', () => {
    expect(share(0, 0)).toBeNull();
  });

  it('refuses negative numbers', () => {
    expect(() => share(-1, 3)).toThrow(RangeError);
  });
});

describe('topDrivers (C-14)', () => {
  const candidates = [
    { id: 'c', name: 'Charlie', count: 2 },
    { id: 'a', name: 'Alpha', count: 5 },
    { id: 'b', name: 'Bravo', count: 5 },
    { id: 'd', name: 'Delta', count: 1 },
    { id: 'z', name: 'Zero', count: 0 },
  ];

  it('returns at most three, biggest first, ties by id, and leaves out zero', () => {
    const drivers = topDrivers('intent', candidates, 10);
    expect(drivers.map((driver) => driver.id)).toEqual(['a', 'b', 'c']);
    expect(drivers[0]).toMatchObject({ groupBy: 'intent', sharePercent: 38 });
  });

  it('honours a smaller n and treats n below zero as none', () => {
    expect(topDrivers('queue', candidates, 1).map((driver) => driver.id)).toEqual(['a']);
    expect(topDrivers('queue', candidates, -2)).toEqual([]);
  });

  it('only groups by an entity a staff member keeps in a catalog', () => {
    for (const groupBy of ['intent', 'service', 'queue', 'org'] as const) {
      expect(isDriverGroupBy(groupBy)).toBe(true);
      expect(() => topDrivers(groupBy, candidates)).not.toThrow();
    }
    // Values that arrive from a webhook or a customer are not a grouping key, even if a caller forces the type.
    for (const forbidden of ['title', 'subject', 'channel', 'source', 'sender', 'tag', '']) {
      expect(isDriverGroupBy(forbidden)).toBe(false);
      expect(() => topDrivers(forbidden as DriverGroupBy, candidates)).toThrow(RangeError);
    }
  });

  it('turns drivers into facts that carry the catalog ref and pass the contract', () => {
    const facts = driverFacts(
      'intent_driver',
      { th: 'intent', en: 'intent' },
      topDrivers('intent', candidates),
    );
    expect(facts.map((fact) => fact.id)).toEqual([
      'intent_driver_1',
      'intent_driver_2',
      'intent_driver_3',
    ]);
    expect(facts[0]?.ref).toEqual({ kind: 'intent', id: 'a' });
    for (const fact of facts) expect(insightFactSchema.safeParse(fact).success).toBe(true);
  });
});

describe('materiality', () => {
  it('a count is material only when it moves by 10 percent AND by 3 units', () => {
    expect(isMaterialCountChange(100, 109)).toBe(false); // 9 units but 9 percent
    expect(isMaterialCountChange(100, 110)).toBe(true);
    expect(isMaterialCountChange(10, 12)).toBe(false); // 20 percent but 2 units
    expect(isMaterialCountChange(10, 13)).toBe(true);
    expect(isMaterialCountChange(0, 2)).toBe(false);
    expect(isMaterialCountChange(0, 3)).toBe(true);
  });

  it('buckets a small count in steps of 3 and a large one in steps of about 10 percent', () => {
    expect(bucketCount(0)).toBe(0);
    expect(bucketCount(2)).toBe(0);
    expect(bucketCount(3)).toBe(3);
    expect(bucketCount(7)).toBe(6);
    expect(bucketCount(29)).toBe(27);
    expect(bucketCount(100)).toBe(bucketCount(104));
    expect(bucketCount(100)).not.toBe(bucketCount(111));
    expect(bucketCount(-7)).toBe(-6);
  });

  it('buckets a percentage in steps of 5 points', () => {
    expect(bucketPercent(12)).toBe(10);
    expect(bucketPercent(13)).toBe(15);
    expect(bucketPercent(0)).toBe(0);
    expect(bucketPercent(-18)).toBe(-20);
  });
});

describe('factsFingerprint', () => {
  const base: InsightFact[] = [
    metricFact('open', 100),
    metricFact('trouble_pct', 21),
    { id: 'sla_state', kind: 'state', value: 'ok', display: { th: 's', en: 's' } },
  ];

  it('does not change for a wobble inside a bucket', () => {
    const wobble = [metricFact('open', 104), metricFact('trouble_pct', 22), base[2] as InsightFact];
    expect(factsFingerprint(wobble)).toBe(factsFingerprint(base));
  });

  it('changes when a count, a percentage step or a state moves', () => {
    const moved = factsFingerprint([metricFact('open', 111), base[1] as InsightFact, base[2] as InsightFact]);
    const step = factsFingerprint([base[0] as InsightFact, metricFact('trouble_pct', 30), base[2] as InsightFact]);
    const worse = factsFingerprint([
      base[0] as InsightFact,
      base[1] as InsightFact,
      { id: 'sla_state', kind: 'state', value: 'breached', display: { th: 's', en: 's' } },
    ]);
    expect(new Set([factsFingerprint(base), moved, step, worse]).size).toBe(4);
  });

  it('does not depend on the order of the facts or on the display text', () => {
    const shuffled = [base[2] as InsightFact, base[0] as InsightFact, base[1] as InsightFact].map(
      (fact) => ({ ...fact, display: { th: 'อื่น', en: 'other' } }),
    );
    expect(factsFingerprint(shuffled)).toBe(factsFingerprint(base));
  });

  it('treats the top drivers as a set: a change of rank inside it is not news, a different entity is', () => {
    const driver = (id: string, entity: string, count: number): InsightFact => ({
      id,
      kind: 'driver',
      value: count,
      display: { th: id, en: id },
      ref: { kind: 'intent', id: entity },
    });
    const one = [driver('intent_driver_1', 'a', 9), driver('intent_driver_2', 'b', 4)];
    const swapped = [driver('intent_driver_1', 'b', 9), driver('intent_driver_2', 'a', 4)];
    const other = [driver('intent_driver_1', 'a', 9), driver('intent_driver_2', 'c', 4)];
    expect(factsFingerprint(swapped)).toBe(factsFingerprint(one));
    expect(factsFingerprint(other)).not.toBe(factsFingerprint(one));
  });
});

describe('view and contract', () => {
  it('drops a fact that names a customer from a masked view', () => {
    const facts: InsightFact[] = [
      metricFact('open', 3),
      { ...metricFact('org_x', 1), ref: { kind: 'org', id: 'o1' } },
      { ...metricFact('contact_x', 1), ref: { kind: 'contact', id: 'c1' } },
      { ...metricFact('person_a_held', 1), ref: { kind: 'user', id: 'u1' } },
    ];
    expect(dropMaskedRefs(facts, INSIGHT_MASKED_REF_KINDS).map((fact) => fact.id)).toEqual([
      'open',
      'person_a_held',
    ]);
    expect(finishFacts(facts, new Date('2026-11-05T00:00:00Z'), 'masked').facts).toHaveLength(2);
    expect(finishFacts(facts, new Date('2026-11-05T00:00:00Z'), 'full').facts).toHaveLength(4);
  });

  it('refuses a duplicate fact id and a fact outside the allow-list shape', () => {
    expect(() => finishFacts([metricFact('a', 1), metricFact('a', 2)], new Date())).toThrow(
      /duplicate/,
    );
    expect(() =>
      finishFacts([{ ...metricFact('Bad Id', 1) }], new Date()),
    ).toThrow();
  });
});
