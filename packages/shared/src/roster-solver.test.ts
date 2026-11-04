import { describe, expect, it } from 'vitest';

import {
  ROSTER_DEFAULT_RULES,
  dayDifference,
  evaluateRoster,
  solveRoster,
  suggestCoverage,
  weekdayOf,
  type CoverageRule,
  type RosterAssignment,
  type RosterInput,
  type RosterPerson,
  type RosterShift,
} from './roster-solver.js';

const WEEK = '2026-11-02'; // a Monday

const SHIFTS: RosterShift[] = [
  { id: 'day', name: 'Day', startsAt: '08:00', endsAt: '17:00', onCall: false },
  { id: 'eve', name: 'Evening', startsAt: '13:00', endsAt: '22:00', onCall: false },
  { id: 'night', name: 'Night', startsAt: '22:00', endsAt: '08:00', onCall: true },
];

const person = (id: string, over: Partial<RosterPerson> = {}): RosterPerson => ({
  id,
  name: id,
  queueIds: [],
  unavailable: [],
  ...over,
});

const people = (count: number): RosterPerson[] =>
  Array.from({ length: count }, (_unused, i) => person(`p${String(i + 1).padStart(2, '0')}`));

const rule = (
  shiftId: string,
  required: number,
  over: Partial<CoverageRule> = {},
): CoverageRule => ({
  shiftId,
  weekdays: [],
  required,
  queueId: null,
  ...over,
});

const input = (over: Partial<RosterInput> = {}): RosterInput => ({
  weekStart: WEEK,
  people: people(8),
  shifts: SHIFTS,
  rules: ROSTER_DEFAULT_RULES,
  coverage: [rule('day', 2), rule('eve', 2), rule('night', 1)],
  fixed: [],
  history: {},
  holidays: [],
  ...over,
});

const hardItems = (solution: ReturnType<typeof solveRoster>) =>
  solution.report.items.filter((item) => item.kind === 'hard');

