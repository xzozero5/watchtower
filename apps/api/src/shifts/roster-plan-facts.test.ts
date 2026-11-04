import type { RosterPlan } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { buildExplainFacts, restoreNames } from './roster-plan-facts.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const DAY = '00000000-0000-4000-8000-0000000000d1';

const plan = {
  id: '00000000-0000-4000-8000-0000000000c1',
  weekStart: '2026-11-02',
  status: 'draft',
  timezone: 'Asia/Bangkok',
  entries: [
    {
      userId: B,
      userName: 'Bella Planner',
      shiftId: DAY,
      shiftName: 'Day',
      workDate: '2026-11-02',
      locked: false,
    },
    {
      userId: A,
      userName: 'Anan Planner',
      shiftId: DAY,
      shiftName: 'Day',
      workDate: '2026-11-02',
      locked: true,
    },
  ],
  inputs: {
    weekStart: '2026-11-02',
    people: [
      { id: B, name: 'Bella Planner', queueIds: [], unavailable: [] },
      { id: A, name: 'Anan Planner', queueIds: [], unavailable: [] },
    ],
    shifts: [{ id: DAY, name: 'Day', startsAt: '08:00', endsAt: '17:00', onCall: false }],
    rules: {
      minRestHours: 11,
      maxShiftsPerWeek: 5,
      maxConsecutiveDays: 6,
      maxConsecutiveNights: 3,
    },
    coverage: [],
    coverageSource: 'given',
    fixed: [],
    history: {},
    holidays: [],
  },
  report: {
    hardOk: false,
    coverageOk: false,
    items: [
      {
        id: 'rest',
        kind: 'hard',
        status: 'fail',
        message: 'x',
        failures: [
          {
            code: 'rest',
            userId: B,
            shiftId: DAY,
            workDate: '2026-11-03',
            message: 'm',
            params: {},
          },
        ],
      },
    ],
    loads: [
      { userId: A, shifts: 1, nights: 0, heavyDays: 0 },
      { userId: B, shifts: 1, nights: 0, heavyDays: 0 },
    ],
  },
  solver: { status: 'no_solution', nodes: 0 },
  explanation: null,
  diff: { add: 0, remove: 0, keep: 0, locked: 1, started: 0 },
  createdBy: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  appliedAt: null,
} satisfies RosterPlan;

describe('buildExplainFacts', () => {
  it('turns people into labels in the order of their ids and keeps no name in the facts', () => {
    const { facts, names } = buildExplainFacts(plan);
    const text = JSON.stringify(facts);
    expect(text).not.toContain('Planner');
    expect(names.get('staff-1')).toBe('Anan Planner');
    expect(names.get('staff-2')).toBe('Bella Planner');
    expect(facts.days[0]?.shifts[0]?.people).toEqual(['staff-2', 'staff-1']);
    expect(facts.checks[0]?.failures[0]).toMatchObject({
      label: 'staff-2',
      shift: 'Day',
      date: '2026-11-03',
    });
    expect(facts.solverStatus).toBe('no_solution');
  });
});

describe('restoreNames', () => {
  it('puts names back, and leaves a label it does not know', () => {
    const names = new Map([['staff-1', 'Anan Planner']]);
    expect(restoreNames('staff-1 and staff-9, not staff-10x', names)).toBe(
      'Anan Planner and staff-9, not staff-10x',
    );
  });
});
