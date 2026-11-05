import { schema } from '@watchtower/db';
import {
  HANDOFF_ACK_ALERT_MINUTES,
  SHIFT_LATE_GRACE_MINUTES,
  addDaysToDateKey,
  isHandoffRequiredPriority,
  localDateKeyOf,
  shiftWindow,
  type RosterEntry,
  type ShiftOverview,
  type ShiftSession,
  type TicketPriority,
} from '@watchtower/shared';
import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { FALLBACK_CALENDAR } from '../sla.js';
import type { ReadExecutor } from '../types.js';

/**
 * The zone shift times are in: the default business calendar's, never the zone of the server's
 * clock. An instance without a default calendar uses the same fallback as the SLA code.
 */
export async function shiftTimezone(executor: ReadExecutor): Promise<string> {
  const [calendar] = await executor
    .select({ timezone: schema.businessCalendar.timezone })
    .from(schema.businessCalendar)
    .where(eq(schema.businessCalendar.isDefault, true))
    .limit(1);
  return calendar?.timezone ?? FALLBACK_CALENDAR.timezone;
}

const overrideUser = alias(schema.users, 'override_user');

export function sessionQuery(executor: ReadExecutor) {
  return executor
    .select({
      s: schema.shiftSession,
      userName: schema.users.name,
      shiftName: schema.shiftDefinition.name,
      overrideName: overrideUser.name,
    })
    .from(schema.shiftSession)
    .innerJoin(schema.users, eq(schema.users.id, schema.shiftSession.userId))
    .leftJoin(schema.shiftDefinition, eq(schema.shiftDefinition.id, schema.shiftSession.shiftId))
    .leftJoin(overrideUser, eq(overrideUser.id, schema.shiftSession.overrideBy))
    .$dynamic();
}

export type SessionViewRow = Awaited<ReturnType<typeof sessionQuery>>[number];

export function toSession(row: SessionViewRow): ShiftSession {
  const s = row.s;
  return {
    id: s.id,
    userId: s.userId,
    userName: row.userName,
    shiftId: s.shiftId,
    shiftName: row.shiftName,
    rosterEntryId: s.rosterEntryId,
    onRoster: s.rosterEntryId !== null,
    scheduledStart: s.scheduledStart?.toISOString() ?? null,
    scheduledEnd: s.scheduledEnd?.toISOString() ?? null,
    clockedInAt: s.clockedInAt.toISOString(),
    lateMinutes: s.lateMinutes,
    late: s.lateMinutes > SHIFT_LATE_GRACE_MINUTES,
    device: s.device,
    locationConsent: s.locationConsent,
    clockedOutAt: s.clockedOutAt?.toISOString() ?? null,
    override:
      s.overrideReason === null
        ? null
        : { byId: s.overrideBy, byName: row.overrideName, reason: s.overrideReason },
    briefReadAt: s.briefReadAt?.toISOString() ?? null,
  };
}

export function rosterQuery(executor: ReadExecutor) {
  return executor
    .select({
      entry: schema.rosterEntry,
      shift: schema.shiftDefinition,
      userName: schema.users.name,
    })
    .from(schema.rosterEntry)
    .innerJoin(schema.shiftDefinition, eq(schema.shiftDefinition.id, schema.rosterEntry.shiftId))
    .innerJoin(schema.users, eq(schema.users.id, schema.rosterEntry.userId))
    .$dynamic();
}

export type RosterViewRow = Awaited<ReturnType<typeof rosterQuery>>[number];

export function toRosterEntry(row: RosterViewRow, timezone: string): RosterEntry {
  const window = shiftWindow(row.shift, row.entry.workDate, timezone);
  return {
    id: row.entry.id,
    shiftId: row.shift.id,
    shiftName: row.shift.name,
    onCall: row.shift.onCall,
    userId: row.entry.userId,
    userName: row.userName,
    workDate: row.entry.workDate,
    startsAt: window.start.toISOString(),
    endsAt: window.end.toISOString(),
  };
}

/**
 * Who is on shift, who did not show up, and what the incoming shift has not acknowledged (AC-7: "the
 * lead's dashboard shows 0 unacknowledged items after acknowledgment"). A no-show is a rostered shift whose
 * start plus the grace period passed with nobody clocked in against it. The shifts overview route and the
 * `shift.overview` insight (ADR-029 section 9) both read it, so the screen and the insight agree.
 */