describe('solveRoster fixtures', () => {
  it('covers every shift of the week, breaks no hard rule, and shares the nights', () => {
    const solution = solveRoster(input());
    expect(solution.status).toBe('complete');
    expect(solution.report.hardOk).toBe(true);
    expect(solution.report.coverageOk).toBe(true);
    // 7 days x (2 + 2 + 1)
    expect(solution.assignments).toHaveLength(35);
    const nights = solution.report.loads.map((load) => load.nights);
    expect(Math.max(...nights) - Math.min(...nights)).toBeLessThanOrEqual(1);
    expect(solution.report.items.find((item) => item.id === 'fairness_nights')?.status).toBe(
      'pass',
    );
  });

  it('does not plan or ask coverage for a frozen slot (the shift has started)', () => {
    const frozen = [
      { shiftId: 'day', workDate: WEEK },
      { shiftId: 'eve', workDate: WEEK },
    ];
    const solution = solveRoster(
      input({ frozen, people: people(4), coverage: [rule('day', 1), rule('eve', 1)] }),
    );
    expect(solution.report.coverageOk).toBe(true);
    expect(solution.assignments.some((a) => a.workDate === WEEK)).toBe(false);
  });

  it('is deterministic', () => {
    expect(solveRoster(input())).toEqual(solveRoster(input()));
  });

  it('never rosters someone on a day they are unavailable, even an overnight shift that runs into it', () => {
    const away = people(8).map((p, i) =>
      i === 0 ? { ...p, unavailable: ['2026-11-03', '2026-11-04'] } : p,
    );
    const solution = solveRoster(input({ people: away }));
    expect(solution.report.hardOk).toBe(true);
    const mine = solution.assignments.filter((a) => a.userId === 'p01');
    for (const entry of mine) {
      expect(['2026-11-03', '2026-11-04']).not.toContain(entry.workDate);
      // the night of 11-02 ends on 11-03 morning, which is a day of leave
      expect(entry.shiftId === 'night' && entry.workDate === '2026-11-02').toBe(false);
    }
  });

  it('keeps the rest between two shifts', () => {
    const solution = solveRoster(input());
    const byPerson = new Map<string, RosterAssignment[]>();
    for (const entry of solution.assignments) {
      byPerson.set(entry.userId, [...(byPerson.get(entry.userId) ?? []), entry]);
    }
    for (const list of byPerson.values()) {
      const intervals = list
        .map((entry) => {
          const shift = SHIFTS.find((s) => s.id === entry.shiftId);
          const day = dayDifference(WEEK, entry.workDate);
          const start = day * 1440 + Number(shift?.startsAt.slice(0, 2)) * 60;
          const length = shift?.id === 'night' ? 600 : 540;
          return { start, end: start + length };
        })
        .sort((a, b) => a.start - b.start);
      for (let i = 1; i < intervals.length; i += 1) {
        expect((intervals[i]?.start ?? 0) - (intervals[i - 1]?.end ?? 0)).toBeGreaterThanOrEqual(
          11 * 60,
        );
      }
    }
  });

  it('respects the weekly maximum', () => {
    const solution = solveRoster(
      input({ people: people(8), rules: { ...ROSTER_DEFAULT_RULES, maxShiftsPerWeek: 4 } }),
    );
    expect(solution.report.hardOk).toBe(true);
    for (const load of solution.report.loads) expect(load.shifts).toBeLessThanOrEqual(4);
  });

  it('counts a started shift as fixed: it is not planned again but it covers and it counts toward the limits', () => {
    const fixed: RosterAssignment[] = [{ userId: 'p01', shiftId: 'day', workDate: WEEK }];
    const solution = solveRoster(input({ fixed }));
    expect(solution.report.coverageOk).toBe(true);
    // 35 slots, one already stands
    expect(solution.assignments).toHaveLength(34);
    expect(
      solution.assignments.some(
        (a) => a.userId === 'p01' && a.workDate === WEEK && a.shiftId === 'day',
      ),
    ).toBe(false);
  });

  it('asks for people of a queue', () => {
    const team = people(8).map((p, i) => (i < 3 ? { ...p, queueIds: ['tier2'] } : p));
    const solution = solveRoster(
      input({
        people: team,
        coverage: [rule('day', 2), rule('day', 1, { queueId: 'tier2' })],
      }),
    );
    expect(solution.report.coverageOk).toBe(true);
    for (let day = 0; day < 7; day += 1) {
      const date = `2026-11-0${String(2 + day)}`.replace('2026-11-010', '2026-11-10');
      const onDay = solution.assignments.filter((a) => a.shiftId === 'day' && a.workDate === date);
      expect(onDay.some((a) => ['p01', 'p02', 'p03'].includes(a.userId))).toBe(true);
    }
  });

  it('applies a rule only on its weekdays', () => {
    const solution = solveRoster(
      input({ coverage: [rule('day', 1), rule('day', 3, { weekdays: [6] })] }),
    );
    expect(solution.report.coverageOk).toBe(true);
    const saturday = solution.assignments.filter((a) => a.workDate === '2026-11-07');
    expect(saturday).toHaveLength(3);
    expect(weekdayOf('2026-11-07')).toBe(6);
  });

  it('reports when no plan exists, why, and still returns the best it can', () => {
    // Three people needed on every day shift, two people in the team.
    const solution = solveRoster(input({ people: people(2), coverage: [rule('day', 3)] }));
    expect(solution.status).toBe('no_solution');
    expect(solution.report.coverageOk).toBe(false);
    expect(solution.report.hardOk).toBe(true);
    const coverage = solution.report.items.find((item) => item.id === 'coverage');
    expect(coverage?.status).toBe('fail');
    expect(coverage?.failures).toHaveLength(7);
    expect(coverage?.failures[0]?.params).toMatchObject({ required: 3, assigned: 2 });
  });

  it('names the reason: people on leave', () => {
    const away = people(3).map((p, i) => (i < 2 ? { ...p, unavailable: ['2026-11-04'] } : p));
    const solution = solveRoster(input({ people: away, coverage: [rule('day', 2)] }));
    expect(solution.status).toBe('no_solution');
    const failure = solution.report.items
      .find((item) => item.id === 'coverage')
      ?.failures.find((f) => f.workDate === '2026-11-04');
    expect(failure?.params).toMatchObject({ required: 2, assigned: 1, unavailable: 2 });
  });

  it('reports not enough shifts per week as no solution, without searching', () => {
    const solution = solveRoster(
      input({
        people: people(2),
        rules: { ...ROSTER_DEFAULT_RULES, maxShiftsPerWeek: 2 },
        coverage: [rule('day', 1)],
      }),
    );
    expect(solution.status).toBe('no_solution');
    expect(solution.report.hardOk).toBe(true);
    expect(solution.nodes).toBe(0);
  });

  it('evaluates a hand edit: reports the broken rule and keeps the rest', () => {
    const solution = solveRoster(input());
    const edited: RosterAssignment[] = [
      ...solution.assignments.filter((a) => a.userId !== 'p01'),
      { userId: 'p01', shiftId: 'night', workDate: '2026-11-02' },
      { userId: 'p01', shiftId: 'day', workDate: '2026-11-03' },
    ];
    const report = evaluateRoster(input(), edited);
    expect(report.hardOk).toBe(false);
    expect(report.items.find((item) => item.id === 'rest')?.status).toBe('fail');
  });

  it('flags too many nights in a row', () => {
    const nights: RosterAssignment[] = [0, 1, 2, 3].map((d) => ({
      userId: 'p01',
      shiftId: 'night',
      workDate: `2026-11-0${String(2 + d)}`,
    }));
    const report = evaluateRoster(input({ coverage: [] }), nights);
    expect(report.items.find((item) => item.id === 'max_consecutive_nights')?.status).toBe('fail');
  });

  it('carries the fairness over from history', () => {
    const history = Object.fromEntries(
      people(8).map((p) => [p.id, { nights: p.id === 'p01' ? 5 : 0, heavyDays: 0 }]),
    );
    const solution = solveRoster(input({ history }));
    expect(
      solution.assignments.filter((a) => a.userId === 'p01' && a.shiftId === 'night'),
    ).toHaveLength(0);
  });
});

