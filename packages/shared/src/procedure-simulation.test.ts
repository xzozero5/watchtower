import { describe, expect, it } from 'vitest';

import {
  PROCEDURE_SIMULATION,
  judgeSimulation,
  procedureSimulateJobSchema,
  procedureSimulationMetricsSchema,
  simulationStages,
} from './procedure-simulation.js';

const metrics = {
  mode: 'instance' as const,
  caseCount: 10,
  failedCases: 0,
  seededCases: 0,
  candidate: { editDistance: 30, uncitedClaims: 2, drafted: 10, violations: 0, disclosureLeaks: 0 },
  baseline: { editDistance: 30, uncitedClaims: 2, drafted: 10 },
  baselineVersionId: null,
  deadSteps: [] as string[],
  toolCalls: 20,
  cases: [],
};

describe('judgeSimulation', () => {
  it('passes at the limit of the edit distance and fails one point over', () => {
    const limit = PROCEDURE_SIMULATION.maxEditDistanceWorsePoints;
    const at = { ...metrics, candidate: { ...metrics.candidate, editDistance: 30 + limit } };
    expect(judgeSimulation(at)).toEqual([]);
    const over = { ...metrics, candidate: { ...metrics.candidate, editDistance: 30 + limit + 1 } };
    expect(judgeSimulation(over)).toEqual(['edit_distance_worse']);
  });

  it('allows as many uncited claims as the version live now and not one more', () => {
    expect(judgeSimulation(metrics)).toEqual([]);
    expect(
      judgeSimulation({ ...metrics, candidate: { ...metrics.candidate, uncitedClaims: 3 } }),
    ).toEqual(['more_uncited']);
  });

  it('fails on a violation, a leak, a dead step, too many failed cases and no cases', () => {
    expect(
      judgeSimulation({
        ...metrics,
        failedCases: 2,
        deadSteps: ['logs'],
        candidate: { ...metrics.candidate, violations: 1, disclosureLeaks: 1 },
      }),
    ).toEqual(['policy_violation', 'disclosure_leak', 'step_never_worked', 'too_many_failed']);
    expect(judgeSimulation({ ...metrics, caseCount: 0 })).toEqual(['no_cases']);
  });

  it('judges only the numbers when there is no baseline', () => {
    expect(judgeSimulation({ ...metrics, baseline: null })).toEqual([]);
  });
});

describe('simulation schemas', () => {
  it('keeps ticket text out of the stored metrics: only ids and numbers fit', () => {
    const parsed = procedureSimulationMetricsSchema.parse({ ...metrics, failReasons: [] });
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'baseline',
        'baselineVersionId',
        'candidate',
        'caseCount',
        'cases',
        'deadSteps',
        'failReasons',
        'failedCases',
        'mode',
        'seededCases',
        'toolCalls',
      ].sort(),
    );
    expect(
      procedureSimulationMetricsSchema.safeParse({ ...metrics, failReasons: ['made_up'] }).success,
    ).toBe(false);
  });

  it('the job carries ids only', () => {
    const ids = {
      versionId: '33333333-3333-4333-8333-333333333333',
      requestedBy: '44444444-4444-4444-8444-444444444444',
    };
    expect(procedureSimulateJobSchema.parse({ ...ids, ticket: 'ignored' })).toEqual(ids);
    expect(
      procedureSimulateJobSchema.safeParse({ versionId: 'x', requestedBy: ids.requestedBy })
        .success,
    ).toBe(false);
  });
});

describe('simulationStages (T-306a C-7)', () => {
  const steps = (...list: { id: string; stages?: number[] }[]) =>
    ({
      schemaVersion: 1,
      autosend: 'never',
      steps: list.map((item) => ({
        kind: 'reply_guideline',
        id: item.id,
        text: 'Be brief.',
        ...(item.stages === undefined ? {} : { stages: item.stages }),
      })),
    }) as Parameters<typeof simulationStages>[0];

  it('runs once when the steps are the same at stage 2 and 3', () => {
    expect(simulationStages(steps({ id: 'a' }, { id: 'b', stages: [2, 3] }), 2)).toEqual([2]);
    expect(simulationStages(steps(), 2)).toEqual([2]);
  });

  it('adds stage 3 when a step applies only there (it was never simulated before)', () => {
    expect(simulationStages(steps({ id: 'a' }, { id: 'only3', stages: [3] }), 2)).toEqual([2, 3]);
  });

  it('adds stage 3 when a step applies at 2 and not at 3', () => {
    expect(simulationStages(steps({ id: 'only2', stages: [2] }), 2)).toEqual([2, 3]);
  });

  it('starts from the stage of the intent and adds the stages of 2 and 3 that differ from it', () => {
    expect(simulationStages(steps({ id: 'a', stages: [2, 3] }), 1)).toEqual([1, 2, 3]);
    expect(simulationStages(steps({ id: 'a', stages: [2] }), 3)).toEqual([3, 2]);
  });
});
