import { Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  DEFAULT_WEEKLY_HOURS,
  computeSlaDueDates,
  holidaySchema,
  resumeDueAfterPause,
  slaTargetsSchema,
  weeklyHoursSchema,
  type BusinessCalendar,
  type SlaCalendarMode,
  type SlaTargets,
  type TicketPriority,
} from '@watchtower/shared';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';

type PolicyRow = typeof schema.slaPolicy.$inferSelect;
type CalendarRow = typeof schema.businessCalendar.$inferSelect;
/** The database or a transaction: both can `select`. */
type Executor = Pick<Database['db'], 'select'>;

/** Used when no calendar has been configured at all, so SLA still works on a fresh install. `[ASSUMED]` */
export const FALLBACK_CALENDAR: BusinessCalendar = {
  timezone: 'Asia/Bangkok',
  hours: DEFAULT_WEEKLY_HOURS,
  holidays: [],
};

const holidayListSchema = z.array(holidaySchema);

export function calendarFromRow(row: CalendarRow): BusinessCalendar {
  const hours = weeklyHoursSchema.safeParse(row.hours);
  const holidays = holidayListSchema.safeParse(row.holidays);
  return {
    timezone: row.timezone,
    hours: hours.success ? hours.data : DEFAULT_WEEKLY_HOURS,
    holidays: holidays.success ? holidays.data.map((holiday) => holiday.date) : [],
  };
}

export function targetsFromRow(row: PolicyRow): SlaTargets {
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

/**
 * Which SLA policy applies to a ticket and what its due dates are (R-1.6). The date arithmetic is
 * the pure code in `@watchtower/shared`; this class only finds the policy and the calendar.
 *
 * Policy precedence `[ASSUMED]`: the organization's own policy (the contract), else the policy that
 * is the default for the organization's tier, else the policy of the intent. A cheaper intent
 * therefore cannot loosen what a customer is promised.
 */
@Injectable()
export class SlaService {
  async resolvePolicy(
    executor: Executor,
    org: TicketSlaInput['org'],
    intent: TicketSlaInput['intent'],
  ): Promise<PolicyRow | null> {
    if (org.slaPolicyId !== null) {
      const own = await this.policyById(executor, org.slaPolicyId);
      if (own) return own;
    }
    const [byTier] = await executor
      .select()
      .from(schema.slaPolicy)
      .where(eq(schema.slaPolicy.tier, org.tier))
      .limit(1);
    if (byTier) return byTier;
    if (intent?.slaPolicyId) return this.policyById(executor, intent.slaPolicyId);
    return null;
  }

  async calendarFor(executor: Executor, policy: PolicyRow | null): Promise<BusinessCalendar> {
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
  async forNewTicket(executor: Executor, input: TicketSlaInput): Promise<TicketSla> {
    const policy = await this.resolvePolicy(executor, input.org, input.intent);
    if (!policy) return { policyId: null, firstResponseDueAt: null, resolutionDueAt: null };
    const calendar = await this.calendarFor(executor, policy);
    const due = computeSlaDueDates({
      startedAt: input.startedAt,
      priority: input.priority,
      targets: targetsFromRow(policy),
      calendar,
    });
    return { policyId: policy.id, ...due };
  }

  /** Recomputes the due dates of an existing ticket from its own policy (priority changed). */
  async recompute(
    executor: Executor,
    ticket: { readonly slaPolicyId: string | null; readonly createdAt: Date },
    priority: TicketPriority,
  ): Promise<Pick<TicketSla, 'firstResponseDueAt' | 'resolutionDueAt'>> {
    if (ticket.slaPolicyId === null) return { firstResponseDueAt: null, resolutionDueAt: null };
    const policy = await this.policyById(executor, ticket.slaPolicyId);
    if (!policy) return { firstResponseDueAt: null, resolutionDueAt: null };
    return computeSlaDueDates({
      startedAt: ticket.createdAt,
      priority,
      targets: targetsFromRow(policy),
      calendar: await this.calendarFor(executor, policy),
    });
  }

  /**
   * New due dates for a ticket whose clock was stopped at `pausedAt` and restarts at `resumedAt`.
   * A due date that is already null stays null.
   */
  async resume(
    executor: Executor,
    ticket: {
      readonly slaPolicyId: string | null;
      readonly priority: string;
      readonly firstResponseDueAt: Date | null;
      readonly resolutionDueAt: Date | null;
    },
    pausedAt: Date,
    resumedAt: Date,
  ): Promise<Pick<TicketSla, 'firstResponseDueAt' | 'resolutionDueAt'>> {
    const unchanged = {
      firstResponseDueAt: ticket.firstResponseDueAt,
      resolutionDueAt: ticket.resolutionDueAt,
    };
    if (ticket.slaPolicyId === null) return unchanged;
    const policy = await this.policyById(executor, ticket.slaPolicyId);
    if (!policy) return unchanged;
    const calendar = await this.calendarFor(executor, policy);
    const mode: SlaCalendarMode =
      targetsFromRow(policy)[ticket.priority as TicketPriority]?.calendar ?? 'business';
    const shift = (due: Date | null): Date | null =>
      due === null ? null : resumeDueAfterPause({ pausedAt, resumedAt, due, mode, calendar });
    return {
      firstResponseDueAt: shift(ticket.firstResponseDueAt),
      resolutionDueAt: shift(ticket.resolutionDueAt),
    };
  }

  private async policyById(executor: Executor, id: string): Promise<PolicyRow | null> {
    const [row] = await executor
      .select()
      .from(schema.slaPolicy)
      .where(eq(schema.slaPolicy.id, id))
      .limit(1);
    return row ?? null;
  }
}
