/**
 * Shifts and handoff (T-111): this feature's own audit actions, ticket event types and queue names (T-123a),
 * and the HTTP contract of the shift, roster, handoff, note and brief endpoints (PRD R-7.1, R-7.3 to R-7.7, AC-7).
 *
 * Time zone: a shift is a wall-clock window ("08:00 to 17:00"). Which zone that wall clock is in is
 * the zone of the default business calendar (`business_calendar.timezone`), never the zone of the
 * server's clock. The functions below take the zone as an argument for that reason.
 *
 * The global `AUDIT_ACTIONS`, `TICKET_EVENT_TYPES` and `QUEUE_NAMES` are composed from these records
 * (see `./index.ts`), and importing `@watchtower/shared` throws if two features use the same key
 * or the same value.
 */
import { z } from 'zod';

import { attachmentIdsSchema, staffAttachmentSchema } from '../uploads.js';
import { cursorSchema, pageLimit } from '../common.js';
import {
  addDaysToDateKey,
  minutesOfDay,
  slaStateSchema,
  ticketPrioritySchema,
  zonedWallClockToUtc,
} from '../sla.js';

/** Audit `action` strings written by this feature. */
export const SHIFTS_AUDIT_ACTIONS = {
  shiftDefinitionCreate: 'shift.definition_create',
  shiftDefinitionUpdate: 'shift.definition_update',
  rosterAssign: 'roster.assign',
  rosterRemove: 'roster.remove',
  shiftClockIn: 'shift.clock_in',
  shiftClockOut: 'shift.clock_out',
  /** A lead or head clocked someone out although the handoff was incomplete (reason required). */
  shiftClockOutOverride: 'shift.clock_out_override',
  shiftBriefRead: 'shift.brief_read',
  handoffPrefill: 'handoff.prefill',
  handoffSave: 'handoff.save',
  handoffConfirm: 'handoff.confirm',
  handoffReopen: 'handoff.reopen',
  /** The incoming person accepted, reassigned or questioned one item of a handoff. */
  handoffItemAck: 'handoff.item_ack',
  shiftNoteCreate: 'shift.note_create',
  shiftNoteRead: 'shift.note_read',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const SHIFTS_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: api, consumer: worker). */
export const SHIFTS_QUEUES = {} as const satisfies Record<string, string>;

// --- rules (every value here is `[ASSUMED]` unless the PRD fixes it; `po` confirms) ---

/** The default shifts of owner decision po #7: 08-17, 13-22 and an on-call 22-08 (local time, editable). */
export const DEFAULT_SHIFT_DEFINITIONS = [
  { name: 'Day', startsAt: '08:00', endsAt: '17:00', onCall: false },
  { name: 'Evening', startsAt: '13:00', endsAt: '22:00', onCall: false },
  { name: 'On-call night', startsAt: '22:00', endsAt: '08:00', onCall: true },
] as const;

/** Clock in is accepted this long before a rostered shift starts. */
export const SHIFT_EARLY_CLOCK_IN_MINUTES = 60;
/** A clock in later than this many minutes after the start is "late" (R-7.3). */
export const SHIFT_LATE_GRACE_MINUTES = 5;
/** A session still open after this long no longer counts as "on shift" for assignment (a forgotten clock out). */
export const SHIFT_SESSION_MAX_HOURS = 16;
/** A confirmed handoff is offered to the incoming shift for this long. */
export const HANDOFF_VISIBLE_HOURS = 36;
/** Open assigned tickets of these priorities must be listed with a next action before clock out (AC-7 is P1; P2 is `[ASSUMED]`). */
export const HANDOFF_REQUIRED_PRIORITIES = ['P1', 'P2'] as const;
/** Items nobody acknowledged this long after the handoff was confirmed are flagged to the lead (R-7.6). */
export const HANDOFF_ACK_ALERT_MINUTES = 30;
/** A note to "next shift" stays visible this long. */
export const NOTE_NEXT_SHIFT_TTL_HOURS = 48;
/** UI spec 9.4: an item that crossed this many shifts is shown as a warning. */
export const HANDOFF_CARRIED_WARNING = 3;

// --- pure time rules ---

const timeOfDaySchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');
/** `2026-02-31` has the right shape and is not a day: Postgres would refuse it with a 500. */
function isRealDate(value: string): boolean {
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/, 'expected YYYY-MM-DD')
  .refine(isRealDate, 'not a date on the calendar');

