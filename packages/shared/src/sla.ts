import { z } from 'zod';

/**
 * SLA due-date arithmetic (PRD R-1.6). Pure functions: no I/O, no clock, no database. Everything is
 * stored and compared in UTC instants; the calendar's timezone is used only to decide which wall
 * clock hours count as business time.
 *
 * Two clocks exist:
 *  - `business`: time counts only inside the calendar's weekly hours, never on a holiday.
 *  - `24x7`: every minute counts (the PRD's option for P1).
 */

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const SLA_CALENDAR_MODES = ['business', '24x7'] as const;
export type SlaCalendarMode = (typeof SLA_CALENDAR_MODES)[number];

export const TICKET_PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const ticketPrioritySchema = z.enum(TICKET_PRIORITIES);

const MINUTE_MS = 60_000;
/** How far ahead a search for business time goes before the calendar is declared empty. */
const MAX_SCAN_DAYS = 800;
const MAX_TARGET_MINUTES = 60 * 24 * 365;

// --- calendar shape ---

const timeOfDay = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'expected HH:mm');

export function minutesOfDay(value: string): number {
  const [hours = '0', minutes = '0'] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

export const hoursWindowSchema = z
  .object({ start: timeOfDay, end: timeOfDay })
  .refine((window) => minutesOfDay(window.start) < minutesOfDay(window.end), {
    message: 'start must be before end',
    path: ['end'],
  });
export type HoursWindow = z.infer<typeof hoursWindowSchema>;

const windowsOfDay = z.array(hoursWindowSchema).max(6);

export const weeklyHoursSchema = z
  .object({
    sun: windowsOfDay,
    mon: windowsOfDay,
    tue: windowsOfDay,
    wed: windowsOfDay,
    thu: windowsOfDay,
    fri: windowsOfDay,
    sat: windowsOfDay,
  })
  .superRefine((hours, context) => {
    for (const day of WEEKDAYS) {
      const windows = hours[day];
      for (let index = 1; index < windows.length; index += 1) {
        const previous = windows[index - 1];
        const current = windows[index];
        if (previous && current && minutesOfDay(current.start) < minutesOfDay(previous.end)) {
          context.addIssue({
            code: 'custom',
            message: 'windows must be sorted and must not overlap',
            path: [day, index],
          });
        }
      }
    }
    if (WEEKDAYS.every((day) => hours[day].length === 0)) {
      context.addIssue({ code: 'custom', message: 'at least one day needs business hours' });
    }
  });
export type WeeklyHours = z.infer<typeof weeklyHoursSchema>;

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimezone, { message: 'unknown IANA timezone' });

/** A calendar date in the calendar's own timezone, `YYYY-MM-DD`. */
export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }, 'not a real calendar date');

export const holidaySchema = z.object({
  date: calendarDateSchema,
  name: z.string().trim().min(1).max(200),
});
export type Holiday = z.infer<typeof holidaySchema>;

/** What the arithmetic needs from a `business_calendar` row. */
export interface BusinessCalendar {
  readonly timezone: string;
  readonly hours: WeeklyHours;
  /** Dates (`YYYY-MM-DD` in `timezone`) on which no business time passes. */
  readonly holidays: readonly string[];
}

/** Monday to Friday 09:00 to 18:00 (an `[ASSUMED]` default; a deployment sets its own). */
export const DEFAULT_WEEKLY_HOURS: WeeklyHours = {
  sun: [],
  mon: [{ start: '09:00', end: '18:00' }],
  tue: [{ start: '09:00', end: '18:00' }],
  wed: [{ start: '09:00', end: '18:00' }],
  thu: [{ start: '09:00', end: '18:00' }],
  fri: [{ start: '09:00', end: '18:00' }],
  sat: [],
};

// --- targets ---

export const slaTargetSchema = z.object({
  first_response_min: z.number().int().min(0).max(MAX_TARGET_MINUTES),
  resolution_min: z.number().int().min(0).max(MAX_TARGET_MINUTES),
  calendar: z.enum(SLA_CALENDAR_MODES).default('business'),
});
export type SlaTarget = z.infer<typeof slaTargetSchema>;

