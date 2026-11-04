import { describe, expect, it } from 'vitest';

import { currentWeeklySlot, weeklySlotInstant } from './weekly-brief.js';

const bangkok = { day: 'mon', time: '08:00', timeZone: 'Asia/Bangkok' } as const;

describe('currentWeeklySlot', () => {
  it('is the Monday just passed when it is later in the week', () => {
    // Wednesday 2026-11-04 10:00 Bangkok.
    expect(currentWeeklySlot(new Date('2026-11-04T03:00:00Z'), bangkok)).toBe('2026-11-02');
  });

  it('is today from the configured time on, and last week before it', () => {
    // Monday 2026-11-09 07:59 Bangkok = 00:59Z: still last week's slot.
    expect(currentWeeklySlot(new Date('2026-11-09T00:59:00Z'), bangkok)).toBe('2026-11-02');
    // 08:00 Bangkok = 01:00Z: this week's slot opens.
    expect(currentWeeklySlot(new Date('2026-11-09T01:00:00Z'), bangkok)).toBe('2026-11-09');
  });

  it('reads the day in the zone, not in UTC', () => {
    // Sunday 2026-11-08 20:00Z is already Monday 03:00 in Bangkok: before 08:00, so the slot is last Monday.
    expect(currentWeeklySlot(new Date('2026-11-08T20:00:00Z'), bangkok)).toBe('2026-11-02');
    expect(
      currentWeeklySlot(new Date('2026-11-08T20:00:00Z'), { ...bangkok, timeZone: 'UTC' }),
    ).toBe('2026-11-02');
  });

  it('works for another day, and across a month end', () => {
    const friday = { day: 'fri', time: '17:30', timeZone: 'UTC' } as const;
    expect(currentWeeklySlot(new Date('2026-12-02T12:00:00Z'), friday)).toBe('2026-11-27');
    expect(currentWeeklySlot(new Date('2026-11-27T17:30:00Z'), friday)).toBe('2026-11-27');
  });

  it('refuses a time that is not HH:MM', () => {
    expect(() => currentWeeklySlot(new Date(), { ...bangkok, time: '8am' })).toThrow();
  });
});

describe('weeklySlotInstant', () => {
  it('is the slot date at the time in the zone', () => {
    expect(weeklySlotInstant('2026-11-09', bangkok).toISOString()).toBe('2026-11-09T01:00:00.000Z');
    expect(weeklySlotInstant('2026-11-09', { ...bangkok, timeZone: 'UTC' }).toISOString()).toBe(
      '2026-11-09T08:00:00.000Z',
    );
  });
});
