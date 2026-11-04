import type { RosterPlan, RosterPlanDefaults } from '@watchtower/shared';

import { uuid } from './fixtures';
import { DAY_SHIFT_ID, NIGHT_SHIFT_ID, SHIFT_TZ, WHO } from './shift-fixtures';

/** Roster planner fixtures (T-305e): invented names only (N1). The week starts on Monday 2026-11-09. */
export const PLAN_ID = uuid(5000);
export const WEEK = '2026-11-09';

const SHIFTS = [
  { id: DAY_SHIFT_ID, name: 'Day', startsAt: '08:00', endsAt: '17:00', onCall: false },
  { id: NIGHT_SHIFT_ID, name: 'On-call night', startsAt: '22:00', endsAt: '08:00', onCall: true },
];
const PEOPLE = [WHO.mana, WHO.pim, WHO.dao].map((person) => ({
  id: person.id,
  name: person.name,
  queueIds: [] as string[],
  unavailable: [] as string[],
}));

export function planDefaults(overrides: Partial<RosterPlanDefaults> = {}): RosterPlanDefaults {
  return {
    weekStart: WEEK,
    timezone: SHIFT_TZ,
    people: PEOPLE.map((person) => ({ ...person, role: 'agent' })),
    queues: [],
    shifts: SHIFTS,
    rules: {
      minRestHours: 11,
      maxShiftsPerWeek: 5,
      maxConsecutiveDays: 6,
      maxConsecutiveNights: 3,
    },
    coverage: [
      { shiftId: DAY_SHIFT_ID, weekdays: [], required: 2, queueId: null },
      { shiftId: NIGHT_SHIFT_ID, weekdays: [], required: 1, queueId: null },
    ],
    coverageSource: 'suggested',
    ticketsPerPersonPerShift: 15,
    ...overrides,
  };
}

const passItem = (
  id: RosterPlan['report']['items'][number]['id'],
  kind: 'hard' | 'coverage' | 'fairness',
) => ({
  id,
  kind,
  status: 'pass' as const,
  message: id,
  failures: [],
});

export function plan(overrides: Partial<RosterPlan> = {}): RosterPlan {
  const day = (userName: string, userId: string, workDate: string) => ({
    userId,
    userName,
    shiftId: DAY_SHIFT_ID,
    shiftName: 'Day',
    workDate,
    locked: false,
  });
  return {
    id: PLAN_ID,
    weekStart: WEEK,
    status: 'draft',
    timezone: SHIFT_TZ,
    entries: [
      day(WHO.mana.name, WHO.mana.id, WEEK),
      day(WHO.pim.name, WHO.pim.id, WEEK),
      {
        userId: WHO.dao.id,
        userName: WHO.dao.name,
        shiftId: NIGHT_SHIFT_ID,
        shiftName: 'On-call night',
        workDate: WEEK,
        locked: false,
      },
    ],
    inputs: {
      weekStart: WEEK,
      people: PEOPLE,
      shifts: SHIFTS,
      rules: {
        minRestHours: 11,
        maxShiftsPerWeek: 5,
        maxConsecutiveDays: 6,
        maxConsecutiveNights: 3,
      },
      coverage: planDefaults().coverage,
      coverageSource: 'suggested',
      fixed: [],
      history: {},
      holidays: [],
    },
    report: {
      hardOk: true,
      coverageOk: true,
      items: [
        passItem('unavailable', 'hard'),
        passItem('rest', 'hard'),
        passItem('max_shifts_week', 'hard'),
        passItem('max_consecutive_days', 'hard'),
        passItem('max_consecutive_nights', 'hard'),
        passItem('coverage', 'coverage'),
        passItem('fairness_nights', 'fairness'),
        passItem('fairness_heavy_days', 'fairness'),
      ],
      loads: [
        { userId: WHO.mana.id, shifts: 1, nights: 0, heavyDays: 0 },
        { userId: WHO.pim.id, shifts: 1, nights: 0, heavyDays: 0 },
        { userId: WHO.dao.id, shifts: 1, nights: 1, heavyDays: 0 },
      ],
    },
    solver: { status: 'complete', nodes: 12 },
    explanation: null,
    diff: { add: 3, remove: 0, keep: 0, locked: 0, started: 0 },
    createdBy: WHO.me.id,
    createdAt: '2026-11-02T03:00:00.000Z',
    updatedAt: '2026-11-02T03:00:00.000Z',
    appliedAt: null,
    ...overrides,
  };
}

/** A plan whose Tuesday day shift has one person of two and that the program proved cannot be covered. */
export function shortPlan(): RosterPlan {
  const base = plan();
  return plan({
    solver: { status: 'no_solution', nodes: 0 },
    report: {
      ...base.report,
      coverageOk: false,
      items: base.report.items.map((item) =>
        item.id === 'coverage'
          ? {
              ...item,
              status: 'fail' as const,
              failures: [
                {
                  code: 'coverage_short',
                  userId: null,
                  shiftId: DAY_SHIFT_ID,
                  workDate: '2026-11-10',
                  message: 'Fewer people than the shift needs',
                  params: { required: 2, assigned: 1, queueId: '', unavailable: 2 },
                },
              ],
            }
          : item,
      ),
    },
  });
}

export function brokenPlan(): RosterPlan {
  const base = plan();
  return plan({
    report: {
      ...base.report,
      hardOk: false,
      items: base.report.items.map((item) =>
        item.id === 'rest'
          ? {
              ...item,
              status: 'fail' as const,
              failures: [
                {
                  code: 'rest',
                  userId: WHO.mana.id,
                  shiftId: DAY_SHIFT_ID,
                  workDate: '2026-11-10',
                  message: 'Less than the minimum rest before this shift',
                  params: { preExisting: 0 },
                },
              ],
            }
          : item,
      ),
    },
  });
}
