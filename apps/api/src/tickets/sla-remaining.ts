import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { FALLBACK_CALENDAR, slaCalendarFor, targetsFromRow } from '@watchtower/domain';
import {
  OPEN_STATUSES,
  isSlaAtRisk,
  slaMinutesBetween,
  type BusinessCalendar,
  type SlaCalendarMode,
  type SlaTargets,
  type TicketPriority,
  type TicketSlaView,
  type TicketStatus,
} from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import { DATABASE } from '../database/database.module.js';

/** The columns of a ticket that decide which SLA target runs and when it is due. */
export interface SlaInputs {
  readonly status: string;
  readonly priority: string;
  readonly createdAt: Date;
  readonly slaPolicyId: string | null;
  readonly slaPausedAt: Date | null;
  readonly firstResponseDueAt: Date | null;
  readonly resolutionDueAt: Date | null;
  readonly firstRespondedAt: Date | null;
  readonly resolvedAt: Date | null;
}

interface PolicyClock {
  readonly targets: SlaTargets;
  readonly calendar: BusinessCalendar;
}

const WALL_CLOCK: PolicyClock = { targets: {}, calendar: FALLBACK_CALENDAR };

/**
 * The running SLA target of a ticket and how much of it is left, on the target's own clock
 * (business time of the policy's calendar, or wall clock for a 24x7 target), so a client of the api
 * never has to know the calendar (T-111e). The same target rule as `runningDueSql()` in
 * `sla-states.ts`: an open ticket, the first response until it is answered, then the resolution.
 * Policies and calendars are read once per call.
 */
@Injectable()
export class SlaRemaining {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async viewMany(tickets: readonly SlaInputs[], now: Date): Promise<(TicketSlaView | null)[]> {
    const clocks = new Map<string, PolicyClock>();
    const out: (TicketSlaView | null)[] = [];
    for (const ticket of tickets) {
      out.push(await this.viewOne(ticket, now, clocks));
    }
    return out;
  }

  async view(ticket: SlaInputs, now: Date): Promise<TicketSlaView | null> {
    return this.viewOne(ticket, now, new Map());
  }

  private async clockOf(
    policyId: string | null,
    clocks: Map<string, PolicyClock>,
  ): Promise<PolicyClock> {
    if (policyId === null) return WALL_CLOCK;
    const known = clocks.get(policyId);
    if (known !== undefined) return known;
    const [policy] = await this.database.db
      .select()
      .from(schema.slaPolicy)
      .where(eq(schema.slaPolicy.id, policyId))
      .limit(1);
    const clock: PolicyClock =
      policy === undefined
        ? WALL_CLOCK
        : {
            targets: targetsFromRow(policy),
            calendar: await slaCalendarFor(this.database.db, policy),
          };
    clocks.set(policyId, clock);
    return clock;
  }

  private async viewOne(
    ticket: SlaInputs,
    now: Date,
    clocks: Map<string, PolicyClock>,
  ): Promise<TicketSlaView | null> {
    if (!OPEN_STATUSES.includes(ticket.status as TicketStatus)) return null;
    let target: 'first_response' | 'resolution';
    let due: Date;
    if (ticket.firstRespondedAt === null && ticket.firstResponseDueAt !== null) {
      target = 'first_response';
      due = ticket.firstResponseDueAt;
    } else if (ticket.resolvedAt === null && ticket.resolutionDueAt !== null) {
      target = 'resolution';
      due = ticket.resolutionDueAt;
    } else {
      return null;
    }

    const clock = await this.clockOf(ticket.slaPolicyId, clocks);
    const config = clock.targets[ticket.priority as TicketPriority];
    // A ticket whose policy is gone has no calendar to count on: wall clock.
    const mode: SlaCalendarMode = clock === WALL_CLOCK ? '24x7' : (config?.calendar ?? '24x7');
    const dueAt = due.toISOString();
    const calendar = mode === 'business' ? 'business' : '24x7';

    if (ticket.slaPausedAt !== null) {
      return { target, state: 'paused', dueAt, calendar, minutesLeft: null };
    }
    if (due.getTime() <= now.getTime()) {
      return { target, state: 'breached', dueAt, calendar, minutesLeft: 0 };
    }
    const targetMinutes =
      config === undefined
        ? (due.getTime() - ticket.createdAt.getTime()) / 60_000
        : target === 'first_response'
          ? config.first_response_min
          : config.resolution_min;
    const atRisk = isSlaAtRisk({
      now,
      dueAt: due,
      targetMinutes: targetMinutes > 0 ? targetMinutes : null,
      mode,
      calendar: clock.calendar,
    });
    return {
      target,
      state: atRisk ? 'at_risk' : 'ok',
      dueAt,
      calendar,
      minutesLeft: Math.ceil(slaMinutesBetween(now, due, mode, clock.calendar)),
    };
  }
}