export interface ShiftWindow {
  readonly start: Date;
  readonly end: Date;
}

/**
 * The instants a shift runs on `workDate` (the local date it starts), in `timezone`. A shift whose
 * end is not after its start crosses midnight and ends the next local day (22:00 to 08:00).
 */
export function shiftWindow(
  definition: { readonly startsAt: string; readonly endsAt: string },
  workDate: string,
  timezone: string,
): ShiftWindow {
  const from = minutesOfDay(definition.startsAt);
  const to = minutesOfDay(definition.endsAt);
  return {
    start: zonedWallClockToUtc(workDate, from, timezone),
    end: zonedWallClockToUtc(to > from ? workDate : addDaysToDateKey(workDate, 1), to, timezone),
  };
}

export function crossesMidnight(definition: { startsAt: string; endsAt: string }): boolean {
  return minutesOfDay(definition.endsAt) <= minutesOfDay(definition.startsAt);
}

/**
 * Which of a person's rostered windows a clock in at `now` belongs to: the one that is running, or
 * starts within `earlyMinutes`; with two candidates, the one that started closest to `now`.
 */
export function pickRosterWindow<T extends { readonly window: ShiftWindow }>(
  candidates: readonly T[],
  now: Date,
  earlyMinutes: number = SHIFT_EARLY_CLOCK_IN_MINUTES,
): T | null {
  const at = now.getTime();
  const early = earlyMinutes * 60_000;
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const start = candidate.window.start.getTime();
    if (at < start - early || at >= candidate.window.end.getTime()) continue;
    const distance = Math.abs(at - start);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Whole minutes `clockedInAt` is after `scheduledStart`; 0 when on time or early. */
export function lateMinutes(scheduledStart: Date | null, clockedInAt: Date): number {
  if (scheduledStart === null) return 0;
  return Math.max(0, Math.floor((clockedInAt.getTime() - scheduledStart.getTime()) / 60_000));
}

// --- the AC-7 gate (pure) ---

export const HANDOFF_BLOCKER_REASONS = ['not_listed', 'missing_next_action'] as const;
export type HandoffBlockerReason = (typeof HANDOFF_BLOCKER_REASONS)[number];

/**
 * Why a ticket is on the gate although it is no longer a plain "open P1/P2 assigned to me": the
 * person unassigned it, handed it to someone who is not on shift, or lowered its priority during
 * this shift (the AC-7 bypass). Absent for an ordinary assigned ticket.
 */
export const HANDOFF_BLOCKER_CAUSES = ['moved_away', 'downgraded'] as const;
export type HandoffBlockerCause = (typeof HANDOFF_BLOCKER_CAUSES)[number];

export const handoffBlockerSchema = z.object({
  ticketId: z.uuid(),
  key: z.string(),
  priority: ticketPrioritySchema,
  reason: z.enum(HANDOFF_BLOCKER_REASONS),
  cause: z.enum(HANDOFF_BLOCKER_CAUSES).optional(),
});
export type HandoffBlocker = z.infer<typeof handoffBlockerSchema>;

export function isHandoffRequiredPriority(priority: string): boolean {
  return (HANDOFF_REQUIRED_PRIORITIES as readonly string[]).includes(priority);
}

/**
 * AC-7: every open ticket assigned to the person at P1 (and P2) needs a pending item in the handoff
 * with a next action. Returns what is missing, in the order of `required`; empty means the gate opens.
 */
export function handoffBlockers(
  required: readonly {
    id: string;
    key: string;
    priority: z.infer<typeof ticketPrioritySchema>;
    cause?: HandoffBlockerCause;
  }[],
  items: readonly { kind: string; ticketId: string | null; nextAction: string | null }[],
): HandoffBlocker[] {
  const blockers: HandoffBlocker[] = [];
  for (const ticket of required) {
    if (!isHandoffRequiredPriority(ticket.priority)) continue;
    const item = items.find((entry) => entry.kind === 'pending' && entry.ticketId === ticket.id);
    const base = {
      ticketId: ticket.id,
      key: ticket.key,
      priority: ticket.priority,
      ...(ticket.cause === undefined ? {} : { cause: ticket.cause }),
    };
    if (item === undefined) blockers.push({ ...base, reason: 'not_listed' });
    else if (item.nextAction === null || item.nextAction.trim() === '') {
      blockers.push({ ...base, reason: 'missing_next_action' });
    }
  }
  return blockers;
}

/** What the person themself did to a ticket during the shift that may take it off their plate. */
export interface OwnTicketChange {
  readonly ticketId: string;
  readonly kind: HandoffBlockerCause;
  /** For `downgraded`: the priority it had before the first downgrade of the shift. */
  readonly fromPriority: z.infer<typeof ticketPrioritySchema> | null;
}

/**
 * Tickets that still count at the gate although the person changed them (the AC-7 bypass): a ticket
 * that is open, was unassigned or handed away by the person (`moved_away`) or had its priority
 * lowered by them (`downgraded`) during the shift, and is now with nobody, with the person, or with
 * someone who is off shift. A ticket handed to a colleague who is on shift is that colleague's.
 * Returns the ticket at the priority that made it required (its current one, else the one it was
 * lowered from); a ticket that never was P1/P2 is not returned.
 */
export function departedRequirements(input: {
  readonly userId: string;
  readonly tickets: readonly {
    id: string;
    key: string;
    priority: z.infer<typeof ticketPrioritySchema>;
    open: boolean;
    assigneeId: string | null;
    assigneeOnShift: boolean;
  }[];
  readonly changes: readonly OwnTicketChange[];
}): {
  id: string;
  key: string;
  priority: z.infer<typeof ticketPrioritySchema>;
  cause: HandoffBlockerCause;
}[] {
  const out: {
    id: string;
    key: string;
    priority: z.infer<typeof ticketPrioritySchema>;
    cause: HandoffBlockerCause;
  }[] = [];
  for (const ticket of input.tickets) {
    if (!ticket.open) continue;
    const mine = input.changes.filter((change) => change.ticketId === ticket.id);
    if (mine.length === 0) continue;
    const unattended =
      ticket.assigneeId === null || ticket.assigneeId === input.userId || !ticket.assigneeOnShift;
    if (!unattended) continue;
    const downgrade = mine.find((change) => change.kind === 'downgraded');
    const moved = mine.find((change) => change.kind === 'moved_away');
    // Held by the person again and still P1/P2: the ordinary rule already covers it.
    if (ticket.assigneeId === input.userId && downgrade === undefined) continue;
    const priority = isHandoffRequiredPriority(ticket.priority)
      ? ticket.priority
      : (downgrade?.fromPriority ?? null);
    if (priority === null || !isHandoffRequiredPriority(priority)) continue;
    out.push({
      id: ticket.id,
      key: ticket.key,
      priority,
      cause: downgrade !== undefined ? 'downgraded' : (moved?.kind ?? 'moved_away'),
    });
  }
  return out;
}

/** True when nothing blocks a clock out: the handoff is confirmed and every required ticket is listed with a next action. */
export function isGateOpen(gate: {
  readonly noConfirmedHandoff: boolean;
  readonly blockers: readonly unknown[];
}): boolean {
  return !gate.noConfirmedHandoff && gate.blockers.length === 0;
}

// --- shift definitions and roster (R-7.1) ---

export const shiftDefinitionSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Local wall-clock time in the business calendar's zone. */
  startsAt: timeOfDaySchema,
  endsAt: timeOfDaySchema,
  /** The end is on the next local day (22:00 to 08:00). */
  overnight: z.boolean(),
  /** The on-call flag of R-7.1: a person on this shift is reachable, not necessarily at a desk. */
  onCall: z.boolean(),
  active: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ShiftDefinition = z.infer<typeof shiftDefinitionSchema>;

export const shiftDefinitionListSchema = z.object({
  /** The zone the times are in: the default business calendar's. */
  timezone: z.string(),
  definitions: z.array(shiftDefinitionSchema),
});
export type ShiftDefinitionList = z.infer<typeof shiftDefinitionListSchema>;

export const createShiftDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    startsAt: timeOfDaySchema,
    endsAt: timeOfDaySchema,
    onCall: z.boolean().default(false),
  })
  .refine((value) => value.startsAt !== value.endsAt, {
    message: 'a shift cannot start and end at the same time',
    path: ['endsAt'],
  });
