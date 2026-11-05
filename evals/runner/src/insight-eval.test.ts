import { fileURLToPath } from 'node:url';

import { INSIGHT_ELEMENTS, NARRATED_INSIGHT_ELEMENTS } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import type { InsightCase } from './case.js';
import { checkInsight } from './checks.js';
import { runEval } from './eval.js';
import { loadCases } from './load.js';
import { createRig } from './rig.js';

// The owner approved the cases on 2026-11-05; they moved from proposals into the golden set (insight_narrator.json).
const GOLDEN = fileURLToPath(new URL('../../golden', import.meta.url));

const proposed = () =>
  loadCases([{ dir: GOLDEN, source: 'golden' }]).filter(
    (item) => item.case.agent === 'insight_narrator',
  );

describe('golden insight_narrator.json (T-417, ADR-029 section 9.8)', () => {
  it('has at least 3 cases for every element narrated in wave 9a, and a nothing-changed case', () => {
    const cases = proposed().map((item) => item.case as InsightCase);
    const wave9a = NARRATED_INSIGHT_ELEMENTS.filter((key) => INSIGHT_ELEMENTS[key].wave === '9a');
    expect(wave9a.length).toBeGreaterThanOrEqual(5);
    for (const key of wave9a) {
      const own = cases.filter((item) => item.input.elements.some((element) => element.key === key));
      expect(own.length, key).toBeGreaterThanOrEqual(3);
      expect(
        own.some((item) => item.expect.elements[key]?.maxClaims === 0),
        `${key}: nothing changed`,
      ).toBe(true);
    }
  });

  it('has the section 9.9 ranking-bait cases for every element that shows people', () => {
    const cases = proposed().map((item) => item.case as InsightCase);
    const people = (Object.keys(INSIGHT_ELEMENTS) as (keyof typeof INSIGHT_ELEMENTS)[]).filter(
      (key) =>
        INSIGHT_ELEMENTS[key].personRefs !== 'none' &&
        (INSIGHT_ELEMENTS[key].mode === 'N' || key === 'home.my_work') &&
        INSIGHT_ELEMENTS[key].aliasOf === undefined,
    );
    expect(people.sort()).toEqual(['dashboard.ops.team', 'home.my_work', 'shift.overview']);
    for (const key of people) {
      expect(
        cases.some(
          (item) =>
            item.input.elements.some((element) => element.key === key) &&
            item.expect.mustRejectFor?.includes('person_tone') === true,
        ),
        key,
      ).toBe(true);
    }
  });

  it('passes on the mock provider (plumbing and post-checks, not the quality of a real model)', async () => {
    const rig = createRig({ provider: 'mock', maxCalls: 100, env: {} });
    const cases = proposed();
    const results = await runEval({ cases, rig });
    expect(results).toHaveLength(cases.length);
    expect(results.filter((result) => !result.pass).map((result) => result.id)).toEqual([]);
    expect(results.every((result) => result.calls === 1)).toBe(true);
  });
});

describe('checkInsight reads the claims again', () => {
  const item = (): InsightCase =>
    (proposed().find((entry) => entry.case.id === 'ins-shift-one-person-neutral')
      ?.case as InsightCase);

  const outcome = (text: string, factIds: string[]) => ({
    status: 'ok' as const,
    accepted: { 'shift.overview': { en: [{ text, factIds, evidence: [] }] } },
    rejected: [],
    runId: null,
    mock: true,
    redaction: undefined as never,
  });

  it('flags an invented number, an uncited claim, a ranking and the wrong language', () => {
    const checks = checkInsight(outcome('[NAME_1] holds 99 tickets, the most.', []), item());
    const failed = checks.filter((check) => !check.pass).map((check) => check.name);
    expect(failed).toEqual(
      expect.arrayContaining([
        'hallucinated numbers = 0',
        'uncited claims = 0',
        'person tone = 0',
      ]),
    );
    const thai = checkInsight(outcome('[NAME_1] ถืออยู่ 9 รายการ', ['u1_open']), item());
    expect(thai.find((check) => check.name === 'language matches')?.pass).toBe(false);
  });

  it('passes a neutral, cited, correct claim', () => {
    const checks = checkInsight(outcome('[NAME_1] holds 9 tickets.', ['u1_open']), item());
    // (The Thai list is empty here on purpose: only the claim itself is under test.)
    expect(
      checks.filter((check) => !check.pass && !check.name.startsWith('shift.overview th')),
    ).toEqual([]);
  });
});
