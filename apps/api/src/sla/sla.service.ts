import { Injectable } from '@nestjs/common';
import type { Database } from '@watchtower/db';
import {
  FALLBACK_CALENDAR,
  calendarFromRow,
  finishedSlaPauses,
  recomputeSla,
  resolveSlaPolicy,
  resumeSla,
  slaCalendarFor,
  slaForNewTicket,
  targetsFromRow,
  type SlaDue,
  type SlaPolicyRow,
  type TicketSla,
  type TicketSlaInput,
} from '@watchtower/domain';
import type { BusinessCalendar, SlaPause, TicketPriority } from '@watchtower/shared';

// The date and policy logic moved to @watchtower/domain (ADR-009), where the worker uses it too.
export { FALLBACK_CALENDAR, calendarFromRow, targetsFromRow };
export type { TicketSla, TicketSlaInput };

/** The database or a transaction: both can `select`. */
type Executor = Pick<Database['db'], 'select'>;

/**
 * Which SLA policy applies to a ticket and what its due dates are (R-1.6). The date arithmetic is
 * the pure code in `@watchtower/shared`; finding the policy and the calendar is in
 * `@watchtower/domain`. This class keeps the api's own entry point to both.
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
  ): Promise<SlaPolicyRow | null> {
    return resolveSlaPolicy(executor, org, intent);
  }

  async calendarFor(executor: Executor, policy: SlaPolicyRow | null): Promise<BusinessCalendar> {
    return slaCalendarFor(executor, policy);
  }

  /** The policy and the two due dates for a ticket that starts its clock at `startedAt`. */
  async forNewTicket(executor: Executor, input: TicketSlaInput): Promise<TicketSla> {
    return slaForNewTicket(executor, input);
  }

  /**
   * Recomputes the due dates of an existing ticket under `policyId` and `priority` (priority or
   * policy changed), applying again the pauses that already ended.
   */
  async recompute(
    executor: Executor,
    ticket: { readonly id: string; readonly createdAt: Date },
    policyId: string | null,
    priority: TicketPriority,
  ): Promise<SlaDue> {
    return recomputeSla(executor, ticket, policyId, priority);
  }

  /** The stops of the SLA clock that have ended, oldest first. */
  async finishedPauses(executor: Executor, ticketId: string): Promise<SlaPause[]> {
    return finishedSlaPauses(executor, ticketId);
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
  ): Promise<SlaDue> {
    return resumeSla(executor, ticket, pausedAt, resumedAt);
  }
}