export type CreateShiftDefinition = z.infer<typeof createShiftDefinitionSchema>;

export const updateShiftDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    startsAt: timeOfDaySchema.optional(),
    endsAt: timeOfDaySchema.optional(),
    onCall: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to update' });
export type UpdateShiftDefinition = z.infer<typeof updateShiftDefinitionSchema>;

export const rosterEntrySchema = z.object({
  id: z.uuid(),
  shiftId: z.uuid(),
  shiftName: z.string(),
  onCall: z.boolean(),
  userId: z.uuid(),
  userName: z.string(),
  /** The local date the shift starts on. */
  workDate: dateOnlySchema,
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
});
export type RosterEntry = z.infer<typeof rosterEntrySchema>;

export const ROSTER_MAX_RANGE_DAYS = 62;

export const rosterQuerySchema = z
  .object({
    from: dateOnlySchema,
    to: dateOnlySchema,
    /** Lead and head only; an agent always gets their own schedule. */
    userId: z.uuid().optional(),
  })
  .refine((value) => value.to >= value.from, { message: 'to is before from', path: ['to'] })
  .refine((value) => addDaysToDateKey(value.from, ROSTER_MAX_RANGE_DAYS) >= value.to, {
    message: `at most ${String(ROSTER_MAX_RANGE_DAYS)} days`,
    path: ['to'],
  });
