import { describe, expect, it } from 'vitest';

import { formatDuration } from '@/lib/format';
import { makeClientTicket, makeTicket } from '@/test/fixtures';

import { slaView } from './sla';

const NOW = Date.parse('2026-11-02T03:00:00.000Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
// Created 4 hours before NOW, so a 4 h target ends at NOW.
const created = at(-240);

describe('slaView (spec section 4.4)', () => {
  it('on track: more than a quarter of the target and 30 minutes are left', () => {
    const view = slaView(makeTicket(1, { createdAt: created, firstResponseDueAt: at(180) }), NOW);
    expect(view).toMatchObject({ state: 'onTrack', target: 'firstResponse', ms: 180 * 60_000 });
  });

  it('at risk: a quarter of the target left, or 30 minutes', () => {
    const quarter = makeTicket(1, { createdAt: created, firstResponseDueAt: at(55) });
    expect(slaView(quarter, NOW).state).toBe('atRisk');
    // The target runs from creation to due (330 min here), so 25% is 82 min: 90 left is on track.
    expect(
      slaView(makeTicket(1, { createdAt: created, firstResponseDueAt: at(90) }), NOW).state,
    ).toBe('onTrack');
    const longTarget = makeTicket(1, { createdAt: at(-60 * 24 * 7), firstResponseDueAt: at(30) });
    expect(slaView(longTarget, NOW).state).toBe('atRisk');
  });

  it('breached: past due, with how long ago', () => {
    const view = slaView(makeTicket(1, { createdAt: created, firstResponseDueAt: at(-12) }), NOW);
    expect(view).toMatchObject({ state: 'breached', target: 'firstResponse', ms: 12 * 60_000 });
  });

  it('shows the next target: first response until answered, then resolution', () => {
    const answered = makeTicket(1, {
      createdAt: created,
      firstRespondedAt: at(-100),
      firstResponseDueAt: at(-90),
      resolutionDueAt: at(600),
    });
    expect(slaView(answered, NOW)).toMatchObject({ state: 'onTrack', target: 'resolution' });
  });

  it('paused while waiting on the customer', () => {
    const view = slaView(
      makeTicket(1, {
        status: 'waiting_on_customer',
        slaPausedAt: at(-5),
        createdAt: created,
        resolutionDueAt: at(100),
        firstRespondedAt: at(-100),
      }),
      NOW,
    );
    expect(view.state).toBe('paused');
  });

  it('met once everything due has been done, and none when there is no SLA', () => {
    const done = makeTicket(1, {
      status: 'resolved',
      firstRespondedAt: at(-100),
      resolvedAt: at(-10),
      resolutionDueAt: at(300),
    });
    expect(slaView(done, NOW).state).toBe('met');
    expect(slaView(makeTicket(2), NOW).state).toBe('none');
  });

  it('shows nothing for a customer: their view carries no SLA', () => {
    expect(slaView(makeClientTicket(1), NOW).state).toBe('none');
  });
});

describe('formatDuration', () => {
  it('uses at most two units, in the UI language', () => {
    expect(formatDuration(42 * 60_000, 'en')).toBe('42m');
    expect(formatDuration((2 * 60 + 10) * 60_000, 'en')).toBe('2h 10m');
    expect(formatDuration((28 * 60 + 5) * 60_000, 'en')).toBe('1d 4h');
    expect(formatDuration(10_000, 'en')).toBe('0m');
    expect(formatDuration(-5, 'en')).toBe('0m');
    expect(formatDuration(42 * 60_000, 'th')).not.toBe('42m');
  });
});

describe('slaView with the server SLA (T-111e)', () => {
  const server = (overrides: Partial<NonNullable<ReturnType<typeof makeTicket>['sla']>>) => ({
    target: 'resolution' as const,
    state: 'ok' as const,
    dueAt: at(600),
    calendar: 'business' as const,
    minutesLeft: 90,
    ...overrides,
  });

  it('takes the state and the minutes left from the server, not from wall-clock time', () => {
    // Wall clock says 10 hours left; the server counted 90 business minutes (the night is closed).
    const view = slaView(makeTicket(1, { createdAt: created, sla: server({}) }), NOW);
    expect(view).toMatchObject({ state: 'onTrack', target: 'resolution', ms: 90 * 60_000 });
    const atRisk = slaView(
      makeTicket(1, { createdAt: created, sla: server({ state: 'at_risk', minutesLeft: 20 }) }),
      NOW,
    );
    expect(atRisk).toMatchObject({ state: 'atRisk', ms: 20 * 60_000 });
  });

  it('breached counts the time past due on the wall clock, paused has no minutes', () => {
    const breached = slaView(
      makeTicket(1, { sla: server({ state: 'breached', dueAt: at(-12), minutesLeft: 0 }) }),
      NOW,
    );
    expect(breached).toMatchObject({ state: 'breached', ms: 12 * 60_000 });
    const paused = slaView(
      makeTicket(1, { sla: server({ state: 'paused', dueAt: at(60), minutesLeft: null }) }),
      NOW,
    );
    expect(paused).toMatchObject({ state: 'paused', ms: 60 * 60_000 });
  });

  it('maps the first response target', () => {
    const view = slaView(makeTicket(1, { sla: server({ target: 'first_response' }) }), NOW);
    expect(view.target).toBe('firstResponse');
  });
});
