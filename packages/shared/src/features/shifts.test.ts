import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SHIFT_DEFINITIONS,
  HANDOFF_REQUIRED_PRIORITIES,
  SHIFT_EARLY_CLOCK_IN_MINUTES,
  ackHandoffItemSchema,
  clockOutSchema,
  createShiftDefinitionSchema,
  createShiftNoteSchema,
  crossesMidnight,
  handoffBlockers,
  isGateOpen,
  itemRequiresAck,
  lateMinutes,
  pickRosterWindow,
  rosterQuerySchema,
  saveHandoffSchema,
  shiftWindow,
  updateShiftDefinitionSchema,
} from './shifts.js';

const BANGKOK = 'Asia/Bangkok';
const day = { startsAt: '08:00', endsAt: '17:00' };
const night = { startsAt: '22:00', endsAt: '08:00' };
const ID = '8f14e45f-ceea-4a7b-9d6a-1b1c2d3e4f50';
const OTHER = '8f14e45f-ceea-4a7b-9d6a-1b1c2d3e4f51';

describe('shiftWindow', () => {
  it('reads the wall clock in the zone it is given, not in the zone of the machine', () => {
    const window = shiftWindow(day, '2026-11-02', BANGKOK);
    expect(window.start.toISOString()).toBe('2026-11-02T01:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-11-02T10:00:00.000Z');
    // The same wall clock in New York (UTC-5 in November) is another instant.
    expect(shiftWindow(day, '2026-11-02', 'America/New_York').start.toISOString()).toBe(
      '2026-11-02T13:00:00.000Z',
    );
  });

  it('ends an overnight shift on the next local day', () => {
    const window = shiftWindow(night, '2026-11-02', BANGKOK);
    expect(window.start.toISOString()).toBe('2026-11-02T15:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-11-03T01:00:00.000Z');
    expect(crossesMidnight(night)).toBe(true);
    expect(crossesMidnight(day)).toBe(false);
  });

  it('follows a daylight saving change of the zone', () => {
    // New York leaves daylight saving time on 2026-11-01: 22:00 that evening is UTC-5, not UTC-4.
    const window = shiftWindow(night, '2026-11-01', 'America/New_York');
    expect(window.start.toISOString()).toBe('2026-11-02T03:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-11-02T13:00:00.000Z');
  });

  it('gives the starter shifts of owner decision po #7', () => {
    expect(
      DEFAULT_SHIFT_DEFINITIONS.map((s) => `${s.startsAt}-${s.endsAt}:${String(s.onCall)}`),
    ).toEqual(['08:00-17:00:false', '13:00-22:00:false', '22:00-08:00:true']);
  });
});

describe('pickRosterWindow', () => {
  const at = (iso: string) => new Date(iso);
  const entries = [
    { id: 'day', window: shiftWindow(day, '2026-11-02', BANGKOK) },
    {
      id: 'evening',
      window: shiftWindow({ startsAt: '13:00', endsAt: '22:00' }, '2026-11-02', BANGKOK),
    },
  ];

  it('picks the running shift', () => {
    expect(pickRosterWindow(entries, at('2026-11-02T03:00:00Z'))?.id).toBe('day'); // 10:00 local
  });

  it('accepts an early clock in, up to the early limit', () => {
    expect(pickRosterWindow(entries, at('2026-11-02T00:30:00Z'))?.id).toBe('day'); // 07:30 local
    const tooEarly = new Date(
      entries[0]!.window.start.getTime() - (SHIFT_EARLY_CLOCK_IN_MINUTES + 1) * 60_000,
    );
    expect(pickRosterWindow(entries, tooEarly)).toBeNull();
  });

  it('chooses the shift that started closest when two overlap', () => {
    expect(pickRosterWindow(entries, at('2026-11-02T06:30:00Z'))?.id).toBe('evening'); // 13:30 local
    expect(pickRosterWindow(entries, at('2026-11-02T04:00:00Z'))?.id).toBe('day'); // 11:00 local
  });

  it('finds nothing after the end, or with an empty roster', () => {
    expect(pickRosterWindow(entries, at('2026-11-02T16:00:00Z'))).toBeNull();
    expect(pickRosterWindow([], at('2026-11-02T03:00:00Z'))).toBeNull();
  });
});

describe('lateMinutes', () => {
  const start = new Date('2026-11-02T01:00:00Z');
  it('counts whole minutes after the scheduled start', () => {
    expect(lateMinutes(start, new Date('2026-11-02T01:12:59Z'))).toBe(12);
  });
  it('is 0 when early, on time, or off the roster', () => {
    expect(lateMinutes(start, new Date('2026-11-02T00:50:00Z'))).toBe(0);
    expect(lateMinutes(start, start)).toBe(0);
    expect(lateMinutes(null, start)).toBe(0);
  });
});