export type RosterQuery = z.infer<typeof rosterQuerySchema>;

export const rosterListSchema = z.object({
  timezone: z.string(),
  entries: z.array(rosterEntrySchema),
});
export type RosterList = z.infer<typeof rosterListSchema>;

export const createRosterEntrySchema = z.object({
  shiftId: z.uuid(),
  userId: z.uuid(),
  workDate: dateOnlySchema,
});
export type CreateRosterEntry = z.infer<typeof createRosterEntrySchema>;

// --- clock in and out (R-7.3) ---

export const shiftSessionSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  userName: z.string(),
  shiftId: z.uuid().nullable(),
  shiftName: z.string().nullable(),
  rosterEntryId: z.uuid().nullable(),
  /** False when the person clocked in without a roster entry ("clock in anyway"). */
  onRoster: z.boolean(),
  scheduledStart: z.iso.datetime().nullable(),
  scheduledEnd: z.iso.datetime().nullable(),
  clockedInAt: z.iso.datetime(),
  /** Whole minutes after the scheduled start; 0 when on time, early or off the roster. */
  lateMinutes: z.number().int().min(0),
  /** True when `lateMinutes` is past the grace period. */
  late: z.boolean(),
  device: z.string().nullable(),
  /** Whether the person agreed to location sharing. No position is stored in Phase 1. */
  locationConsent: z.boolean(),
  clockedOutAt: z.iso.datetime().nullable(),
  /** Set when a lead or head clocked this person out with the handoff incomplete; null if the account is gone. */
  override: z
    .object({ byId: z.uuid().nullable(), byName: z.string().nullable(), reason: z.string() })
    .nullable(),
  briefReadAt: z.iso.datetime().nullable(),
});
export type ShiftSession = z.infer<typeof shiftSessionSchema>;

export const clockInSchema = z.object({
  /** Free text from the browser (for example "Firefox on Windows"); the web app fills it in. */
  device: z.string().trim().max(200).optional(),
  /** Off unless the person ticks it. */
  locationConsent: z.boolean().default(false),
});
export type ClockIn = z.infer<typeof clockInSchema>;

export const clockOutSchema = z.object({
  /** Lead and head only: clock out although the handoff is incomplete. The reason is audited. */
  override: z.object({ reason: z.string().trim().min(10).max(500) }).optional(),
  /** Clock out someone else (lead and head only). Default: the caller. */
  userId: z.uuid().optional(),
});
export type ClockOut = z.infer<typeof clockOutSchema>;

export const clockOutResultSchema = z.object({
  session: shiftSessionSchema,
  /** True when a lead or head overrode an incomplete handoff. */
  overridden: z.boolean(),
});
export type ClockOutResult = z.infer<typeof clockOutResultSchema>;

/** Body of the 409 `handoff_incomplete` answer to a clock out that the gate refused. */
export const handoffIncompleteSchema = z.object({
  noConfirmedHandoff: z.boolean(),
  blockers: z.array(handoffBlockerSchema),
});
export type HandoffIncomplete = z.infer<typeof handoffIncompleteSchema>;

