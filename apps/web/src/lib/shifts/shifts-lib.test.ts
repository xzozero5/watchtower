import { describe, expect, it } from 'vitest';

import { translate } from '@/i18n';
import { en } from '@/i18n/messages/en';
import { ApiRequestError, errorFromResponse } from '@/lib/api/errors';
import {
  ackProgress,
  addDays,
  canTakeItem,
  carriedLevel,
  chipLabel,
  chipState,
  dateKeyInZone,
  describeShiftError,
  deviceName,
  draftFromHandoff,
  draftIssues,
  draftItemForBlocker,
  gateFromError,
  gateSentence,
  gateSummary,
  isoToLocalInput,
  itemsToAnswer,
  localInputToIso,
  minutesToClock,
  missingFromDraft,
  mustGoToOnShift,
  nextActionFieldId,
  sameDraft,
  timeInZone,
  toSaveBody,
  weekStart,
} from '@/lib/shifts/model';
import {
  assignee,
  blocker,
  handoff,
  handoffItem,
  nth,
  offShiftStatus,
  p3Item,
  shiftSession,
  shiftStatus,
  ticketFor,
  WHO,
} from '@/test/shift-fixtures';

const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate(en, key, values);

describe('shift chip (spec 9.1)', () => {
  it('off shift says how to clock in', () => {
    const label = chipLabel(offShiftStatus(), t, 'en');
    expect(label).toEqual({
      text: 'Off shift — Clock in',
      short: 'Off shift',
      warning: false,
      state: 'off',
    });
  });

  it('on shift shows the range in the shift zone and the time left', () => {
    // Day shift 08:00 to 17:00 Bangkok = 01:00 to 10:00 UTC; now 03:00 UTC, 7 hours left.
    const status = shiftStatus({
      session: shiftSession({
        scheduledStart: '2026-11-02T01:00:00.000Z',
        scheduledEnd: '2026-11-02T10:00:00.000Z',
      }),
      minutesToEnd: 192,
    });
    const label = chipLabel(status, t, 'en');
    expect(label.text).toBe('On shift · 08:00–17:00 · 3h 12m left');
    expect(label.warning).toBe(false);
  });

  it('late adds a warning with words, not only colour', () => {
    const status = shiftStatus({
      session: shiftSession({ late: true, lateMinutes: 12 }),
      minutesToEnd: 120,
    });
    const label = chipLabel(status, t, 'en');
    expect(label.text).toContain('Late 12m');
    expect(label.warning).toBe(true);
  });

  it('past the end it asks for the handoff', () => {
    const status = shiftStatus({ minutesToEnd: -10 });
    expect(chipState(status)).toEqual({ kind: 'ended', minutesOver: 10 });
    expect(chipLabel(status, t, 'en')).toMatchObject({
      text: 'Shift ended 10m ago — finish handoff',
      warning: true,
    });
  });

  it('a clock in without a roster entry has no end to count down to', () => {
    const status = shiftStatus({
      session: shiftSession({
        onRoster: false,
        shiftName: null,
        scheduledStart: null,
        scheduledEnd: null,
      }),
      minutesToEnd: null,
    });
    expect(chipLabel(status, t, 'en').text).toBe('On shift · Not on the roster');
  });

  it('formats clocks and zoned times', () => {
    expect(minutesToClock(192)).toBe('3h 12m');
    expect(minutesToClock(7)).toBe('7m');
    expect(minutesToClock(-5)).toBe('0m');
    expect(timeInZone('2026-11-02T01:00:00.000Z', 'Asia/Bangkok', 'en')).toBe('08:00');
  });
});

describe('the AC-7 gate in the browser', () => {
  const body = {
    statusCode: 409,
    error: 'Conflict',
    code: 'handoff_incomplete',
    message: 'handoff_incomplete',
    noConfirmedHandoff: false,
    blockers: [blocker(1, { cause: 'moved_away' }), blocker(2, { reason: 'not_listed' })],
  };

  it('reads the 409 body, including cause', () => {
    const error = new ApiRequestError(409, 'handoff_incomplete', 'x', body);
    const gate = gateFromError(error);
    expect(gate?.blockers).toHaveLength(2);
    expect(gate?.blockers[0]?.cause).toBe('moved_away');
  });

  it('keeps the body of a real 409 answer so the blockers survive the client', async () => {
    const error = await errorFromResponse(new Response(JSON.stringify(body), { status: 409 }));
    expect(error.code).toBe('handoff_incomplete');
    expect(gateFromError(error)?.blockers.map((item) => item.key)).toEqual(['OPS-101', 'OPS-102']);
  });

  it('ignores any other failure and a body that does not match the contract', () => {
    expect(gateFromError(new ApiRequestError(409, 'handoff_locked', 'x', body))).toBeNull();
    expect(gateFromError(new ApiRequestError(500, 'handoff_incomplete', 'x', body))).toBeNull();
    expect(
      gateFromError(new ApiRequestError(409, 'handoff_incomplete', 'x', { nope: 1 })),
    ).toBeNull();
    expect(gateFromError(new Error('x'))).toBeNull();
  });

  it('says why clock out is disabled', () => {
    expect(gateSentence({ noConfirmedHandoff: false, blockers: [blocker(1), blocker(2)] }, t)).toBe(
      'Finish the handoff first: 2 items need a next action',
    );
    expect(gateSentence({ noConfirmedHandoff: false, blockers: [blocker(1)] }, t)).toBe(
      'Finish the handoff first: 1 item needs a next action',
    );
    expect(gateSentence({ noConfirmedHandoff: true, blockers: [] }, t)).toBe(
      'Confirm the handoff first',
    );
    expect(gateSentence({ noConfirmedHandoff: false, blockers: [] }, t)).toBeNull();
    expect(gateSummary({ noConfirmedHandoff: false, blockers: [] }).open).toBe(true);
  });

  it('explains a refusal in plain words', () => {
    const error = new ApiRequestError(409, 'handoff_incomplete', 'handoff_incomplete', body);
    expect(describeShiftError(error, t).message).toBe('The handoff is not complete yet.');
    expect(describeShiftError(new ApiRequestError(403, 'forbidden', 'x'), t).kind).toBe(
      'forbidden',
    );
  });
});