export async function readShiftOverview(
  db: ReadExecutor,
  options: { readonly now: Date; readonly ticketKey: (number: number) => string },
): Promise<ShiftOverview> {
  const { now, ticketKey } = options;
  const timezone = await shiftTimezone(db);
  const today = localDateKeyOf(now, timezone);

  const open = await sessionQuery(db)
    .where(isNull(schema.shiftSession.clockedOutAt))
    .orderBy(asc(schema.shiftSession.clockedInAt));

  const roster = await rosterQuery(db)
    .where(
      sql`${schema.rosterEntry.workDate} BETWEEN ${addDaysToDateKey(today, -1)}::date AND ${addDaysToDateKey(today, 0)}::date`,
    )
    .orderBy(asc(schema.rosterEntry.workDate), asc(schema.shiftDefinition.startsAt));
  const clockedAgainst = new Set(
    (
      await db
        .select({ id: schema.shiftSession.rosterEntryId })
        .from(schema.shiftSession)
        .where(
          inArray(
            schema.shiftSession.rosterEntryId,
            roster.length === 0
              ? ['00000000-0000-0000-0000-000000000000']
              : roster.map((row) => row.entry.id),
          ),
        )
    ).flatMap((row) => (row.id === null ? [] : [row.id])),
  );
  const noShows = roster
    .filter((row) => {
      const window = shiftWindow(row.shift, row.entry.workDate, timezone);
      return (
        !clockedAgainst.has(row.entry.id) &&
        now.getTime() > window.start.getTime() + SHIFT_LATE_GRACE_MINUTES * 60_000 &&
        now.getTime() < window.end.getTime()
      );
    })
    .map((row) => toRosterEntry(row, timezone));

  const since = new Date(now.getTime() - 7 * 24 * 3_600_000);
  const fromUser = schema.users;
  const pending = await db
    .select({
      itemId: schema.handoffItem.id,
      handoffId: schema.handoff.id,
      title: schema.handoffItem.title,
      ticketNumber: schema.ticket.number,
      fromId: schema.handoff.fromUserId,
      fromName: fromUser.name,
      confirmedAt: schema.handoff.confirmedAt,
    })
    .from(schema.handoffItem)
    .innerJoin(schema.handoff, eq(schema.handoff.id, schema.handoffItem.handoffId))
    .innerJoin(fromUser, eq(fromUser.id, schema.handoff.fromUserId))
    .leftJoin(schema.ticket, eq(schema.ticket.id, schema.handoffItem.ticketId))
    .where(
      and(
        eq(schema.handoff.status, 'confirmed'),
        gte(schema.handoff.confirmedAt, since),
        eq(schema.handoffItem.requiresAck, true),
        eq(schema.handoffItem.ackStatus, 'pending'),
      ),
    )
    .orderBy(asc(schema.handoff.confirmedAt), asc(schema.handoffItem.position));
  const alertMs = HANDOFF_ACK_ALERT_MINUTES * 60_000;
  const items = pending.map((row) => {
    const confirmed = row.confirmedAt ?? now;
    return {
      itemId: row.itemId,
      handoffId: row.handoffId,
      title: row.title,
      ticketKey: row.ticketNumber === null ? null : ticketKey(row.ticketNumber),
      from: { id: row.fromId, name: row.fromName },
      confirmedAt: confirmed.toISOString(),
      overdue: now.getTime() - confirmed.getTime() > alertMs,
    };
  });
  // A question counts as acknowledged, but until it is answered (accepted or reassigned) nobody
  // owns the item. For P1 and P2 tickets that is shown to the lead, overdue after the same 30
  // minutes, counted from the question. Any confirmed handoff counts, named recipient or not.
  const askers = alias(schema.users, 'asker');
  const asked = await db
    .select({
      itemId: schema.handoffItem.id,
      handoffId: schema.handoff.id,
      title: schema.handoffItem.title,
      ticketNumber: schema.ticket.number,
      priority: schema.ticket.priority,
      fromId: schema.handoff.fromUserId,
      fromName: schema.users.name,
      askerId: schema.handoffItem.ackBy,
      askerName: askers.name,
      askedAt: schema.handoffItem.ackAt,
    })
    .from(schema.handoffItem)
    .innerJoin(schema.handoff, eq(schema.handoff.id, schema.handoffItem.handoffId))
    .innerJoin(schema.users, eq(schema.users.id, schema.handoff.fromUserId))
    .leftJoin(schema.ticket, eq(schema.ticket.id, schema.handoffItem.ticketId))
    .leftJoin(askers, eq(askers.id, schema.handoffItem.ackBy))
    .where(
      and(
        eq(schema.handoffItem.ackStatus, 'question'),
        eq(schema.handoff.status, 'confirmed'),
        gte(schema.handoff.confirmedAt, since),
      ),
    )
    .orderBy(asc(schema.handoffItem.ackAt));
  const questionItems = asked
    .flatMap((row) =>
      row.ticketNumber !== null && row.priority !== null && isHandoffRequiredPriority(row.priority)
        ? [{ ...row, ticketNumber: row.ticketNumber, priority: row.priority }]
        : [],
    )
    .map((row) => {
      const askedAt = row.askedAt ?? now;
      return {
        itemId: row.itemId,
        handoffId: row.handoffId,
        title: row.title,
        ticketKey: ticketKey(row.ticketNumber),
        priority: row.priority as TicketPriority,
        from: { id: row.fromId, name: row.fromName },
        askedBy:
          row.askerId !== null && row.askerName !== null
            ? { id: row.askerId, name: row.askerName }
            : null,
        askedAt: askedAt.toISOString(),
        overdue: now.getTime() - askedAt.getTime() > alertMs,
      };
    });
  return {
    timezone,
    generatedAt: now.toISOString(),
    onShift: open.map(toSession),
    noShows,
    unacknowledged: {
      count: items.length,
      overdue: items.filter((item) => item.overdue).length,
      items,
    },
    openQuestions: asked.length,
    questions: {
      overdue: questionItems.filter((item) => item.overdue).length,
      items: questionItems,
    },
  };
}