export const shiftStatusSchema = z.object({
  timezone: z.string(),
  now: z.iso.datetime(),
  session: shiftSessionSchema.nullable(),
  /** The caller's rostered shifts that are running, next or just ended (within a day either side). */
  roster: z.array(rosterEntrySchema),
  /** Minutes until the scheduled end of the open session; negative once it has passed; null off the roster. */
  minutesToEnd: z.number().int().nullable(),
  handoff: z.object({ id: z.uuid(), status: z.enum(['draft', 'confirmed']) }).nullable(),
  /** Why clock out would be refused right now (AC-7). Null when it would be accepted, and when there is no open session. */
  clockOutBlocked: handoffIncompleteSchema.nullable(),
  unreadNotes: z.number().int().min(0),
  /** Handoff items addressed to the caller that nobody has acknowledged. */
  pendingAcks: z.number().int().min(0),
});
export type ShiftStatus = z.infer<typeof shiftStatusSchema>;

// --- handoff (R-7.5, R-7.6) ---

export const HANDOFF_STATUSES = ['draft', 'confirmed'] as const;
export const handoffStatusSchema = z.enum(HANDOFF_STATUSES);
export type HandoffStatus = z.infer<typeof handoffStatusSchema>;

/**
 * What an item is. `pending` is a ticket carried over; the rest are written by the outgoing person
 * (there are no incident, deploy or alert tables yet, so nothing fills them in `[ASSUMED]`).
 */
export const HANDOFF_ITEM_KINDS = [
  'pending',
  'incident',
  'deploy',
  'alert',
  'watch',
  'note',
] as const;
export const handoffItemKindSchema = z.enum(HANDOFF_ITEM_KINDS);
export type HandoffItemKind = (typeof HANDOFF_ITEM_KINDS)[number];

/** The incoming person must acknowledge a pending ticket and an incident; the others are for information. */
export function itemRequiresAck(kind: HandoffItemKind): boolean {
  return kind === 'pending' || kind === 'incident';
}

export const HANDOFF_ACK_DECISIONS = ['accept', 'reassign', 'question'] as const;
export const handoffAckDecisionSchema = z.enum(HANDOFF_ACK_DECISIONS);
export type HandoffAckDecision = z.infer<typeof handoffAckDecisionSchema>;

/** `pending` = nobody has looked at it. `question` counts as acknowledged but the item stays open. */
export const HANDOFF_ACK_STATUSES = ['pending', 'accepted', 'reassigned', 'question'] as const;
export const handoffAckStatusSchema = z.enum(HANDOFF_ACK_STATUSES);
export type HandoffAckStatus = z.infer<typeof handoffAckStatusSchema>;

export const handoffItemSchema = z.object({
  id: z.uuid(),
  kind: handoffItemKindSchema,
  /** For a `pending` item: the ticket, as it is now. */
  ticket: z
    .object({
      id: z.uuid(),
      key: z.string(),
      subject: z.string(),
      priority: ticketPrioritySchema,
      status: z.string(),
      assignee: z.object({ id: z.uuid(), name: z.string() }).nullable(),
      slaState: slaStateSchema.nullable(),
    })
    .nullable(),
  title: z.string(),
  nextAction: z.string().nullable(),
  dueAt: z.iso.datetime().nullable(),
  severity: z.string().nullable(),
  /** `prefill`: made from the data when the draft was created. `manual`: written by the person. */
  source: z.enum(['prefill', 'manual']),
  /** A prefilled item whose text the person changed (R-7.5: edits are tracked). */
  edited: z.boolean(),
  requiresAck: z.boolean(),
  /** How many shifts the ticket had already crossed before this handoff (0 = new). */
  carriedShifts: z.number().int().min(0),
  ackStatus: handoffAckStatusSchema,
  ackBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  ackAt: z.iso.datetime().nullable(),
  ackNote: z.string().nullable(),
});
export type HandoffItem = z.infer<typeof handoffItemSchema>;

export const handoffSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  status: handoffStatusSchema,
  shiftName: z.string().nullable(),
  scheduledStart: z.iso.datetime().nullable(),
  scheduledEnd: z.iso.datetime().nullable(),
  from: z.object({ id: z.uuid(), name: z.string() }),
  /** The named incoming person; null means whoever is on the next shift. */
  to: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  items: z.array(handoffItemSchema),
  /** Free text: situational notes (R-7.5 item 7). */
  notes: z.string(),
  /** Left for the next shift; becomes a shift note when the handoff is confirmed. */
  messageForNext: z.string(),
  /** Images and files on the handoff (screenshots of what the next shift will meet). */
  attachments: z.array(staffAttachmentSchema),
  confirmedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Handoff = z.infer<typeof handoffSchema>;

