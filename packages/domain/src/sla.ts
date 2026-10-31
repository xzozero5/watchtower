import { schema } from '@watchtower/db';
import {
  DEFAULT_WEEKLY_HOURS,
  TICKET_EVENT_TYPES,
  computeSlaDueDates,
  holidaySchema,
  resumeDueAfterPause,
  slaResumedPayloadSchema,
  slaTargetsSchema,
  weeklyHoursSchema,
  type BusinessCalendar,
  type SlaCalendarMode,
  type SlaPause,
  type SlaTargets,
  type TicketPriority,
} from '@watchtower/shared';
import { and, asc, eq } from 'drizzle-orm';

import type { SlaPolicyRow } from './rows.js';
import type { ReadExecutor } from './types.js';

type CalendarRow = typeof schema.businessCalendar.$inferSelect;

/** Used when no calendar has been configured at all, so SLA still works on a fresh install. `[ASSUMED]` */
export const FALLBACK_CALENDAR: BusinessCalendar = {
  timezone: 'Asia/Bangkok',
  hours: DEFAULT_WEEKLY_HOURS,
  holidays: [],
};

export function calendarFromRow(row: CalendarRow): BusinessCalendar {
  const hours = weeklyHoursSchema.safeParse(row.hours);
  const holidays = holidaySchema.array().safeParse(row.holidays);
  return {
    timezone: row.timezone,
    hours: hours.success ? hours.data : DEFAULT_WEEKLY_HOURS,
    holidays: holidays.success ? holidays.data.map((holiday) => holiday.date) : [],
  };
}

export function targetsFromRow(row: SlaPolicyRow): SlaTargets {
  const parsed = slaTargetsSchema.safeParse(row.targets);
  return parsed.success ? parsed.data : {};
}

export interface TicketSlaInput {
  readonly org: { readonly tier: string; readonly slaPolicyId: string | null };
  readonly intent: { readonly slaPolicyId: string | null } | null;
  readonly priority: TicketPriority;
  /** When the clock starts: the creation time of the ticket. */
  readonly startedAt: Date;
}

export interface TicketSla {
  readonly policyId: string | null;
  readonly firstResponseDueAt: Date | null;
  readonly resolutionDueAt: Date | null;
}

export type SlaDue = Pick<TicketSla, 'firstResponseDueAt' | 'resolutionDueAt'>;