/** Targets per priority; a priority without an entry gets no due date. */
export const slaTargetsSchema = z
  .object({
    P1: slaTargetSchema.optional(),
    P2: slaTargetSchema.optional(),
    P3: slaTargetSchema.optional(),
    P4: slaTargetSchema.optional(),
  })
  .refine(
    (targets) =>
      TICKET_PRIORITIES.every((priority) => {
        const target = targets[priority];
        return target === undefined || target.first_response_min <= target.resolution_min;
      }),
    { message: 'first response target cannot be longer than the resolution target' },
  );
export type SlaTargets = z.infer<typeof slaTargetsSchema>;

// --- time zone helpers ---

export class SlaCalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlaCalendarError';
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Offset of `timezone` from UTC at instant `ms`, in milliseconds (Bangkok is +25_200_000). */
function offsetAt(ms: number, timezone: string): number {
  const parts = formatterFor(timezone).formatToParts(new Date(Math.floor(ms / 1000) * 1000));
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const wall = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );
  return wall - Math.floor(ms / 1000) * 1000;
}

function localDateOf(ms: number, timezone: string): LocalDate {
  const shifted = new Date(ms + offsetAt(ms, timezone));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function nextDay(date: LocalDate): LocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

/** The UTC instant at which the wall clock of `timezone` shows `date` plus `minutes` after midnight. */
function wallClockToUtc(date: LocalDate, minutes: number, timezone: string): number {
  const naive = Date.UTC(date.year, date.month - 1, date.day) + minutes * MINUTE_MS;
  const first = naive - offsetAt(naive, timezone);
  return naive - offsetAt(first, timezone);
}

function dateKey(date: LocalDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function weekdayOf(date: LocalDate): Weekday {
  return WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()] ?? 'sun';
}

/** Business windows of one local day as UTC `[start, end)` pairs; none on a holiday. */
function windowsOn(
  date: LocalDate,
  calendar: BusinessCalendar,
  holidays: ReadonlySet<string>,
): [number, number][] {
  if (holidays.has(dateKey(date))) return [];
  return calendar.hours[weekdayOf(date)].map((window): [number, number] => [
    wallClockToUtc(date, minutesOfDay(window.start), calendar.timezone),
    wallClockToUtc(date, minutesOfDay(window.end), calendar.timezone),
  ]);
}

function assertInstant(ms: number, label: string): void {
  if (!Number.isFinite(ms)) throw new SlaCalendarError(`${label} is not a valid instant`);
}

function assertMinutes(minutes: number): void {
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new SlaCalendarError('a duration must be a finite, non-negative number of minutes');
  }
}

// --- business-time arithmetic ---

/** The instant `durationMs` of business time after `fromMs`. */
function addBusinessMs(fromMs: number, durationMs: number, calendar: BusinessCalendar): number {
  if (durationMs <= 0) return fromMs;
  const holidays = new Set(calendar.holidays);
  let remaining = durationMs;
  let cursor = fromMs;
  let day = localDateOf(fromMs, calendar.timezone);
  for (let scanned = 0; scanned < MAX_SCAN_DAYS; scanned += 1) {
    for (const [start, end] of windowsOn(day, calendar, holidays)) {
      if (end <= cursor) continue;
      const from = Math.max(start, cursor);
      const available = end - from;
      if (remaining <= available) return from + remaining;
      remaining -= available;
      cursor = end;
    }
    day = nextDay(day);
  }
  throw new SlaCalendarError(
    `the calendar has too little business time within ${String(MAX_SCAN_DAYS)} days`,
  );
}

/** Business time between two instants, in milliseconds. */
function businessMsBetween(fromMs: number, toMs: number, calendar: BusinessCalendar): number {
  if (toMs <= fromMs) return 0;
  const holidays = new Set(calendar.holidays);
  let total = 0;
  let day = localDateOf(fromMs, calendar.timezone);
  for (let scanned = 0; scanned < MAX_SCAN_DAYS * 5; scanned += 1) {
    const dayStart = wallClockToUtc(day, 0, calendar.timezone);
    if (dayStart >= toMs) return total;
    for (const [start, end] of windowsOn(day, calendar, holidays)) {
      const overlap = Math.min(end, toMs) - Math.max(start, fromMs);
      if (overlap > 0) total += overlap;
    }
    day = nextDay(day);
  }
  throw new SlaCalendarError('the interval is too long to measure against a calendar');
}