/** A person who is rostered to start soon, to offer as the incoming person. */
export const incomingCandidateSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  shiftName: z.string(),
  startsAt: z.iso.datetime(),
});

export const currentHandoffSchema = z.object({
  /** Null until `POST /v1/handoffs/prefill` creates the draft. */
  handoff: handoffSchema.nullable(),
  /** What the gate refuses right now (AC-7); empty when a clock out would be accepted. */
  gate: handoffIncompleteSchema,
  incomingCandidates: z.array(incomingCandidateSchema),
});
export type CurrentHandoff = z.infer<typeof currentHandoffSchema>;

export const saveHandoffItemSchema = z
  .object({
    /** An existing item to change; omit to add one. */
    id: z.uuid().optional(),
    kind: handoffItemKindSchema,
    /** Required for a new `pending` item. */
    ticketId: z.uuid().optional(),
    title: z.string().trim().min(1).max(300),
    nextAction: z.string().trim().max(500).nullable().optional(),
    dueAt: z.iso.datetime().nullable().optional(),
    severity: z.string().trim().max(20).nullable().optional(),
  })
  .refine(
    (value) => value.id !== undefined || value.kind !== 'pending' || value.ticketId !== undefined,
    {
      message: 'a new pending item needs ticketId',
      path: ['ticketId'],
    },
  )
  .refine((value) => value.kind === 'pending' || value.ticketId === undefined, {
    message: 'only a pending item refers to a ticket',
    path: ['ticketId'],
  });

export const saveHandoffSchema = z.object({
  toUserId: z.uuid().nullable().optional(),
  notes: z.string().max(5000).optional(),
  messageForNext: z.string().max(2000).optional(),
  /** Uploaded files (`POST /v1/uploads`) to keep on the handoff; replaces the earlier set when given. */
  attachmentIds: attachmentIdsSchema.optional(),
  /** The whole list: an item left out is removed. */
  items: z.array(saveHandoffItemSchema).max(200),
});
export type SaveHandoff = z.infer<typeof saveHandoffSchema>;

/** One handoff addressed to the caller, with the items they still have to deal with. */
export const incomingHandoffSchema = z.object({
  id: z.uuid(),
  from: z.object({ id: z.uuid(), name: z.string() }),
  shiftName: z.string().nullable(),
  confirmedAt: z.iso.datetime(),
  notes: z.string(),
  messageForNext: z.string(),
  attachments: z.array(staffAttachmentSchema),
  items: z.array(handoffItemSchema),
});

export const incomingHandoffsSchema = z.object({
  handoffs: z.array(incomingHandoffSchema),
  /** Items that need an acknowledgment, over all the handoffs above. */
  total: z.number().int().min(0),
  /** Of those, how many are no longer `pending`. */
  acknowledged: z.number().int().min(0),
  /** When the lead is alerted if `acknowledged < total`: the earliest confirmation plus 30 minutes. */
  leadAlertAt: z.iso.datetime().nullable(),
});
export type IncomingHandoffs = z.infer<typeof incomingHandoffsSchema>;