describe('suggestCoverage', () => {
  it('turns the volume of each shift window into a head count per weekday', () => {
    // 4 weeks; every Monday (2026-11-02 minus whole weeks) 90 tickets between 09:00 and 10:00.
    const volume = [0, 1, 2, 3].map((w) => ({
      date: `2026-10-${String(5 + w * 7).padStart(2, '0')}`,
      minute: 9 * 60,
      count: 90,
    }));
    const rules = suggestCoverage(SHIFTS, volume, {
      days: 28,
      ticketsPerPersonPerShift: 20,
      minimum: 1,
      maximum: 6,
    });
    const day = rules.filter((r) => r.shiftId === 'day');
    expect(weekdayOf('2026-10-05')).toBe(1);
    expect(day.find((r) => r.weekdays.includes(1))?.required).toBe(5); // ceil(90 / 20)
    expect(day.find((r) => r.weekdays.includes(2))?.required).toBe(1);
    // nothing arrived at night: the minimum
    expect(rules.filter((r) => r.shiftId === 'night')).toEqual([
      { shiftId: 'night', weekdays: [], required: 1, queueId: null },
    ]);
  });

  it('puts the small hours on the day the night shift started', () => {
    const rules = suggestCoverage(SHIFTS, [{ date: '2026-10-06', minute: 2 * 60, count: 80 }], {
      days: 7,
      ticketsPerPersonPerShift: 20,
      minimum: 1,
      maximum: 6,
    });
    // 2026-10-06 is a Tuesday, so the night shift that started on Monday carries it
    const night = rules.filter((r) => r.shiftId === 'night');
    expect(night.find((r) => r.weekdays.includes(1))?.required).toBe(4);
  });
});