describe('handoffBlockers (the AC-7 gate)', () => {
  const p1 = { id: ID, key: 'OPS-1', priority: 'P1' as const };
  const p2 = { id: OTHER, key: 'OPS-2', priority: 'P2' as const };

  it('blocks an open P1 ticket that is not in the handoff', () => {
    expect(handoffBlockers([p1], [])).toEqual([
      { ticketId: ID, key: 'OPS-1', priority: 'P1', reason: 'not_listed' },
    ]);
  });

  it('blocks a listed one without a next action, blank counting as none', () => {
    for (const nextAction of [null, '', '   ']) {
      expect(handoffBlockers([p1], [{ kind: 'pending', ticketId: ID, nextAction }])).toEqual([
        { ticketId: ID, key: 'OPS-1', priority: 'P1', reason: 'missing_next_action' },
      ]);
    }
  });

  it('opens when every P1 and P2 ticket is listed with a next action', () => {
    const items = [
      { kind: 'pending', ticketId: ID, nextAction: 'Wait for logs' },
      { kind: 'pending', ticketId: OTHER, nextAction: 'Call back' },
    ];
    expect(handoffBlockers([p1, p2], items)).toEqual([]);
  });

  it('only a pending item counts, not a note that names the same ticket', () => {
    expect(handoffBlockers([p1], [{ kind: 'note', ticketId: ID, nextAction: 'x' }])).toHaveLength(
      1,
    );
  });

  it('ignores priorities that need no entry', () => {
    expect(HANDOFF_REQUIRED_PRIORITIES).toEqual(['P1', 'P2']);
    expect(handoffBlockers([{ id: ID, key: 'OPS-9', priority: 'P3' }], [])).toEqual([]);
  });

  it('reports the gate as open only when confirmed and without blockers', () => {
    expect(isGateOpen({ noConfirmedHandoff: false, blockers: [] })).toBe(true);
    expect(isGateOpen({ noConfirmedHandoff: true, blockers: [] })).toBe(false);
    expect(isGateOpen({ noConfirmedHandoff: false, blockers: [{}] })).toBe(false);
  });
});

describe('contracts', () => {
  it('a shift cannot start and end at the same minute, and times are HH:mm', () => {
    const base = { name: 'X', startsAt: '08:00', endsAt: '08:00' };
    expect(createShiftDefinitionSchema.safeParse(base).success).toBe(false);
    expect(createShiftDefinitionSchema.safeParse({ ...base, endsAt: '24:00' }).success).toBe(false);
    expect(createShiftDefinitionSchema.safeParse({ ...base, endsAt: '17:00' }).success).toBe(true);
    expect(updateShiftDefinitionSchema.safeParse({}).success).toBe(false);
  });

  it('a clock out override needs a real reason', () => {
    expect(clockOutSchema.safeParse({ override: { reason: 'short' } }).success).toBe(false);
    expect(
      clockOutSchema.safeParse({ override: { reason: 'Left sick, covered by lead' } }).success,
    ).toBe(true);
    expect(clockOutSchema.safeParse({}).success).toBe(true);
  });

  it('a roster query is at most 62 days and in order', () => {
    expect(rosterQuerySchema.safeParse({ from: '2026-11-01', to: '2026-12-31' }).success).toBe(
      true,
    );
    expect(rosterQuerySchema.safeParse({ from: '2026-11-01', to: '2027-01-31' }).success).toBe(
      false,
    );
    expect(rosterQuerySchema.safeParse({ from: '2026-11-05', to: '2026-11-01' }).success).toBe(
      false,
    );
    expect(rosterQuerySchema.safeParse({ from: '2026-13-01', to: '2026-13-02' }).success).toBe(
      false,
    );
  });

  it('a note names its audience properly', () => {
    expect(createShiftNoteSchema.safeParse({ audience: 'next_shift', body: 'hi' }).success).toBe(
      true,
    );
    expect(createShiftNoteSchema.safeParse({ audience: 'person', body: 'hi' }).success).toBe(false);
    expect(
      createShiftNoteSchema.safeParse({ audience: 'person', toUserId: ID, body: 'hi' }).success,
    ).toBe(true);
    expect(createShiftNoteSchema.safeParse({ audience: 'datetime', body: 'hi' }).success).toBe(
      false,
    );
    expect(
      createShiftNoteSchema.safeParse({ audience: 'next_shift', toUserId: ID, body: 'hi' }).success,
    ).toBe(false);
    expect(createShiftNoteSchema.safeParse({ audience: 'next_shift', body: '   ' }).success).toBe(
      false,
    );
  });

  it('an acknowledgment needs what its decision needs', () => {
    expect(ackHandoffItemSchema.safeParse({ decision: 'accept' }).success).toBe(true);
    expect(ackHandoffItemSchema.safeParse({ decision: 'reassign' }).success).toBe(false);
    expect(ackHandoffItemSchema.safeParse({ decision: 'reassign', assigneeId: ID }).success).toBe(
      true,
    );
    expect(ackHandoffItemSchema.safeParse({ decision: 'question' }).success).toBe(false);
    expect(
      ackHandoffItemSchema.safeParse({ decision: 'question', note: 'Which log?' }).success,
    ).toBe(true);
  });

  it('a new pending item needs a ticket and nothing else does', () => {
    const save = (item: Record<string, unknown>) =>
      saveHandoffSchema.safeParse({ items: [item] }).success;
    expect(save({ kind: 'pending', title: 'x' })).toBe(false);
    expect(save({ kind: 'pending', title: 'x', ticketId: ID })).toBe(true);
    expect(save({ kind: 'pending', id: OTHER, title: 'x' })).toBe(true);
    expect(save({ kind: 'watch', title: 'x', ticketId: ID })).toBe(false);
    expect(save({ kind: 'watch', title: 'Go-live tonight' })).toBe(true);
  });

  it('only a pending ticket and an incident need an acknowledgment', () => {
    expect(
      (['pending', 'incident', 'deploy', 'alert', 'watch', 'note'] as const).filter(
        itemRequiresAck,
      ),
    ).toEqual(['pending', 'incident']);
  });
});
