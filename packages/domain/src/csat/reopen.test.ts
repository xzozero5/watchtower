import { describe, expect, it } from 'vitest';

import { decideCsatReopen, isWithinReopenWindow } from './reopen.js';

const NOW = new Date('2030-03-15T12:00:00.000Z');
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 24 * 3600 * 1000);
const base = {
  ticketStatus: 'resolved',
  resolvedAt: daysAgo(1),
  now: NOW,
  windowDays: 7,
  resolved: undefined,
} as const;

describe('isWithinReopenWindow (R-1.10)', () => {
  it('is true up to and including the last instant of the window', () => {
    expect(isWithinReopenWindow(daysAgo(7), NOW, 7)).toBe(true);
    expect(isWithinReopenWindow(new Date(daysAgo(7).getTime() - 1), NOW, 7)).toBe(false);
  });

  it('is false for a ticket with no resolve time', () => {
    expect(isWithinReopenWindow(null, NOW, 7)).toBe(false);
  });
});

describe('decideCsatReopen (R-1.10, R-10.5)', () => {
  it.each([1, 2])('reopens on a score of %i', (score) => {
    expect(decideCsatReopen({ ...base, score })).toEqual({ reopen: true, reason: 'low_score' });
  });

  it.each([3, 4, 5])('does not reopen on a score of %i', (score) => {
    expect(decideCsatReopen({ ...base, score })).toEqual({ reopen: false, reason: 'no_trigger' });
  });

  it('reopens when the customer says it was not resolved, whatever the score', () => {
    expect(decideCsatReopen({ ...base, score: 5, resolved: false })).toEqual({
      reopen: true,
      reason: 'not_resolved',
    });
  });

  it('records the low score as the reason when both apply', () => {
    expect(decideCsatReopen({ ...base, score: 1, resolved: false })).toEqual({
      reopen: true,
      reason: 'low_score',
    });
  });

  it('does not reopen when the customer says it was resolved or says nothing', () => {
    expect(decideCsatReopen({ ...base, score: 4, resolved: true }).reopen).toBe(false);
    expect(decideCsatReopen({ ...base, score: 4 }).reopen).toBe(false);
  });

  it('does not reopen once the 7-day window has passed', () => {
    expect(decideCsatReopen({ ...base, score: 1, resolvedAt: daysAgo(8) })).toEqual({
      reopen: false,
      reason: 'window_closed',
    });
  });

  it.each(['open', 'closed', 'waiting_on_customer'])(
    'does not reopen a ticket that is %s (already reopened, or final)',
    (ticketStatus) => {
      expect(decideCsatReopen({ ...base, score: 1, ticketStatus })).toEqual({
        reopen: false,
        reason: 'not_resolved_status',
      });
    },
  );

  it('honours a different window', () => {
    const input = { ...base, score: 1, resolvedAt: daysAgo(10) };
    expect(decideCsatReopen({ ...input, windowDays: 14 }).reopen).toBe(true);
    expect(decideCsatReopen({ ...input, windowDays: 7 }).reopen).toBe(false);
  });
});