async function policyById(executor: ReadExecutor, id: string): Promise<SlaPolicyRow | null> {
  const [row] = await executor
    .select()
    .from(schema.slaPolicy)
    .where(eq(schema.slaPolicy.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Which SLA policy applies to a ticket (R-1.6). Precedence `[ASSUMED]`: the organization's own
 * policy (the contract), else the policy that is the default for the organization's tier, else the
 * policy of the intent. A cheaper intent therefore cannot loosen what a customer is promised.
 */
export async function resolveSlaPolicy(
  executor: ReadExecutor,
  org: TicketSlaInput['org'],
  intent: TicketSlaInput['intent'],
): Promise<SlaPolicyRow | null> {
  if (org.slaPolicyId !== null) {
    const own = await policyById(executor, org.slaPolicyId);
    if (own) return own;
  }
  const [byTier] = await executor
    .select()
    .from(schema.slaPolicy)
    .where(eq(schema.slaPolicy.tier, org.tier))
    .limit(1);
  if (byTier) return byTier;
  if (intent?.slaPolicyId) return policyById(executor, intent.slaPolicyId);
  return null;
}

export async function slaCalendarFor(
  executor: ReadExecutor,
  policy: SlaPolicyRow | null,
): Promise<BusinessCalendar> {
  if (policy?.businessCalendarId) {
    const [row] = await executor
      .select()
      .from(schema.businessCalendar)
      .where(eq(schema.businessCalendar.id, policy.businessCalendarId))
      .limit(1);
    if (row) return calendarFromRow(row);
  }
  const [fallback] = await executor
    .select()
    .from(schema.businessCalendar)
    .where(eq(schema.businessCalendar.isDefault, true))
    .limit(1);
  if (fallback) return calendarFromRow(fallback);
  const [any] = await executor
    .select()
    .from(schema.businessCalendar)
    .orderBy(asc(schema.businessCalendar.createdAt))
    .limit(1);
  return any ? calendarFromRow(any) : FALLBACK_CALENDAR;
}

/** The policy and the two due dates for a ticket that starts its clock at `startedAt`. */
export async function slaForNewTicket(
  executor: ReadExecutor,
  input: TicketSlaInput,
): Promise<TicketSla> {
  const policy = await resolveSlaPolicy(executor, input.org, input.intent);
  if (!policy) return { policyId: null, firstResponseDueAt: null, resolutionDueAt: null };
  const calendar = await slaCalendarFor(executor, policy);
  const due = computeSlaDueDates({
    startedAt: input.startedAt,
    priority: input.priority,
    targets: targetsFromRow(policy),
    calendar,
  });
  return { policyId: policy.id, ...due };
}

/**
 * The stops of the SLA clock that have ended, from the `sla.resumed` events of the ticket (the
 * event log is append-only, so it is the record of every pause). Oldest first.
 */
export async function finishedSlaPauses(
  executor: ReadExecutor,
  ticketId: string,
): Promise<SlaPause[]> {
  const events = await executor
    .select({ payload: schema.ticketEvent.payload, createdAt: schema.ticketEvent.createdAt })
    .from(schema.ticketEvent)
    .where(
      and(
        eq(schema.ticketEvent.ticketId, ticketId),
        eq(schema.ticketEvent.type, TICKET_EVENT_TYPES.slaResumed),
      ),
    )
    .orderBy(asc(schema.ticketEvent.createdAt), asc(schema.ticketEvent.id));
  const pauses: SlaPause[] = [];
  for (const event of events) {
    const parsed = slaResumedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) continue;
    pauses.push({
      pausedAt: new Date(parsed.data.pausedAt),
      resumedAt:
        parsed.data.resumedAt === undefined ? event.createdAt : new Date(parsed.data.resumedAt),
    });
  }
  return pauses;
}

/**
 * Recomputes the due dates of an existing ticket under `policyId` and `priority` (priority or
 * policy changed). The count starts at the creation time, then every pause that already ended is
 * applied again, so time spent waiting on the customer is not counted as elapsed. A pause that is
 * still running is left to `resumeSla`, which shifts the new dates by the whole pause when the
 * clock restarts; that is why the ticket keeps its original `slaPausedAt`.
 */
export async function recomputeSla(
  executor: ReadExecutor,
  ticket: { readonly id: string; readonly createdAt: Date },
  policyId: string | null,
  priority: TicketPriority,
): Promise<SlaDue> {
  if (policyId === null) return { firstResponseDueAt: null, resolutionDueAt: null };
  const policy = await policyById(executor, policyId);
  if (!policy) return { firstResponseDueAt: null, resolutionDueAt: null };
  return computeSlaDueDates({
    startedAt: ticket.createdAt,
    priority,
    targets: targetsFromRow(policy),
    calendar: await slaCalendarFor(executor, policy),
    pauses: await finishedSlaPauses(executor, ticket.id),
  });
}

/**
 * New due dates for a ticket whose clock was stopped at `pausedAt` and restarts at `resumedAt`.
 * A due date that is already null stays null.
 */
export async function resumeSla(
  executor: ReadExecutor,
  ticket: {
    readonly slaPolicyId: string | null;
    readonly priority: string;
    readonly firstResponseDueAt: Date | null;
    readonly resolutionDueAt: Date | null;
  },
  pausedAt: Date,
  resumedAt: Date,
): Promise<SlaDue> {
  const unchanged = {
    firstResponseDueAt: ticket.firstResponseDueAt,
    resolutionDueAt: ticket.resolutionDueAt,
  };
  if (ticket.slaPolicyId === null) return unchanged;
  const policy = await policyById(executor, ticket.slaPolicyId);
  if (!policy) return unchanged;
  const calendar = await slaCalendarFor(executor, policy);
  const mode: SlaCalendarMode =
    targetsFromRow(policy)[ticket.priority as TicketPriority]?.calendar ?? 'business';
  const shift = (due: Date | null): Date | null =>
    due === null ? null : resumeDueAfterPause({ pausedAt, resumedAt, due, mode, calendar });
  return {
    firstResponseDueAt: shift(ticket.firstResponseDueAt),
    resolutionDueAt: shift(ticket.resolutionDueAt),
  };
}
