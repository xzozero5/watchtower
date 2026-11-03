import {
  HANDOFF_CARRIED_WARNING,
  handoffIncompleteSchema,
  isHandoffRequiredPriority,
  type Assignee,
  type Handoff,
  type HandoffBlocker,
  type HandoffIncomplete,
  type HandoffItem,
  type HandoffItemKind,
  type SaveHandoff,
  type ShiftStatus,
} from '@watchtower/shared';

import type { Translate } from '@/i18n';
import { describeError, type ErrorView } from '@/lib/admin/errors';
import { isApiError } from '@/lib/api/errors';

// --- the shift chip (docs/06-UI-SPEC.md section 9.1) ---

export type ChipState =
  | { kind: 'off' }
  /** In a shift. `lateMinutes` > 0 only when the person was late past the grace period. */
  | { kind: 'on'; minutesToEnd: number | null; lateMinutes: number }
  /** The scheduled end has passed and the person is still clocked in: finish the handoff. */
  | { kind: 'ended'; minutesOver: number };

/** What the shift chip says. Late wins over the plain "on shift" because it is the warning. */
export function chipState(status: Pick<ShiftStatus, 'session' | 'minutesToEnd'>): ChipState {
  const { session, minutesToEnd } = status;
  if (session === null || session.clockedOutAt !== null) return { kind: 'off' };
  if (minutesToEnd !== null && minutesToEnd < 0) {
    return { kind: 'ended', minutesOver: Math.abs(minutesToEnd) };
  }
  return { kind: 'on', minutesToEnd, lateMinutes: session.late ? session.lateMinutes : 0 };
}

/** "3h 12m" from whole minutes. Locale-neutral on purpose: digits and unit letters only. */
export function minutesToClock(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  if (hours === 0) return `${String(rest)}m`;
  return `${String(hours)}h ${String(rest).padStart(2, '0')}m`;
}

/** "08:00" from a UTC instant, written in the shift zone. */
export function timeInZone(iso: string, timezone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: timezone,
  }).format(new Date(iso));
}

// --- the AC-7 gate ---

/** The 409 body of a refused clock out or confirm, or null for any other failure. */
export function gateFromError(error: unknown): HandoffIncomplete | null {
  if (!isApiError(error) || error.status !== 409 || error.code !== 'handoff_incomplete') {
    return null;
  }
  const parsed = handoffIncompleteSchema.safeParse(error.details);
  return parsed.success ? parsed.data : null;
}

export interface GateSummary {
  /** True when nothing blocks. */
  open: boolean;
  noConfirmedHandoff: boolean;
  blockers: number;
}

export function gateSummary(gate: HandoffIncomplete): GateSummary {
  return {
    open: !gate.noConfirmedHandoff && gate.blockers.length === 0,
    noConfirmedHandoff: gate.noConfirmedHandoff,
    blockers: gate.blockers.length,
  };
}

/**
 * The sentence next to a disabled Clock out button: "Finish the handoff first: 2 items need a next
 * action" (spec 9.1). Null when the gate is open.
 */
export function gateSentence(gate: HandoffIncomplete, t: Translate): string | null {
  const summary = gateSummary(gate);
  if (summary.open) return null;
  if (summary.blockers === 1) return t('shift.gate.itemOne');
  if (summary.blockers > 1) return t('shift.gate.items', { count: summary.blockers });
  return t('shift.gate.confirm');
}

export const BLOCKER_REASON_KEYS = {
  not_listed: 'shift.gate.notListed',
  missing_next_action: 'shift.gate.missingNextAction',
} as const satisfies Record<HandoffBlocker['reason'], string>;

export const BLOCKER_CAUSE_KEYS = {
  moved_away: 'shift.gate.movedAway',
  downgraded: 'shift.gate.downgraded',
} as const;

/** The element id of a handoff row's next-action field, so an error can link to it. */
export function nextActionFieldId(ticketId: string): string {
  return `handoff-next-${ticketId}`;
}

// --- errors ---

/**
 * `describeError` plus the two shift codes: a refused clock out says what to do, and a locked
 * handoff shows the api's own sentence.
 */
export function describeShiftError(error: unknown, t: Translate): ErrorView {
  if (isApiError(error) && error.code === 'handoff_incomplete') {
    return { kind: 'conflict', message: t('shift.gate.refused'), fromApi: false };
  }
  return describeError(error, t);
}

// --- the outgoing handoff draft ---

