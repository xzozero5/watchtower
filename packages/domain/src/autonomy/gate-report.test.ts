import { describe, expect, it } from 'vitest';

import { buildReport, type GroupStats, type ReportInputs } from './gate-report.js';

const group = (over: Partial<GroupStats> = {}): GroupStats => ({
  graded: 40,
  verified: 30,
  reopened: 2,
  violations: 0,
  csatN: 30,
  csatAvg: 4.5,
  ...over,
});

const GOOD: ReportInputs = {
  stage: 2,
  daysAtStage: 40,
  ai: group({ verified: 34, reopened: 1 }),
  human: group(),
  shadowEvaluations: 80,
  shadowDecided: 60,
  shadowAccepted: 57,
};

const criterion = (report: ReturnType<typeof buildReport>, key: string) =>
  report.criteria.find((candidate) => candidate.key === key);

describe('the gate report (ADR-025 section 6)', () => {
  it('is green when every deciding criterion passes', () => {
    const report = buildReport(GOOD);
    expect(report.status).toBe('green');
    expect(report.criteria.filter((c) => c.pass === false)).toEqual([]);
    // The two checks that run outside the database are listed, never decide.
    expect(criterion(report, 'eval_replay_violations')).toMatchObject({
      pass: null,
      value: 'not_measured',
    });
    expect(criterion(report, 'redaction_eval')).toMatchObject({
      pass: null,
      value: 'not_measured',
    });
  });

  it('marks the PRD criteria as PRD and the rest as ASSUMED', () => {
    const report = buildReport(GOOD);
    expect(criterion(report, 'verified_resolution')?.basis).toBe('PRD');
    expect(criterion(report, 'reopen_rate')?.basis).toBe('PRD');
    expect(criterion(report, 'days_at_stage_2')?.basis).toBe('PRD');
    expect(criterion(report, 'csat_parity')?.basis).toBe('ASSUMED');
    expect(criterion(report, 'shadow_precision')?.basis).toBe('ASSUMED');
  });

  it('is insufficient_data, never green, with less than 28 days at the stage', () => {
    const report = buildReport({ ...GOOD, daysAtStage: 27.9 });
    expect(report.status).toBe('insufficient_data');
    expect(criterion(report, 'days_at_stage_2')?.pass).toBeNull();
  });

  it('is insufficient_data with a small sample in either group', () => {
    expect(
      buildReport({ ...GOOD, ai: group({ graded: 19, verified: 19, reopened: 0 }) }).status,
    ).toBe('insufficient_data');
    expect(
      buildReport({ ...GOOD, human: group({ graded: 0, verified: 0, reopened: 0 }) }).status,
    ).toBe('insufficient_data');
  });

  it('is red when the AI verifies less than people, or reopens more', () => {
    const lessVerified = buildReport({ ...GOOD, ai: group({ verified: 20, reopened: 1 }) });
    expect(lessVerified.status).toBe('red');
    expect(criterion(lessVerified, 'verified_resolution')?.pass).toBe(false);
    const moreReopens = buildReport({ ...GOOD, ai: group({ verified: 34, reopened: 5 }) });
    expect(moreReopens.status).toBe('red');
    expect(criterion(moreReopens, 'reopen_rate')?.pass).toBe(false);
  });

  it('is red on a CSAT more than 0.1 under people, and insufficient with fewer than 20 answers', () => {
    expect(
      buildReport({ ...GOOD, ai: group({ verified: 34, reopened: 1, csatAvg: 4.3 }) }).status,
    ).toBe('red');
    expect(
      buildReport({ ...GOOD, ai: group({ verified: 34, reopened: 1, csatAvg: 4.45 }) }).status,
    ).toBe('green');
    expect(
      buildReport({ ...GOOD, ai: group({ verified: 34, reopened: 1, csatN: 19 }) }).status,
    ).toBe('insufficient_data');
  });

  it('is red when the AI group has a policy violation', () => {
    const report = buildReport({
      ...GOOD,
      ai: group({ verified: 34, reopened: 1, violations: 1 }),
    });
    expect(report.status).toBe('red');
    expect(criterion(report, 'ai_policy_violations')?.pass).toBe(false);
  });

  it('needs 50 shadow evaluations and 90% accepted', () => {
    expect(buildReport({ ...GOOD, shadowEvaluations: 49 }).status).toBe('insufficient_data');
    expect(buildReport({ ...GOOD, shadowAccepted: 53 }).status).toBe('red');
    expect(criterion(buildReport({ ...GOOD, shadowAccepted: 54 }), 'shadow_precision')?.pass).toBe(
      true,
    );
    expect(buildReport({ ...GOOD, shadowDecided: 0, shadowAccepted: 0 }).status).toBe(
      'insufficient_data',
    );
  });

  it('a stage 3 intent has no "days at stage 2" criterion', () => {
    const report = buildReport({ ...GOOD, stage: 3, daysAtStage: 2 });
    expect(criterion(report, 'days_at_stage_2')).toBeUndefined();
    expect(report.status).toBe('green');
  });
});