describe('handoff draft', () => {
  const pending = handoffItem(1, {
    nextAction: 'Wait for the log file',
    dueAt: '2026-11-02T09:00:00.000Z',
  });
  const bare = handoffItem(2);

  it('is made from the handoff and sent back as the whole list', () => {
    const draft = draftFromHandoff(
      handoff({ items: [pending, bare], notes: 'N', messageForNext: 'M' }),
    );
    expect(draft.items).toHaveLength(2);
    expect(draft.items[0]).toMatchObject({ id: pending.id, nextAction: 'Wait for the log file' });
    const body = toSaveBody(draft);
    expect(body.items[0]).toMatchObject({
      id: pending.id,
      kind: 'pending',
      nextAction: 'Wait for the log file',
      dueAt: '2026-11-02T09:00:00.000Z',
    });
    // The api takes `ticketId` only for a new item, and an empty next action is null.
    expect(body.items[0]).not.toHaveProperty('ticketId');
    expect(body.items[1]?.nextAction).toBeNull();
    expect(body.notes).toBe('N');
  });

  it('sends ticketId for an item added from a blocker', () => {
    const item = draftItemForBlocker(blocker(7, { reason: 'not_listed', cause: 'downgraded' }));
    const body = toSaveBody({ toUserId: null, notes: '', messageForNext: '', items: [item] });
    expect(body.items[0]).toMatchObject({
      kind: 'pending',
      ticketId: blocker(7).ticketId,
      title: 'OPS-107',
    });
  });

  it('finds P1 and P2 tickets without a next action, and not P3', () => {
    const p3 = p3Item(3);
    const draft = draftFromHandoff(handoff({ items: [pending, bare, p3] }));
    const issues = draftIssues(draft);
    expect(issues.map((issue) => issue.ticketKey)).toEqual(['OPS-102']);
    expect(issues[0]?.fieldId).toBe(nextActionFieldId(ticketFor(2).id));
    // Whitespace is not a next action.
    nth(draft.items, 1).nextAction = '   ';
    expect(draftIssues(draft)).toHaveLength(1);
    nth(draft.items, 1).nextAction = 'Call the customer';
    expect(draftIssues(draft)).toHaveLength(0);
  });

  it('lists tickets the gate wants that are not in the draft at all', () => {
    const draft = draftFromHandoff(handoff({ items: [pending] }));
    const wanted = [blocker(1), blocker(5, { reason: 'not_listed' })];
    expect(missingFromDraft(draft, wanted).map((b) => b.key)).toEqual(['OPS-105']);
  });

  it('compares drafts and converts local date inputs both ways', () => {
    const a = draftFromHandoff(handoff({ items: [pending] }));
    const b = draftFromHandoff(handoff({ items: [pending] }));
    expect(sameDraft(a, b)).toBe(true);
    b.notes = 'changed';
    expect(sameDraft(a, b)).toBe(false);
    const iso = '2026-11-02T09:30:00.000Z';
    expect(localInputToIso(isoToLocalInput(iso))).toBe(iso);
    expect(localInputToIso('')).toBeNull();
    expect(isoToLocalInput(null)).toBe('');
  });
});

describe('acknowledgment', () => {
  it('counts progress and finishes at the total', () => {
    expect(ackProgress(7, 3)).toEqual({ total: 7, acknowledged: 3, remaining: 4, done: false });
    expect(ackProgress(2, 2).done).toBe(true);
    expect(ackProgress(0, 0).done).toBe(false);
  });

  it('only items that need an answer and have none are to answer', () => {
    const items = [
      handoffItem(1),
      handoffItem(2, { ackStatus: 'accepted' }),
      handoffItem(3, { requiresAck: false, kind: 'watch' }),
    ];
    expect(itemsToAnswer(items).map((item) => item.id)).toEqual([nth(items, 0).id]);
  });

  it('keeps a P1 or P2 ticket away from people who are off shift', () => {
    const p1 = handoffItem(1);
    const p3 = p3Item(2);
    const off = assignee(WHO.dao, { onShift: false });
    expect(mustGoToOnShift(p1)).toBe(true);
    expect(canTakeItem(off, p1)).toBe(false);
    expect(canTakeItem(off, p3)).toBe(true);
    expect(canTakeItem(assignee(WHO.pim), p1)).toBe(true);
  });

  it('shows a warning from the third shift (spec 9.4)', () => {
    expect(carriedLevel(0)).toBe('none');
    expect(carriedLevel(2)).toBe('carried');
    expect(carriedLevel(3)).toBe('warning');
  });
});

describe('small helpers', () => {
  it('names the device from the user agent', () => {
    expect(
      deviceName(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
      ),
    ).toBe('Firefox on Windows');
    expect(
      deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit Safari/605.1'),
    ).toBe('Safari on macOS');
    expect(deviceName('')).toBe('Browser');
  });

  it('works out the roster week in the shift zone', () => {
    // 2026-11-02 is a Monday.
    expect(weekStart('2026-11-02')).toBe('2026-11-02');
    expect(weekStart('2026-11-08')).toBe('2026-11-02');
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    // 20:00 UTC on the 1st is already the 2nd in Bangkok.
    expect(dateKeyInZone(new Date('2026-11-01T20:00:00.000Z'), 'Asia/Bangkok')).toBe('2026-11-02');
  });
});
