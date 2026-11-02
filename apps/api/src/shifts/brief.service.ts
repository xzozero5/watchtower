import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { onShiftCondition, openTicketCounts } from '@watchtower/domain';
import {
  OPEN_STATUSES,
  STAFF_ROLES,
  type AssistantLocale,
  type AssigneeList,
  type AssigneeQuery,
  type HandoffItem,
  type HandoffItemKind,
  type ShiftBrief,
  type SlaState,
  type TicketPriority,
  type TicketSlaView,
} from '@watchtower/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { AiSummaries, joinClaims } from '../ai/ai-summaries.service.js';
import type { Principal } from '../auth/principal.js';
import { DATABASE } from '../database/database.module.js';
import { SlaRemaining } from '../tickets/sla-remaining.js';
import { TICKET_KEYS, type TicketKeys } from '../tickets/ticket-keys.js';
import { briefFacts } from './brief-facts.js';
import { HandoffReader } from './handoff-reader.js';
import { SHIFT_NOW, openSessionOf, shiftTimezone, toSession, type ShiftNow } from './shift-core.js';
import { ShiftNotes } from './shift-notes.service.js';

/** Most urgent first: breached, at risk, fine, paused, and tickets with no running target last. */
const SLA_RANK: Readonly<Record<SlaState, number>> = { breached: 0, at_risk: 1, ok: 2, paused: 3 };

type BriefTicket = ShiftBrief['myTickets'][number];

/**
 * The daily brief at clock in (R-7.4), made from data by code. The handoff from the previous shift
 * comes first and is enough for AC-7; nothing here depends on an AI. `aiSummary` (T-135) is the AI's
 * reading of the same data as claims with links to the tickets and pages behind them, in the language
 * of the screen; it is null when the AI is off, over budget, failing or has nothing to say, and the
 * brief is complete without it.
 */
@Injectable()
export class BriefService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(HandoffReader) private readonly handoffs: HandoffReader,
    @Inject(ShiftNotes) private readonly notes: ShiftNotes,
    @Inject(SlaRemaining) private readonly sla: SlaRemaining,
    @Inject(TICKET_KEYS) private readonly keys: TicketKeys,
    @Inject(SHIFT_NOW) private readonly now: ShiftNow,
    @Inject(AiSummaries) private readonly summaries: AiSummaries,
  ) {}

  async brief(principal: Principal, locale: AssistantLocale = 'en'): Promise<ShiftBrief> {
    const db = this.database.db;
    const now = this.now();
    const session = await openSessionOf(db, principal.userId);
    const handoff = await this.handoffs.incoming(db, principal.userId);

    const ofKind = (kind: HandoffItemKind): HandoffItem[] =>
      handoff.handoffs.flatMap((entry) => entry.items.filter((item) => item.kind === kind));

    const tickets = await db
      .select()
      .from(schema.ticket)
      .where(
        and(
          eq(schema.ticket.assigneeId, principal.userId),
          inArray(schema.ticket.status, [...OPEN_STATUSES]),
        ),
      )
      .orderBy(asc(schema.ticket.number))
      .limit(200);
    const slas = await this.sla.viewMany(tickets, now);
    const crossed = await this.handoffs.carriedBefore(
      db,
      tickets.map((ticket) => ticket.id),
    );

    const entries = tickets.map((ticket, index) => {
      const sla: TicketSlaView | null = slas[index] ?? null;
      const view: BriefTicket = {
        id: ticket.id,
        key: this.keys.format(ticket.number),
        subject: ticket.subject,
        priority: ticket.priority as TicketPriority,
        status: ticket.status,
        slaState: sla?.state ?? null,
        slaMinutesLeft: sla?.minutesLeft ?? null,
        dueAt: sla?.dueAt ?? null,
      };
      return { view, crossed: crossed.get(ticket.id) ?? 0, number: ticket.number };
    });
    entries.sort(
      (a, b) =>
        (a.view.slaState === null ? 4 : SLA_RANK[a.view.slaState]) -
          (b.view.slaState === null ? 4 : SLA_RANK[b.view.slaState]) ||
        (a.view.dueAt ?? '9999').localeCompare(b.view.dueAt ?? '9999') ||
        a.number - b.number,
    );

    const brief = {
      generatedAt: now.toISOString(),
      timezone: await shiftTimezone(db),
      session: session === undefined ? null : toSession(session),
      handoff,
      incidents: ofKind('incident'),
      snoozedAlerts: ofKind('alert'),
      deploys: ofKind('deploy'),
      watchItems: ofKind('watch'),
      myTickets: entries.map((entry) => entry.view),
      carriedOver: entries
        .filter((entry) => entry.crossed >= 1)
        .map((entry) => ({ ...entry.view, crossedShifts: entry.crossed })),
      notes: await this.notes.unread(db, principal.userId),
      aiSummary: null,
    } satisfies ShiftBrief;
    const block = await this.summaries.claims({
      kind: 'brief',
      userId: principal.userId,
      locale,
      subject: 'the daily brief of a shift that is starting',
      facts: briefFacts(brief, locale),
      dataAsOf: now,
      maxClaims: 5,
    });
    return {
      ...brief,
      aiSummary: block === null ? null : { ...block, text: joinClaims(block.claims) },
    };
  }

  /**
   * Staff who can be assigned a ticket, for people who may not list users (`user.read`): name and
   * role only, with whether they are clocked in and how many open tickets they hold (R-1.7).
   */
  async assignees(query: AssigneeQuery): Promise<AssigneeList> {
    const db = this.database.db;
    const people = await db
      .select({
        id: schema.users.id,
        name: schema.users.name,
        role: schema.users.role,
        onShift: onShiftCondition().mapWith(Boolean),
      })
      .from(schema.users)
      .where(and(eq(schema.users.status, 'active'), inArray(schema.users.role, [...STAFF_ROLES])))
      .orderBy(asc(schema.users.name), asc(schema.users.id));
    const load = await openTicketCounts(
      db,
      people.map((person) => person.id),
    );
    const members =
      query.queueId === undefined
        ? new Set<string>()
        : new Set(
            (
              await db
                .select({ userId: schema.teamQueueMember.userId })
                .from(schema.teamQueueMember)
                .where(eq(schema.teamQueueMember.queueId, query.queueId))
            ).map((row) => row.userId),
          );
    return {
      assignees: people.map((person) => ({
        id: person.id,
        name: person.name,
        role: person.role as 'agent' | 'lead' | 'head',
        onShift: person.onShift,
        openTickets: load.get(person.id) ?? 0,
        inQueue: members.has(person.id),
      })),
    };
  }
}
