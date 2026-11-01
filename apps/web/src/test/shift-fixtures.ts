import type {
  Assignee,
  CurrentHandoff,
  Handoff,
  HandoffBlocker,
  HandoffItem,
  IncomingHandoffs,
  RosterEntry,
  ShiftBrief,
  ShiftDefinition,
  ShiftNote,
  ShiftOverview,
  ShiftSession,
  ShiftStatus,
} from '@watchtower/shared';

import { uuid } from './fixtures';

/** Shift fixtures: invented names and example.com only (N1). Shared by the unit tests and the e2e mock. */
export const SHIFT_TZ = 'Asia/Bangkok';
/** 10:00 in Bangkok. */
export const SHIFT_NOW = '2026-11-02T03:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(SHIFT_NOW) + minutes * 60_000).toISOString();

export const WHO = {
  /** The signed-in user of `makeSession` (uuid 900). */
  me: { id: uuid(900), name: 'Alex Agent' },
  mana: { id: uuid(910), name: 'Mana K.' },
  pim: { id: uuid(911), name: 'Pim S.' },
  dao: { id: uuid(912), name: 'Dao N.' },
} as const;

export const DAY_SHIFT_ID = uuid(2100);
export const NIGHT_SHIFT_ID = uuid(2101);

export function shiftSession(overrides: Partial<ShiftSession> = {}): ShiftSession {
  return {
    id: uuid(2000),
    userId: WHO.me.id,
    userName: WHO.me.name,
    shiftId: DAY_SHIFT_ID,
    shiftName: 'Day',
    rosterEntryId: uuid(2200),
    onRoster: true,
    scheduledStart: at(-120),
    scheduledEnd: at(420),
    clockedInAt: at(-118),
    lateMinutes: 0,
    late: false,
    device: 'Firefox on Windows',
    locationConsent: false,
    clockedOutAt: null,
    override: null,
    briefReadAt: null,
    ...overrides,
  };
}

export function rosterEntry(n: number, overrides: Partial<RosterEntry> = {}): RosterEntry {
  return {
    id: uuid(2200 + n),
    shiftId: DAY_SHIFT_ID,
    shiftName: 'Day',
    onCall: false,
    userId: WHO.me.id,
    userName: WHO.me.name,
    workDate: '2026-11-02',
    startsAt: at(-120),
    endsAt: at(420),
    ...overrides,
  };
}

export function blocker(n: number, overrides: Partial<HandoffBlocker> = {}): HandoffBlocker {
  return {
    ticketId: uuid(3000 + n),
    key: `OPS-${String(100 + n)}`,
    priority: 'P1',
    reason: 'missing_next_action',
    ...overrides,
  };
}

export function shiftStatus(overrides: Partial<ShiftStatus> = {}): ShiftStatus {
  return {
    timezone: SHIFT_TZ,
    now: SHIFT_NOW,
    session: shiftSession(),
    roster: [rosterEntry(0)],
    minutesToEnd: 420,
    handoff: null,
    clockOutBlocked: null,
    unreadNotes: 0,
    pendingAcks: 0,
    ...overrides,
  };
}

export function offShiftStatus(overrides: Partial<ShiftStatus> = {}): ShiftStatus {
  return shiftStatus({ session: null, minutesToEnd: null, ...overrides });
}

export function ticketFor(n: number, priority: 'P1' | 'P2' | 'P3' | 'P4' = 'P1') {
  return {
    id: uuid(3000 + n),
    key: `OPS-${String(100 + n)}`,
    subject: `Subject of OPS-${String(100 + n)}`,
    priority,
    status: 'open',
    assignee: { id: WHO.mana.id, name: WHO.mana.name },
    slaState: 'ok' as const,
  };
}

export function handoffItem(n: number, overrides: Partial<HandoffItem> = {}): HandoffItem {
  return {
    id: uuid(3500 + n),
    kind: 'pending',
    ticket: ticketFor(n),
    title: `OPS-${String(100 + n)} Subject of OPS-${String(100 + n)}`,
    nextAction: null,
    dueAt: null,
    severity: null,
    source: 'prefill',
    edited: false,
    requiresAck: true,
    carriedShifts: 0,
    ackStatus: 'pending',
    ackBy: null,
    ackAt: null,
    ackNote: null,
    ...overrides,
  };
}