// --- property tests -----------------------------------------------------------------------------

function mulberry(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInput(seed: number): RosterInput {
  const random = mulberry(seed);
  const pick = (n: number): number => Math.floor(random() * n);
  const team = people(4 + pick(8)).map((p) => ({
    ...p,
    queueIds: random() < 0.4 ? ['q1'] : [],
    unavailable: Array.from({ length: pick(3) }, () => `2026-11-0${String(2 + pick(6))}`),
  }));
  const rules = {
    minRestHours: 8 + pick(5),
    maxShiftsPerWeek: 3 + pick(4),
    maxConsecutiveDays: 3 + pick(4),
    maxConsecutiveNights: 1 + pick(3),
  };
  const coverage: CoverageRule[] = SHIFTS.map((shift) =>
    rule(shift.id, 1 + pick(3), random() < 0.3 ? { weekdays: [0, 6] } : {}),
  );
  if (random() < 0.5) coverage.push(rule('day', 1, { queueId: 'q1' }));
  return {
    weekStart: WEEK,
    people: team,
    shifts: SHIFTS,
    rules,
    coverage,
    fixed: [],
    history: {},
    holidays: random() < 0.3 ? ['2026-11-04'] : [],
  };
}

describe('solveRoster properties', () => {
  it('never breaks a hard rule, with or without a plan that meets coverage', () => {
    let complete = 0;
    for (let seed = 1; seed <= 150; seed += 1) {
      const subject = randomInput(seed);
      const solution = solveRoster(subject);
      const broken = hardItems(solution).filter((item) => item.status === 'fail');
      expect(broken, `seed ${String(seed)}`).toEqual([]);
      // the solver's own answer and an independent evaluation of its assignments agree
      expect(evaluateRoster(subject, solution.assignments)).toEqual(solution.report);
      if (solution.status === 'complete') {
        complete += 1;
        expect(solution.report.coverageOk).toBe(true);
      } else {
        expect(solution.report.coverageOk).toBe(false);
        expect(
          solution.report.items.find((item) => item.id === 'coverage')?.failures.length,
        ).toBeGreaterThan(0);
      }
    }
    expect(complete).toBeGreaterThan(20);
  }, 60_000);

  it('finds a plan whenever one exists (demand built from a random plan that is known to be valid)', () => {
    let ran = 0;
    for (let seed = 1000; seed < 1080; seed += 1) {
      const random = mulberry(seed);
      const pick = (n: number): number => Math.floor(random() * n);
      const base = { ...randomInput(seed), coverage: [] as CoverageRule[] };
      // Plant: add random shifts one at a time, keeping only those the checker accepts.
      let planted: RosterAssignment[] = [];
      for (let attempt = 0; attempt < 70; attempt += 1) {
        const entry: RosterAssignment = {
          userId: base.people[pick(base.people.length)]?.id ?? '',
          shiftId: SHIFTS[pick(SHIFTS.length)]?.id ?? '',
          workDate: `2026-11-0${String(2 + pick(6))}`,
        };
        if (
          planted.some(
            (p) =>
              p.userId === entry.userId &&
              p.shiftId === entry.shiftId &&
              p.workDate === entry.workDate,
          )
        ) {
          continue;
        }
        const next = [...planted, entry];
        if (evaluateRoster(base, next).hardOk) planted = next;
      }
      const counts = new Map<string, number>();
      for (const entry of planted) {
        const key = `${entry.shiftId}|${entry.workDate}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const coverage: CoverageRule[] = [...counts].map(([key, count]) => {
        const [shiftId = '', date = ''] = key.split('|');
        return rule(shiftId, count, { weekdays: [weekdayOf(date)] });
      });
      const solution = solveRoster({ ...base, coverage });
      expect(solution.status, `seed ${String(seed)}`).toBe('complete');
      expect(solution.report.hardOk).toBe(true);
      ran += 1;
    }
    expect(ran).toBe(80);
  }, 60_000);
});
