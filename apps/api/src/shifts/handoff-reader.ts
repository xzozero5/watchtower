import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { onShiftCondition } from '@watchtower/domain';
import {
  HANDOFF_ACK_ALERT_MINUTES,
  HANDOFF_REQUIRED_PRIORITIES,
  HANDOFF_VISIBLE_HOURS,
  OPEN_STATUSES,
  SHIFT_SESSION_MAX_HOURS,
  TICKET_EVENT_TYPES,
  TICKET_PRIORITIES,
  departedRequirements,
  handoffBlockers,
  isHandoffRequiredPriority,
  type HandoffBlockerCause,
  type OwnTicketChange,
  type Handoff,
  type HandoffAckStatus,
  type HandoffIncomplete,
  type HandoffItem,
  type HandoffItemKind,
  type IncomingHandoffs,
  type TicketPriority,
} from '@watchtower/shared';
import { and, asc, desc, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { notFound } from '../auth/http-errors.js';
import { SlaRemaining } from '../tickets/sla-remaining.js';
import { TICKET_KEYS, type TicketKeys } from '../tickets/ticket-keys.js';
import { SHIFT_NOW, type ShiftNow } from './shift-core.js';

/**
 * `clocked_in_at` is this process' clock and `ticket_event.created_at` the database's. A change made
 * right after clocking in must not fall before the session because of the skew between them. Counting
 * an event from just before the session errs toward the gate, and a lead can override it.
 */
const CLOCK_SKEW_MS = 60_000;

type Executor = Pick<Database['db'], 'select' | 'execute'>;

const ackUser = alias(schema.users, 'ack_user');
const assigneeUser = alias(schema.users, 'assignee_user');
const fromUser = alias(schema.users, 'from_user');
const toUser = alias(schema.users, 'to_user');

/** Reads handoffs: one as the outgoing person edits it, the ones addressed to someone, and the AC-7 gate. */
@Injectable()
export class HandoffReader {
  constructor(
    @Inject(TICKET_KEYS) private readonly keys: TicketKeys,
    @Inject(SlaRemaining) private readonly sla: SlaRemaining,
    @Inject(SHIFT_NOW) private readonly now: ShiftNow,
  ) {}

  /** Items of several handoffs, in the order the outgoing person put them. */
  async items(
    executor: Executor,
    handoffIds: readonly string[],
  ): Promise<Map<string, HandoffItem[]>> {
    const grouped = new Map<string, HandoffItem[]>(
      handoffIds.map((id): [string, HandoffItem[]] => [id, []]),
    );
    if (handoffIds.length === 0) return grouped;
    const rows = await executor
      .select({
        i: schema.handoffItem,
        t: schema.ticket,
        assigneeName: assigneeUser.name,
        ackName: ackUser.name,
      })
      .from(schema.handoffItem)
      .leftJoin(schema.ticket, eq(schema.ticket.id, schema.handoffItem.ticketId))
      .leftJoin(assigneeUser, eq(assigneeUser.id, schema.ticket.assigneeId))
      .leftJoin(ackUser, eq(ackUser.id, schema.handoffItem.ackBy))
      .where(inArray(schema.handoffItem.handoffId, [...handoffIds]))
      .orderBy(asc(schema.handoffItem.position), asc(schema.handoffItem.createdAt));

    const now = this.now();
    const tickets = rows.flatMap((row) => (row.t === null ? [] : [row.t]));
    const slas = await this.sla.viewMany(tickets, now);
    const slaByTicket = new Map(tickets.map((ticket, index) => [ticket.id, slas[index] ?? null]));

    for (const row of rows) {
      const { i, t } = row;
      const item: HandoffItem = {
        id: i.id,
        kind: i.kind as HandoffItemKind,
        ticket:
          t === null
            ? null
            : {
                id: t.id,
                key: this.keys.format(t.number),
                subject: t.subject,
                priority: t.priority as TicketPriority,
                status: t.status,
                assignee:
                  t.assigneeId !== null && row.assigneeName !== null
                    ? { id: t.assigneeId, name: row.assigneeName }
                    : null,
                slaState: slaByTicket.get(t.id)?.state ?? null,
              },
        title: i.title,
        nextAction: i.nextAction,
        dueAt: i.dueAt?.toISOString() ?? null,
        severity: i.severity,
        source: i.source as 'prefill' | 'manual',
        edited: i.edited,
        requiresAck: i.requiresAck,
        carriedShifts: i.carriedShifts,
        ackStatus: i.ackStatus as HandoffAckStatus,
        ackBy: i.ackBy !== null && row.ackName !== null ? { id: i.ackBy, name: row.ackName } : null,
        ackAt: i.ackAt?.toISOString() ?? null,
        ackNote: i.ackNote,
      };
      grouped.get(i.handoffId)?.push(item);
    }
    return grouped;
  }

  /** One handoff with its items, as the outgoing person edits it. 404 if it does not exist. */
  async view(executor: Executor, handoffId: string): Promise<Handoff> {
    const [row] = await executor
      .select({
        h: schema.handoff,
        s: schema.shiftSession,
        shiftName: schema.shiftDefinition.name,
        fromName: fromUser.name,
        toName: toUser.name,
      })
      .from(schema.handoff)
      .innerJoin(schema.shiftSession, eq(schema.shiftSession.id, schema.handoff.sessionId))
      .innerJoin(fromUser, eq(fromUser.id, schema.handoff.fromUserId))
      .leftJoin(toUser, eq(toUser.id, schema.handoff.toUserId))
      .leftJoin(schema.shiftDefinition, eq(schema.shiftDefinition.id, schema.shiftSession.shiftId))
      .where(eq(schema.handoff.id, handoffId))
      .limit(1);
    if (!row) throw notFound('No such handoff');
    const items = (await this.items(executor, [handoffId])).get(handoffId) ?? [];
    const { h } = row;
    return {
      id: h.id,
      sessionId: h.sessionId,
      status: h.status === 'confirmed' ? 'confirmed' : 'draft',
      shiftName: row.shiftName,
      scheduledStart: row.s.scheduledStart?.toISOString() ?? null,
      scheduledEnd: row.s.scheduledEnd?.toISOString() ?? null,
      from: { id: h.fromUserId, name: row.fromName },
      to: h.toUserId !== null && row.toName !== null ? { id: h.toUserId, name: row.toName } : null,
      items,
      notes: h.notes,
      messageForNext: h.messageForNext,
      confirmedAt: h.confirmedAt?.toISOString() ?? null,
      createdAt: h.createdAt.toISOString(),
      updatedAt: h.updatedAt.toISOString(),
    };
  }

  /** The handoff of a clock-in session, if one was started. */
  async idOfSession(executor: Executor, sessionId: string): Promise<string | null> {
    const [row] = await executor
      .select({ id: schema.handoff.id })
      .from(schema.handoff)
      .where(eq(schema.handoff.sessionId, sessionId))
      .limit(1);
    return row?.id ?? null;
  }

  /** Open tickets assigned to a person whose priority must be in the handoff (AC-7). */
  async requiredTickets(
    executor: Executor,
    userId: string,
  ): Promise<{ id: string; key: string; priority: TicketPriority }[]> {
    const rows = await executor
      .select({
        id: schema.ticket.id,
        number: schema.ticket.number,
        priority: schema.ticket.priority,
      })
      .from(schema.ticket)
      .where(
        and(
          eq(schema.ticket.assigneeId, userId),
          inArray(schema.ticket.status, [...OPEN_STATUSES]),
          inArray(schema.ticket.priority, [...HANDOFF_REQUIRED_PRIORITIES]),
        ),
      )
      .orderBy(asc(schema.ticket.priority), asc(schema.ticket.number));
    return rows.map((row) => ({
      id: row.id,
      key: this.keys.format(row.number),
      priority: row.priority as TicketPriority,
    }));
  }

  /**
   * What the gate requires of a person's session: their open P1/P2 tickets, plus the P1/P2 tickets
   * they took off their own plate during the shift and left unattended: unassigned, handed to
   * someone who is not on shift, or lowered in priority (the AC-7 bypass). Found in the ticket
   * history (`ticket.assigned`: from/to; `ticket.updated`: priority from/to), which keeps who did
   * it and when, so a colleague's or a lead's change to the ticket does not count against the person.
   */
  async requiredFor(
    executor: Executor,
    userId: string,
    sessionId: string,
  ): Promise<{ id: string; key: string; priority: TicketPriority; cause?: HandoffBlockerCause }[]> {
    const base = await this.requiredTickets(executor, userId);
    const [session] = await executor
      .select({ since: schema.shiftSession.clockedInAt })
      .from(schema.shiftSession)
      .where(eq(schema.shiftSession.id, sessionId))
      .limit(1);
    if (session === undefined) return base;

    const events = await executor
      .select({
        ticketId: schema.ticketEvent.ticketId,
        type: schema.ticketEvent.type,
        payload: schema.ticketEvent.payload,
      })
      .from(schema.ticketEvent)
      .where(
        and(
          gte(schema.ticketEvent.createdAt, new Date(session.since.getTime() - CLOCK_SKEW_MS)),
          eq(schema.ticketEvent.actorType, 'user'),
          eq(schema.ticketEvent.actorId, userId),
          inArray(schema.ticketEvent.type, [
            TICKET_EVENT_TYPES.assigned,
            TICKET_EVENT_TYPES.updated,
          ]),
        ),
      )
      .orderBy(asc(schema.ticketEvent.createdAt));

    const priorityOf = (value: unknown): TicketPriority | null =>
      typeof value === 'string' && (TICKET_PRIORITIES as readonly string[]).includes(value)
        ? (value as TicketPriority)
        : null;
    const changes: OwnTicketChange[] = [];
    for (const event of events) {
      const payload = event.payload as Record<string, unknown>;
      if (event.type === TICKET_EVENT_TYPES.assigned) {
        if (payload.from === userId && payload.to !== userId) {
          changes.push({ ticketId: event.ticketId, kind: 'moved_away', fromPriority: null });
        }
      } else {
        const priority = (payload.priority ?? {}) as Record<string, unknown>;
        const from = priorityOf(priority.from);
        const to = priorityOf(priority.to);
        if (
          from !== null &&
          isHandoffRequiredPriority(from) &&
          (to === null || !isHandoffRequiredPriority(to))
        ) {
          changes.push({ ticketId: event.ticketId, kind: 'downgraded', fromPriority: from });
        }
      }
    }
    const known = new Set(base.map((ticket) => ticket.id));
    const ids = [...new Set(changes.map((change) => change.ticketId))].filter(
      (id) => !known.has(id),
    );
    if (ids.length === 0) return base;

    const rows = await executor
      .select({
        id: schema.ticket.id,
        number: schema.ticket.number,
        priority: schema.ticket.priority,
        status: schema.ticket.status,
        assigneeId: schema.ticket.assigneeId,
        assigneeOnShift: sql<boolean>`COALESCE(${onShiftCondition()}, false)`,
      })
      .from(schema.ticket)
      .leftJoin(schema.users, eq(schema.users.id, schema.ticket.assigneeId))
      .where(inArray(schema.ticket.id, ids));
    const departed = departedRequirements({
      userId,
      changes,
      tickets: rows.map((row) => ({
        id: row.id,
        key: this.keys.format(row.number),
        priority: row.priority as TicketPriority,
        open: (OPEN_STATUSES as readonly string[]).includes(row.status),
        assigneeId: row.assigneeId,
        assigneeOnShift: row.assigneeOnShift,
      })),
    });
    return [...base, ...departed];
  }

  /**
   * The AC-7 gate for a person's session: what stops them clocking out. The handoff must be
   * confirmed, and every open P1/P2 ticket assigned to them must be one of its pending items with a
   * next action, which is checked again here because a ticket can be assigned after confirming.
   */
  async gate(executor: Executor, userId: string, sessionId: string): Promise<HandoffIncomplete> {
    const [handoff] = await executor
      .select({ id: schema.handoff.id, status: schema.handoff.status })
      .from(schema.handoff)
      .where(eq(schema.handoff.sessionId, sessionId))
      .limit(1);
    const required = await this.requiredFor(executor, userId, sessionId);
    const items =
      handoff === undefined
        ? []
        : await executor
            .select({
              kind: schema.handoffItem.kind,
              ticketId: schema.handoffItem.ticketId,
              nextAction: schema.handoffItem.nextAction,
            })
            .from(schema.handoffItem)
            .where(eq(schema.handoffItem.handoffId, handoff.id));
    return {
      noConfirmedHandoff: handoff?.status !== 'confirmed',
      blockers: handoffBlockers(required, items),
    };
  }

  /**
   * Is the person on shift: clocked in, and not for longer than `SHIFT_SESSION_MAX_HOURS` (the same
   * limit assignment uses, so a forgotten clock out does not keep someone "on shift" for ever).
   */
  async isOnShift(executor: Executor, userId: string): Promise<boolean> {
    const cutoff = new Date(this.now().getTime() - SHIFT_SESSION_MAX_HOURS * 3_600_000);
    const [open] = await executor
      .select({ id: schema.shiftSession.id })
      .from(schema.shiftSession)
      .where(
        and(
          eq(schema.shiftSession.userId, userId),
          isNull(schema.shiftSession.clockedOutAt),
          gte(schema.shiftSession.clockedInAt, cutoff),
        ),
      )
      .limit(1);
    return open !== undefined;
  }

  /**
   * Handoffs addressed to a person, confirmed within the last `HANDOFF_VISIBLE_HOURS`: those that
   * name them, and those that name nobody if they are clocked in. Newest first, with every item so
   * the progress ("3 of 7 acknowledged") can be shown.
   */
  async incoming(executor: Executor, userId: string): Promise<IncomingHandoffs> {
    const now = this.now();
    const cutoff = new Date(now.getTime() - HANDOFF_VISIBLE_HOURS * 3_600_000);
    const open = (await this.isOnShift(executor, userId)) ? { id: userId } : undefined;

    const rows = await executor
      .select({
        h: schema.handoff,
        shiftName: schema.shiftDefinition.name,
        fromName: fromUser.name,
      })
      .from(schema.handoff)
      .innerJoin(schema.shiftSession, eq(schema.shiftSession.id, schema.handoff.sessionId))
      .innerJoin(fromUser, eq(fromUser.id, schema.handoff.fromUserId))
      .leftJoin(schema.shiftDefinition, eq(schema.shiftDefinition.id, schema.shiftSession.shiftId))
      .where(
        and(
          eq(schema.handoff.status, 'confirmed'),
          gte(schema.handoff.confirmedAt, cutoff),
          ne(schema.handoff.fromUserId, userId),
          or(
            eq(schema.handoff.toUserId, userId),
            open === undefined ? undefined : isNull(schema.handoff.toUserId),
          ),
        ),
      )
      .orderBy(desc(schema.handoff.confirmedAt), desc(schema.handoff.id));

    const items = await this.items(
      executor,
      rows.map((row) => row.h.id),
    );
    let total = 0;
    let acknowledged = 0;
    const unacknowledgedSince: number[] = [];
    const handoffs = rows.map((row) => {
      const list = items.get(row.h.id) ?? [];
      for (const item of list) {
        if (!item.requiresAck) continue;
        total += 1;
        if (item.ackStatus !== 'pending') acknowledged += 1;
        else if (row.h.confirmedAt !== null) unacknowledgedSince.push(row.h.confirmedAt.getTime());
      }
      return {
        id: row.h.id,
        from: { id: row.h.fromUserId, name: row.fromName },
        shiftName: row.shiftName,
        confirmedAt: (row.h.confirmedAt ?? row.h.createdAt).toISOString(),
        notes: row.h.notes,
        messageForNext: row.h.messageForNext,
        items: list,
      };
    });
    const earliest = unacknowledgedSince.length === 0 ? null : Math.min(...unacknowledgedSince);
    return {
      handoffs,
      total,
      acknowledged,
      leadAlertAt:
        earliest === null
          ? null
          : new Date(earliest + HANDOFF_ACK_ALERT_MINUTES * 60_000).toISOString(),
    };
  }

  /**
   * How many shifts each ticket has already crossed: the carried count of its latest item in a
   * confirmed handoff, plus one. A ticket that was never in one is absent (0, "new").
   */
  async carriedBefore(
    executor: Executor,
    ticketIds: readonly string[],
  ): Promise<Map<string, number>> {
    const carried = new Map<string, number>();
    if (ticketIds.length === 0) return carried;
    const result = await executor.execute(sql`
      SELECT DISTINCT ON (hi.ticket_id) hi.ticket_id AS ticket_id, hi.carried_shifts AS carried
        FROM ${schema.handoffItem} hi
        JOIN ${schema.handoff} h ON h.id = hi.handoff_id
       WHERE h.status = 'confirmed' AND hi.kind = 'pending'
         AND hi.ticket_id = ANY(string_to_array(${ticketIds.join(',')}, ',')::uuid[])
       ORDER BY hi.ticket_id, h.confirmed_at DESC
    `);
    for (const row of result.rows as { ticket_id: string; carried: number }[]) {
      carried.set(row.ticket_id, row.carried + 1);
    }
    return carried;
  }
}