/** A pending item for a P3 ticket: not required at the gate. */
export function p3Item(n: number, overrides: Partial<HandoffItem> = {}): HandoffItem {
  return handoffItem(n, { ticket: ticketFor(n, 'P3'), ...overrides });
}

/** The element at `index`, or a clear failure: tests index into rendered lists a lot. */
export function nth<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`nothing at index ${String(index)}`);
  return value;
}

export function handoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    id: uuid(3900),
    sessionId: uuid(2000),
    status: 'draft',
    shiftName: 'Day',
    scheduledStart: at(-120),
    scheduledEnd: at(420),
    from: WHO.me,
    to: null,
    items: [],
    notes: '',
    messageForNext: '',
    confirmedAt: null,
    createdAt: at(-60),
    updatedAt: at(-30),
    ...overrides,
  };
}

export function currentHandoff(overrides: Partial<CurrentHandoff> = {}): CurrentHandoff {
  return {
    handoff: handoff(),
    gate: { noConfirmedHandoff: true, blockers: [] },
    incomingCandidates: [
      { userId: WHO.pim.id, name: WHO.pim.name, shiftName: 'Evening', startsAt: at(120) },
    ],
    ...overrides,
  };
}

export function incomingHandoffs(items: HandoffItem[], overrides: Partial<IncomingHandoffs> = {}) {
  const needing = items.filter((item) => item.requiresAck);
  const done = needing.filter((item) => item.ackStatus !== 'pending').length;
  const result: IncomingHandoffs = {
    handoffs: [
      {
        id: uuid(3901),
        from: WHO.mana,
        shiftName: 'Evening',
        confirmedAt: at(-20),
        notes: 'Quiet night apart from the export job.',
        messageForNext: 'Please watch the export job.',
        items,
      },
    ],
    total: needing.length,
    acknowledged: done,
    leadAlertAt: at(10),
    ...overrides,
  };
  return result;
}

export function emptyIncoming(): IncomingHandoffs {
  return { handoffs: [], total: 0, acknowledged: 0, leadAlertAt: null };
}

export function shiftBrief(overrides: Partial<ShiftBrief> = {}): ShiftBrief {
  return {
    generatedAt: at(-1),
    timezone: SHIFT_TZ,
    session: shiftSession(),
    handoff: emptyIncoming(),
    incidents: [],
    snoozedAlerts: [],
    deploys: [],
    watchItems: [],
    myTickets: [],
    carriedOver: [],
    notes: [],
    aiSummary: null,
    ...overrides,
  };
}

export function shiftNote(n: number, overrides: Partial<ShiftNote> = {}): ShiftNote {
  return {
    id: uuid(4000 + n),
    audience: 'next_shift',
    author: WHO.mana,
    toUser: null,
    deliverAt: null,
    body: `Note number ${String(n)}`,
    createdAt: at(-90),
    readAt: null,
    ...overrides,
  };
}

export function shiftOverview(overrides: Partial<ShiftOverview> = {}): ShiftOverview {
  return {
    timezone: SHIFT_TZ,
    generatedAt: SHIFT_NOW,
    onShift: [],
    noShows: [],
    unacknowledged: { count: 0, overdue: 0, items: [] },
    openQuestions: 0,
    questions: { overdue: 0, items: [] },
    ...overrides,
  };
}

export function assignee(
  who: { id: string; name: string },
  overrides: Partial<Assignee> = {},
): Assignee {
  return { ...who, role: 'agent', onShift: true, openTickets: 2, inQueue: false, ...overrides };
}

export function shiftDefinition(
  n: number,
  overrides: Partial<ShiftDefinition> = {},
): ShiftDefinition {
  return {
    id: uuid(2100 + n),
    name: n === 0 ? 'Day' : 'On-call night',
    startsAt: n === 0 ? '08:00' : '22:00',
    endsAt: n === 0 ? '17:00' : '08:00',
    overnight: n !== 0,
    onCall: n !== 0,
    active: true,
    createdAt: at(-1000),
    updatedAt: at(-1000),
    ...overrides,
  };
}