/**
 * The due instant for a target of `minutes` that starts counting at `from`.
 * A `from` outside business hours starts counting at the next opening.
 */
export function addSlaMinutes(
  from: Date,
  minutes: number,
  mode: SlaCalendarMode,
  calendar: BusinessCalendar,
): Date {
  assertInstant(from.getTime(), 'from');
  assertMinutes(minutes);
  if (mode === '24x7') return new Date(from.getTime() + minutes * MINUTE_MS);
  return new Date(addBusinessMs(from.getTime(), minutes * MINUTE_MS, calendar));
}

/** Minutes of SLA time that pass between two instants on the given clock. */
export function slaMinutesBetween(
  from: Date,
  to: Date,
  mode: SlaCalendarMode,
  calendar: BusinessCalendar,
): number {
  assertInstant(from.getTime(), 'from');
  assertInstant(to.getTime(), 'to');
  if (to.getTime() <= from.getTime()) return 0;
  if (mode === '24x7') return (to.getTime() - from.getTime()) / MINUTE_MS;
  return businessMsBetween(from.getTime(), to.getTime(), calendar) / MINUTE_MS;
}

export interface SlaDueDates {
  readonly firstResponseDueAt: Date | null;
  readonly resolutionDueAt: Date | null;
}

/** A stretch during which the SLA clock of a ticket was stopped. */
export interface SlaPause {
  readonly pausedAt: Date;
  readonly resumedAt: Date;
}

/**
 * Due dates for a ticket created at `startedAt`; both null when the policy has no target for the
 * priority. `pauses` are the stops that already ended, oldest first: each moves the due date as
 * `resumeDueAfterPause` did when the clock restarted, so a recalculation from `startedAt` (new
 * priority, new policy) does not count paused time as elapsed.
 */
export function computeSlaDueDates(input: {
  readonly startedAt: Date;
  readonly priority: TicketPriority;
  readonly targets: SlaTargets;
  readonly calendar: BusinessCalendar;
  readonly pauses?: readonly SlaPause[];
}): SlaDueDates {
  const target = input.targets[input.priority];
  if (!target) return { firstResponseDueAt: null, resolutionDueAt: null };
  const pauses = [...(input.pauses ?? [])].sort(
    (a, b) => a.pausedAt.getTime() - b.pausedAt.getTime(),
  );
  const due = (minutes: number): Date =>
    pauses.reduce(
      (current, pause) =>
        resumeDueAfterPause({
          pausedAt: pause.pausedAt,
          resumedAt: pause.resumedAt,
          due: current,
          mode: target.calendar,
          calendar: input.calendar,
        }),
      addSlaMinutes(input.startedAt, minutes, target.calendar, input.calendar),
    );
  return {
    firstResponseDueAt: due(target.first_response_min),
    resolutionDueAt: due(target.resolution_min),
  };
}

/**
 * Due date after a pause (PRD R-1.2: the clock stops in `waiting_on_customer`).
 *
 * The SLA time that was left when the clock stopped is still left when it restarts, so the new
 * due date is that remainder counted from `resumedAt` on the same clock. A target that was already
 * missed when the clock stopped stays as it was.
 */
export function resumeDueAfterPause(input: {
  readonly pausedAt: Date;
  readonly resumedAt: Date;
  readonly due: Date;
  readonly mode: SlaCalendarMode;
  readonly calendar: BusinessCalendar;
}): Date {
  if (input.due.getTime() <= input.pausedAt.getTime()) return input.due;
  if (input.resumedAt.getTime() <= input.pausedAt.getTime()) return input.due;
  const remainingMinutes = slaMinutesBetween(input.pausedAt, input.due, input.mode, input.calendar);
  return addSlaMinutes(input.resumedAt, remainingMinutes, input.mode, input.calendar);
}