export const ackHandoffItemSchema = z
  .object({
    decision: handoffAckDecisionSchema,
    /** For `reassign`: the staff user who takes the ticket. */
    assigneeId: z.uuid().optional(),
    /** For `question`: what to ask the outgoing person (sent to them as a shift note). */
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .refine((value) => value.decision !== 'reassign' || value.assigneeId !== undefined, {
    message: 'reassign needs assigneeId',
    path: ['assigneeId'],
  })
  .refine((value) => value.decision !== 'question' || value.note !== undefined, {
    message: 'a question needs a note',
    path: ['note'],
  });
export type AckHandoffItem = z.infer<typeof ackHandoffItemSchema>;

/** The answer to an acknowledgment: the item, and what the server noticed while doing it. */
export const ACK_WARNINGS = ['assignee_off_shift'] as const;
export const ackResultSchema = handoffItemSchema.extend({
  /** `assignee_off_shift`: a P3 or P4 ticket was reassigned to someone who is not clocked in (P1 and P2 are refused). */
  warnings: z.array(z.enum(ACK_WARNINGS)),
});
export type AckResult = z.infer<typeof ackResultSchema>;

export const handoffItemParamSchema = z.object({ itemId: z.uuid() });

// --- lead overview (AC-7: "the lead's dashboard shows 0 unacknowledged items") ---

export const shiftOverviewSchema = z.object({
  timezone: z.string(),
  generatedAt: z.iso.datetime(),
  onShift: z.array(shiftSessionSchema),
  /** Rostered entries whose start (plus grace) has passed with no clock in (R-7.3). */
  noShows: z.array(rosterEntrySchema),
  unacknowledged: z.object({
    count: z.number().int().min(0),
    /** Of those, items whose handoff was confirmed more than 30 minutes ago. */
    overdue: z.number().int().min(0),
    items: z.array(
      z.object({
        itemId: z.uuid(),
        handoffId: z.uuid(),
        title: z.string(),
        ticketKey: z.string().nullable(),
        from: z.object({ id: z.uuid(), name: z.string() }),
        confirmedAt: z.iso.datetime(),
        overdue: z.boolean(),
      }),
    ),
  }),
  /** Items a person asked a question about, still open (not yet accepted or reassigned). */
  openQuestions: z.number().int().min(0),
  /**
   * Open questions about a P1 or P2 ticket. A question counts as acknowledged (it is not in
   * `unacknowledged`) but nobody owns the ticket until it is answered, so one that has waited more
   * than 30 minutes is `overdue` here. Covers handoffs with and without a named recipient.
   */
  questions: z.object({
    overdue: z.number().int().min(0),
    items: z.array(
      z.object({
        itemId: z.uuid(),
        handoffId: z.uuid(),
        title: z.string(),
        ticketKey: z.string(),
        priority: ticketPrioritySchema,
        from: z.object({ id: z.uuid(), name: z.string() }),
        askedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
        askedAt: z.iso.datetime(),
        overdue: z.boolean(),
      }),
    ),
  }),
});
export type ShiftOverview = z.infer<typeof shiftOverviewSchema>;

// --- shift notes (R-7.7) ---

export const NOTE_AUDIENCES = ['next_shift', 'person', 'datetime'] as const;
export const noteAudienceSchema = z.enum(NOTE_AUDIENCES);
export type NoteAudience = z.infer<typeof noteAudienceSchema>;

export const shiftNoteSchema = z.object({
  id: z.uuid(),
  audience: noteAudienceSchema,
  author: z.object({ id: z.uuid(), name: z.string() }),
  toUser: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  /** For `datetime`: when it starts to show. */
  deliverAt: z.iso.datetime().nullable(),
  body: z.string(),
  attachments: z.array(staffAttachmentSchema),
  createdAt: z.iso.datetime(),
  /** When the caller marked it read; null while unread. */
  readAt: z.iso.datetime().nullable(),
});
export type ShiftNote = z.infer<typeof shiftNoteSchema>;

export const createShiftNoteSchema = z
  .object({
    audience: noteAudienceSchema,
    toUserId: z.uuid().optional(),
    deliverAt: z.iso.datetime().optional(),
    body: z.string().trim().min(1).max(2000),
    /** Uploaded files (`POST /v1/uploads`) shown with the note. */
    attachmentIds: attachmentIdsSchema.optional(),
  })
  .refine((value) => value.audience !== 'person' || value.toUserId !== undefined, {
    message: 'a note to a person needs toUserId',
    path: ['toUserId'],
  })
  .refine((value) => value.audience !== 'datetime' || value.deliverAt !== undefined, {
    message: 'a note for a date and time needs deliverAt',
    path: ['deliverAt'],
  })
  .refine(
    (value) =>
      value.audience === 'person' || value.audience === 'datetime' || value.toUserId === undefined,
    {
      message: 'toUserId only goes with a person or a date and time',
      path: ['toUserId'],
    },
  );
export type CreateShiftNote = z.infer<typeof createShiftNoteSchema>;

export const shiftNoteQuerySchema = z.object({
  /** `inbox`: addressed to the caller (or to the next shift). `sent`: written by the caller. */
  box: z.enum(['inbox', 'sent']).default('inbox'),
  unread: z.stringbool().default(false),
  limit: pageLimit(50, 100),
  cursor: cursorSchema.optional(),
});
export type ShiftNoteQuery = z.infer<typeof shiftNoteQuerySchema>;

export const shiftNotePageSchema = z.object({
  items: z.array(shiftNoteSchema),
  nextCursor: z.string().nullable(),
  unreadCount: z.number().int().min(0),
});
export type ShiftNotePage = z.infer<typeof shiftNotePageSchema>;

export const shiftNoteParamSchema = z.object({ id: z.uuid() });

// --- daily brief (R-7.4) ---

const briefTicketSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  subject: z.string(),
  priority: ticketPrioritySchema,
  status: z.string(),
  slaState: slaStateSchema.nullable(),
  /** Business minutes left on the running target; null when none runs or it is paused. */
  slaMinutesLeft: z.number().int().nullable(),
  dueAt: z.iso.datetime().nullable(),
});

