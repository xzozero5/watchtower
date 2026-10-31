import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WEEKLY_HOURS,
  SlaCalendarError,
  addSlaMinutes,
  computeSlaDueDates,
  resumeDueAfterPause,
  slaMinutesBetween,
  slaTargetsSchema,
  weeklyHoursSchema,
  type BusinessCalendar,
} from './sla.js';

// Bangkok is UTC+7 all year. Business hours 09:00 to 18:00 local are 02:00Z to 11:00Z.
// 2026-11-02 is a Monday, 2026-11-06 a Friday, 2026-11-07 a Saturday, 2026-10-31 a Saturday.
const bangkok: BusinessCalendar = {
  timezone: 'Asia/Bangkok',
  hours: DEFAULT_WEEKLY_HOURS,
  holidays: [],
};

const at = (iso: string) => new Date(iso);
const iso = (date: Date) => date.toISOString();

describe('addSlaMinutes on the business clock', () => {
  it('adds inside one working day', () => {
    // Monday 10:00 local + 60 min = 11:00 local.
    expect(iso(addSlaMinutes(at('2026-11-02T03:00:00Z'), 60, 'business', bangkok))).toBe(
      '2026-11-02T04:00:00.000Z',
    );
  });

  it('stops at closing time and continues the next morning', () => {
    // Monday 17:00 local + 120 min: 1 h left today, 1 h tomorrow = Tuesday 10:00 local.
    expect(iso(addSlaMinutes(at('2026-11-02T10:00:00Z'), 120, 'business', bangkok))).toBe(
      '2026-11-03T03:00:00.000Z',
    );
  });

  it('skips the weekend', () => {
    // Friday 17:00 local + 120 min = Monday 10:00 local.
    expect(iso(addSlaMinutes(at('2026-11-06T10:00:00Z'), 120, 'business', bangkok))).toBe(
      '2026-11-09T03:00:00.000Z',
    );
  });

  it('starts counting at the next opening when created on a weekend', () => {
    // Saturday 10:00 local + 30 min = Monday 09:30 local.
    expect(iso(addSlaMinutes(at('2026-10-31T03:00:00Z'), 30, 'business', bangkok))).toBe(
      '2026-11-02T02:30:00.000Z',
    );
  });

  it('starts counting at opening when created before the working day', () => {
    // Monday 07:00 local + 60 min = Monday 10:00 local.
    expect(iso(addSlaMinutes(at('2026-11-02T00:00:00Z'), 60, 'business', bangkok))).toBe(
      '2026-11-02T03:00:00.000Z',
    );
  });

  it('starts counting the next day when created after closing', () => {
    // Monday 19:00 local + 60 min = Tuesday 10:00 local.
    expect(iso(addSlaMinutes(at('2026-11-02T12:00:00Z'), 60, 'business', bangkok))).toBe(
      '2026-11-03T03:00:00.000Z',
    );
  });

  it('can end exactly at closing time', () => {
    expect(iso(addSlaMinutes(at('2026-11-02T10:00:00Z'), 60, 'business', bangkok))).toBe(
      '2026-11-02T11:00:00.000Z',
    );
  });

  it('keeps the seconds of the start instant', () => {
    expect(iso(addSlaMinutes(at('2026-11-02T03:00:30Z'), 15, 'business', bangkok))).toBe(
      '2026-11-02T03:15:30.000Z',
    );
  });

  it('returns the start instant for a zero target', () => {
    const from = at('2026-10-31T03:00:00Z');
    expect(iso(addSlaMinutes(from, 0, 'business', bangkok))).toBe(iso(from));
  });

  it('skips a public holiday', () => {
    // Monday 2026-11-09 is a holiday: Friday 17:00 local + 120 min = Tuesday 10:00 local.
    const calendar: BusinessCalendar = { ...bangkok, holidays: ['2026-11-09'] };
    expect(iso(addSlaMinutes(at('2026-11-06T10:00:00Z'), 120, 'business', calendar))).toBe(
      '2026-11-10T03:00:00.000Z',
    );
  });

  it('skips a holiday that follows a weekend and a holiday before it', () => {
    // Friday and the next Monday are both holidays: Thursday 17:30 local + 60 min.
    const calendar: BusinessCalendar = { ...bangkok, holidays: ['2026-11-06', '2026-11-09'] };
    // 30 min Thursday, then Tuesday 09:00 + 30 min = 09:30 local.
    expect(iso(addSlaMinutes(at('2026-11-05T10:30:00Z'), 60, 'business', calendar))).toBe(
      '2026-11-10T02:30:00.000Z',
    );
  });

  it('honours a lunch break', () => {
    const calendar: BusinessCalendar = {
      ...bangkok,
      hours: {
        ...DEFAULT_WEEKLY_HOURS,
        mon: [
          { start: '09:00', end: '12:00' },
          { start: '13:00', end: '18:00' },
        ],
      },
    };
    // Monday 11:00 local + 120 min: 60 min before lunch, 60 min after = 14:00 local.
    expect(iso(addSlaMinutes(at('2026-11-02T04:00:00Z'), 120, 'business', calendar))).toBe(
      '2026-11-02T07:00:00.000Z',
    );
  });

  it('handles a target longer than a week', () => {
    // 5 working days of 9 h = 2700 min, from Monday 09:00 local: Friday 18:00 local.
    expect(iso(addSlaMinutes(at('2026-11-02T02:00:00Z'), 2700, 'business', bangkok))).toBe(
      '2026-11-06T11:00:00.000Z',
    );
  });

  it('fails clearly when the calendar never opens', () => {
    const closed: BusinessCalendar = {
      ...bangkok,
      hours: { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
    };
    expect(() => addSlaMinutes(at('2026-11-02T03:00:00Z'), 60, 'business', closed)).toThrow(
      SlaCalendarError,
    );
  });

  it('rejects a negative or non-finite duration', () => {
    expect(() => addSlaMinutes(at('2026-11-02T03:00:00Z'), -1, 'business', bangkok)).toThrow(
      SlaCalendarError,
    );
    expect(() => addSlaMinutes(at('2026-11-02T03:00:00Z'), Number.NaN, '24x7', bangkok)).toThrow(
      SlaCalendarError,
    );
  });

  it('uses the timezone of the calendar, including a day with a daylight saving change', () => {
    const everyDay = { start: '00:00', end: '24:00' } as const;
    const newYork: BusinessCalendar = {
      timezone: 'America/New_York',
      hours: {
        sun: [everyDay],
        mon: [everyDay],
        tue: [everyDay],
        wed: [everyDay],
        thu: [everyDay],
        fri: [everyDay],
        sat: [everyDay],
      },
      holidays: [],
    };
    // 2026-03-08 has only 23 hours in New York (clocks jump forward at 02:00). From local midnight
    // (05:00Z), 23 h of "business" time end at the next local midnight (04:00Z), not 05:00Z.
    expect(iso(addSlaMinutes(at('2026-03-08T05:00:00Z'), 23 * 60, 'business', newYork))).toBe(
      '2026-03-09T04:00:00.000Z',
    );
  });
});

describe('addSlaMinutes on the 24x7 clock', () => {
  it('ignores hours, weekends and holidays', () => {
    const calendar: BusinessCalendar = { ...bangkok, holidays: ['2026-11-09'] };
    expect(iso(addSlaMinutes(at('2026-11-06T10:00:00Z'), 120, '24x7', calendar))).toBe(
      '2026-11-06T12:00:00.000Z',
    );
  });
});

describe('slaMinutesBetween', () => {
  it('counts only business time', () => {
    // Friday 16:00 local to Monday 10:00 local = 2 h Friday + 1 h Monday.
    expect(
      slaMinutesBetween(
        at('2026-11-06T09:00:00Z'),
        at('2026-11-09T03:00:00Z'),
        'business',
        bangkok,
      ),
    ).toBe(180);
  });

  it('counts wall time on the 24x7 clock', () => {
    expect(
      slaMinutesBetween(at('2026-11-06T09:00:00Z'), at('2026-11-09T03:00:00Z'), '24x7', bangkok),
    ).toBe(66 * 60);
  });

  it('is zero for an empty or reversed interval', () => {
    const when = at('2026-11-02T03:00:00Z');
    expect(slaMinutesBetween(when, when, 'business', bangkok)).toBe(0);
    expect(slaMinutesBetween(at('2026-11-02T04:00:00Z'), when, 'business', bangkok)).toBe(0);
  });

  it('does not count a holiday', () => {
    const calendar: BusinessCalendar = { ...bangkok, holidays: ['2026-11-09'] };
    // Friday 17:00 local to Tuesday 10:00 local: 1 h Friday, 0 Monday (holiday), 1 h Tuesday.
    expect(
      slaMinutesBetween(
        at('2026-11-06T10:00:00Z'),
        at('2026-11-10T03:00:00Z'),
        'business',
        calendar,
      ),
    ).toBe(120);
  });
});

describe('computeSlaDueDates', () => {
  const targets = slaTargetsSchema.parse({
    P1: { first_response_min: 15, resolution_min: 240, calendar: '24x7' },
    P3: { first_response_min: 240, resolution_min: 2400 },
  });

  it('gives P1 the 24x7 clock and P3 the business clock', () => {
    // Saturday 10:00 local.
    const startedAt = at('2026-10-31T03:00:00Z');
    const p1 = computeSlaDueDates({ startedAt, priority: 'P1', targets, calendar: bangkok });
    expect(p1.firstResponseDueAt && iso(p1.firstResponseDueAt)).toBe('2026-10-31T03:15:00.000Z');
    expect(p1.resolutionDueAt && iso(p1.resolutionDueAt)).toBe('2026-10-31T07:00:00.000Z');

    const p3 = computeSlaDueDates({ startedAt, priority: 'P3', targets, calendar: bangkok });
    // 4 business hours from Monday 09:00 local = 13:00 local.
    expect(p3.firstResponseDueAt && iso(p3.firstResponseDueAt)).toBe('2026-11-02T06:00:00.000Z');
  });

  it('gives no due date for a priority without a target', () => {
    expect(
      computeSlaDueDates({
        startedAt: at('2026-11-02T03:00:00Z'),
        priority: 'P2',
        targets,
        calendar: bangkok,
      }),
    ).toEqual({ firstResponseDueAt: null, resolutionDueAt: null });
  });
});

describe('resumeDueAfterPause', () => {
  it('keeps the remaining business time across an overnight pause', () => {
    // Due Monday 14:00 local. Paused Monday 12:00 local (2 h left), resumed Tuesday 10:00 local.
    expect(
      iso(
        resumeDueAfterPause({
          pausedAt: at('2026-11-02T05:00:00Z'),
          resumedAt: at('2026-11-03T03:00:00Z'),
          due: at('2026-11-02T07:00:00Z'),
          mode: 'business',
          calendar: bangkok,
        }),
      ),
    ).toBe('2026-11-03T05:00:00.000Z');
  });

  it('does not let a weekend pause eat the remaining time', () => {
    // Due Friday 17:30 local. Paused Friday 16:00 local (90 min left), resumed Monday 10:00 local.
    expect(
      iso(
        resumeDueAfterPause({
          pausedAt: at('2026-11-06T09:00:00Z'),
          resumedAt: at('2026-11-09T03:00:00Z'),
          due: at('2026-11-06T10:30:00Z'),
          mode: 'business',
          calendar: bangkok,
        }),
      ),
    ).toBe('2026-11-09T04:30:00.000Z');
  });

  it('moves a 24x7 due date by exactly the length of the pause', () => {
    expect(
      iso(
        resumeDueAfterPause({
          pausedAt: at('2026-11-06T10:00:00Z'),
          resumedAt: at('2026-11-07T10:00:00Z'),
          due: at('2026-11-06T12:00:00Z'),
          mode: '24x7',
          calendar: bangkok,
        }),
      ),
    ).toBe('2026-11-07T12:00:00.000Z');
  });

  it('leaves a target that was already missed when the clock stopped', () => {
    const due = at('2026-11-02T04:00:00Z');
    expect(
      resumeDueAfterPause({
        pausedAt: at('2026-11-02T06:00:00Z'),
        resumedAt: at('2026-11-03T03:00:00Z'),
        due,
        mode: 'business',
        calendar: bangkok,
      }),
    ).toEqual(due);
  });

  it('is a no-op when resumed at the instant it paused', () => {
    const due = at('2026-11-02T08:00:00Z');
    const pausedAt = at('2026-11-02T05:00:00Z');
    expect(
      resumeDueAfterPause({
        pausedAt,
        resumedAt: pausedAt,
        due,
        mode: 'business',
        calendar: bangkok,
      }),
    ).toEqual(due);
  });
});

describe('schemas', () => {
  it('rejects overlapping or unsorted windows and an empty week', () => {
    expect(
      weeklyHoursSchema.safeParse({
        ...DEFAULT_WEEKLY_HOURS,
        mon: [
          { start: '09:00', end: '12:00' },
          { start: '11:00', end: '13:00' },
        ],
      }).success,
    ).toBe(false);
    expect(
      weeklyHoursSchema.safeParse({
        sun: [],
        mon: [],
        tue: [],
        wed: [],
        thu: [],
        fri: [],
        sat: [],
      }).success,
    ).toBe(false);
    expect(weeklyHoursSchema.safeParse(DEFAULT_WEEKLY_HOURS).success).toBe(true);
  });

  it('rejects a window that ends before it starts', () => {
    expect(
      weeklyHoursSchema.safeParse({
        ...DEFAULT_WEEKLY_HOURS,
        mon: [{ start: '18:00', end: '09:00' }],
      }).success,
    ).toBe(false);
  });

  it('rejects a first response target longer than the resolution target', () => {
    expect(
      slaTargetsSchema.safeParse({ P1: { first_response_min: 600, resolution_min: 60 } }).success,
    ).toBe(false);
  });
});