export interface DraftItem {
  /** Stable key for React and for focus; the server id once saved, a local id before that. */
  key: string;
  id?: string;
  kind: HandoffItemKind;
  ticketId?: string;
  /** For a ticket item: the key and priority shown in the table. */
  ticketKey?: string;
  priority?: string;
  title: string;
  nextAction: string;
  /** `datetime-local` text (browser zone) or ''. */
  due: string;
  severity: string;
  source: 'prefill' | 'manual';
  edited: boolean;
  carriedShifts: number;
}

export interface HandoffDraft {
  toUserId: string | null;
  notes: string;
  messageForNext: string;
  items: DraftItem[];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** ISO instant -> `YYYY-MM-DDTHH:mm` in the browser's zone, the value of a datetime-local input. */
export function isoToLocalInput(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function localInputToIso(value: string): string | null {
  if (value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function draftFromHandoff(handoff: Handoff): HandoffDraft {
  return {
    toUserId: handoff.to?.id ?? null,
    notes: handoff.notes,
    messageForNext: handoff.messageForNext,
    items: handoff.items.map((item) => ({
      key: item.id,
      id: item.id,
      kind: item.kind,
      ...(item.ticket ? { ticketId: item.ticket.id, ticketKey: item.ticket.key } : {}),
      ...(item.ticket ? { priority: item.ticket.priority } : {}),
      title: item.title,
      nextAction: item.nextAction ?? '',
      due: isoToLocalInput(item.dueAt),
      severity: item.severity ?? '',
      source: item.source,
      edited: item.edited,
      carriedShifts: item.carriedShifts,
    })),
  };
}

/** A pending item the person adds for a ticket the gate says is missing. */
export function draftItemForBlocker(blocker: HandoffBlocker): DraftItem {
  return {
    key: `new-${blocker.ticketId}`,
    kind: 'pending',
    ticketId: blocker.ticketId,
    ticketKey: blocker.key,
    priority: blocker.priority,
    title: blocker.key,
    nextAction: '',
    due: '',
    severity: '',
    source: 'manual',
    edited: false,
    carriedShifts: 0,
  };
}

export function toSaveBody(draft: HandoffDraft): SaveHandoff {
  return {
    toUserId: draft.toUserId,
    notes: draft.notes,
    messageForNext: draft.messageForNext,
    items: draft.items.map((item) => {
      const next = item.nextAction.trim();
      return {
        ...(item.id === undefined ? {} : { id: item.id }),
        kind: item.kind,
        // The api takes `ticketId` only for a new pending item.
        ...(item.id === undefined && item.kind === 'pending' && item.ticketId
          ? { ticketId: item.ticketId }
          : {}),
        title: item.title.trim() === '' ? (item.ticketKey ?? '') : item.title.trim(),
        nextAction: next === '' ? null : next,
        dueAt: localInputToIso(item.due),
        severity: item.severity.trim() === '' ? null : item.severity.trim(),
      };
    }),
  };
}

export interface DraftIssue {
  ticketId: string;
  fieldId: string;
  ticketKey: string;
  reason: 'missing_next_action';
}

/**
 * Items the person can see are wrong before asking the api: a P1 or P2 ticket in the list without a
 * next action. (A ticket missing from the list altogether is the api's `not_listed` blocker.)
 */
export function draftIssues(draft: HandoffDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  for (const item of draft.items) {
    if (item.kind !== 'pending' || item.ticketId === undefined) continue;
    if (item.priority === undefined || !isHandoffRequiredPriority(item.priority)) continue;
    if (item.nextAction.trim() === '') {
      issues.push({
        ticketId: item.ticketId,
        fieldId: nextActionFieldId(item.ticketId),
        ticketKey: item.ticketKey ?? item.title,
        reason: 'missing_next_action',
      });
    }
  }
  return issues;
}

/** The api blockers a draft still has: tickets not in the list at all. */
export function missingFromDraft(draft: HandoffDraft, blockers: readonly HandoffBlocker[]) {
  return blockers.filter(
    (blocker) =>
      blocker.reason === 'not_listed' &&
      !draft.items.some((item) => item.kind === 'pending' && item.ticketId === blocker.ticketId),
  );
}

export function sameDraft(a: HandoffDraft, b: HandoffDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- acknowledgment ---

export interface AckProgress {
  total: number;
  acknowledged: number;
  remaining: number;
  done: boolean;
}

export function ackProgress(total: number, acknowledged: number): AckProgress {
  const remaining = Math.max(0, total - acknowledged);
  return { total, acknowledged, remaining, done: total > 0 && remaining === 0 };
}

/** Items of the incoming handoffs that still need an answer from the caller, in display order. */
export function itemsToAnswer(items: readonly HandoffItem[]): HandoffItem[] {
  return items.filter((item) => item.requiresAck && item.ackStatus === 'pending');
}

/** True for a P1 or P2 ticket: it may only go to someone who is clocked in. */
export function mustGoToOnShift(item: HandoffItem): boolean {
  return item.ticket !== null && isHandoffRequiredPriority(item.ticket.priority);
}

/** Who an item may be reassigned to: everyone but, for P1 and P2, people who are off shift. */
export function canTakeItem(assignee: Pick<Assignee, 'onShift'>, item: HandoffItem): boolean {
  return assignee.onShift || !mustGoToOnShift(item);
}

/** "Crossed 3 shifts" turns to a warning at three (spec 9.4, `HANDOFF_CARRIED_WARNING`). */
export function carriedLevel(
  carriedShifts: number,
  warningAt: number = HANDOFF_CARRIED_WARNING,
): 'none' | 'carried' | 'warning' {
  if (carriedShifts <= 0) return 'none';
  return carriedShifts >= warningAt ? 'warning' : 'carried';
}

// --- SLA from the server ---

/** Minutes left on a running SLA target as a short clock; "paused" has no number. */
export function slaLeftText(minutesLeft: number | null): string | null {
  return minutesLeft === null ? null : minutesToClock(minutesLeft);
}

// --- chip words ---

export interface ChipLabel {
  text: string;
  /**
   * A few words that fit under the icon of the narrow rail (T-151): the shift's hours, or "Off
   * shift" / "Ended". `text` stays the accessible name and the tooltip.
   */
  short: string;
  /** Late, or the shift is over and the handoff is not: shown with a warning icon. */
  warning: boolean;
  state: ChipState['kind'];
}

/**
 * The words of the shift chip (docs/06-UI-SPEC.md section 9.1): "Off shift — Clock in",
 * "On shift · 08:00–17:00 · 3h 12m left", "Late 12m" next to it, "Shift ended 10m ago — finish handoff".
 */
export function chipLabel(
  status: Pick<ShiftStatus, 'session' | 'minutesToEnd' | 'timezone'>,
  t: Translate,
  locale: string,
): ChipLabel {
  const state = chipState(status);
  if (state.kind === 'off') {
    return {
      text: `${t('shift.chip.off')} — ${t('shift.chip.clockIn')}`,
      short: t('shift.chip.off'),
      warning: false,
      state: 'off',
    };
  }
  if (state.kind === 'ended') {
    return {
      text: t('shift.chip.ended', { over: minutesToClock(state.minutesOver) }),
      short: t('shift.chip.endedShort'),
      warning: true,
      state: 'ended',
    };
  }
  const session = status.session;
  const range =
    session?.scheduledStart && session.scheduledEnd
      ? `${timeInZone(session.scheduledStart, status.timezone, locale)}–${timeInZone(session.scheduledEnd, status.timezone, locale)}`
      : null;
  const base =
    range !== null && state.minutesToEnd !== null
      ? t('shift.chip.on', { range, left: minutesToClock(state.minutesToEnd) })
      : t('shift.chip.onNoEnd', { name: session?.shiftName ?? t('shift.chip.notRostered') });
  const short = range ?? t('shift.chip.onShort');
  if (state.lateMinutes > 0) {
    return {
      text: `${base} · ${t('shift.chip.late', { minutes: state.lateMinutes })}`,
      short,
      warning: true,
      state: 'on',
    };
  }
  return { text: base, short, warning: false, state: 'on' };
}

/** "Firefox on Windows" from the user agent, for the clock-in record. Never longer than 200 characters. */
export function deviceName(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Browser';
  const os = /Windows/.test(userAgent)
    ? 'Windows'
    : /Android/.test(userAgent)
      ? 'Android'
      : /iPhone|iPad/.test(userAgent)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null;
  return (os ? `${browser} on ${os}` : browser).slice(0, 200);
}

/** The local date `YYYY-MM-DD` in a zone, for the roster range. */
export function dateKeyInZone(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
}

export function addDays(dateKey: string, days: number): string {
  const [y = 0, m = 1, d = 1] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Monday of the week that contains `dateKey` (Monday first). */
export function weekStart(dateKey: string): string {
  const [y = 0, m = 1, d = 1] = dateKey.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(dateKey, -((weekday + 6) % 7));
}