/**
 * The brief at clock in. Every section is made from data by code; none of it is AI text
 * (`aiSummary` is reserved and null until the brief summarizer exists). Sections that need tables
 * that do not exist yet (KB changes, live incidents, deploys) show what the previous shift wrote
 * in its handoff and nothing else (N5).
 */
export const shiftBriefSchema = z.object({
  generatedAt: z.iso.datetime(),
  timezone: z.string(),
  session: shiftSessionSchema.nullable(),
  /** 1. The handoff from the previous shift: items to acknowledge first (AC-7). */
  handoff: incomingHandoffsSchema,
  /** 2, 5, 6, 7: what the previous shift wrote in its handoff, by kind. */
  incidents: z.array(handoffItemSchema),
  snoozedAlerts: z.array(handoffItemSchema),
  deploys: z.array(handoffItemSchema),
  watchItems: z.array(handoffItemSchema),
  /** 3. The caller's open tickets, most urgent first (breached, at risk, then due soonest). */
  myTickets: z.array(briefTicketSchema),
  /** 4. Of those, the ones that crossed at least one shift. */
  carriedOver: z.array(briefTicketSchema.extend({ crossedShifts: z.number().int().min(1) })),
  /** 9. Notes left for the caller that they have not marked read. */
  notes: z.array(shiftNoteSchema),
  /** Reserved for the AI summary (optional add-on); always null today. */
  aiSummary: z
    .object({
      text: z.string(),
      generatedAt: z.iso.datetime(),
      dataAsOf: z.iso.datetime(),
      aiRunId: z.string(),
    })
    .nullable(),
});
export type ShiftBrief = z.infer<typeof shiftBriefSchema>;

// --- who can be assigned (for agents without `user.read`) ---

export const assigneeQuerySchema = z.object({
  /** Mark which people are members of this queue. */
  queueId: z.uuid().optional(),
});
export type AssigneeQuery = z.infer<typeof assigneeQuerySchema>;

export const assigneeSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  role: z.enum(['agent', 'lead', 'head']),
  /** Clocked in now. Assignment by turns, load or last handler only picks these. */
  onShift: z.boolean(),
  /** Open tickets assigned to them (the load in R-1.7). */
  openTickets: z.number().int().min(0),
  /** Whether they are in the queue given as `queueId`; false when no queue was given. */
  inQueue: z.boolean(),
});
export type Assignee = z.infer<typeof assigneeSchema>;

/**
 * Why the list holds who it holds. `queue`: a queue with members was given, so `inQueue` is
 * meaningful (the list still holds every assignable person, members are marked). `all_staff`: no
 * queue was given, it does not exist or it has no members, so `inQueue` is false for all and the
 * list is simply every active agent, lead and head.
 */
export const ASSIGNEE_SCOPES = ['queue', 'all_staff'] as const;
export const assigneeScopeSchema = z.enum(ASSIGNEE_SCOPES);
export type AssigneeScope = z.infer<typeof assigneeScopeSchema>;

export const assigneeListSchema = z.object({
  scope: assigneeScopeSchema,
  assignees: z.array(assigneeSchema),
});
export type AssigneeList = z.infer<typeof assigneeListSchema>;

// --- SLA remaining, as the ticket list serves it ---

/**
 * The running SLA target of a ticket and how much of it is left, counted on the target's own
 * clock (business hours of the policy's calendar, or 24x7), so the web does not need the calendar.
 */
export const ticketSlaViewSchema = z.object({
  target: z.enum(['first_response', 'resolution']),
  state: slaStateSchema,
  dueAt: z.iso.datetime(),
  calendar: z.enum(['business', '24x7']),
  /** Minutes of SLA time left on `calendar`; 0 once breached; null while the clock is paused. */
  minutesLeft: z.number().int().min(0).nullable(),
});
export type TicketSlaView = z.infer<typeof ticketSlaViewSchema>;
