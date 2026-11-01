import { HttpException, HttpStatus } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { FALLBACK_CALENDAR } from '@watchtower/domain';
import {
  SHIFT_LATE_GRACE_MINUTES,
  shiftWindow,
  type HandoffIncomplete,
  type RosterEntry,
  type ShiftSession,
} from '@watchtower/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

/** The clock of the shift features. Tests replace it to move time; production uses the system clock. */
export const SHIFT_NOW = Symbol('SHIFT_NOW');
export type ShiftNow = () => Date;

export type Executor = Pick<Database['db'], 'select'>;

/**
 * The zone shift times are in: the default business calendar's, never the zone of the server's
 * clock. An instance without a default calendar uses the same fallback as the SLA code.
 */
export async function shiftTimezone(executor: Executor): Promise<string> {
  const [calendar] = await executor
    .select({ timezone: schema.businessCalendar.timezone })
    .from(schema.businessCalendar)
    .where(eq(schema.businessCalendar.isDefault, true))
    .limit(1);
  return calendar?.timezone ?? FALLBACK_CALENDAR.timezone;
}

/**
 * 409 `handoff_incomplete`: the answer to a clock out (or a confirm) that AC-7 refuses. The body
 * carries what is missing, so the web can list it (UI spec 9.3 error summary).
 */
export class HandoffIncompleteError extends HttpException {
  readonly code = 'handoff_incomplete';

  constructor(readonly details: HandoffIncomplete) {
    const message = details.noConfirmedHandoff
      ? 'Finish the handoff first: it is not confirmed yet'
      : `Finish the handoff first: ${String(details.blockers.length)} ticket(s) need a next action`;
    super(
      {
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: 'handoff_incomplete',
        message,
        noConfirmedHandoff: details.noConfirmedHandoff,
        blockers: details.blockers,
      },
      HttpStatus.CONFLICT,
    );
  }
}

/** A handoff or item in a state that does not allow the change (409 `handoff_locked`). */
export class HandoffLockedError extends HttpException {
  readonly code = 'handoff_locked';

  constructor(message: string) {
    super(
      { statusCode: HttpStatus.CONFLICT, error: 'Conflict', code: 'handoff_locked', message },
      HttpStatus.CONFLICT,
    );
  }
}

// --- sessions ---

const overrideUser = alias(schema.users, 'override_user');

export function sessionQuery(executor: Executor) {
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

/** The open session of a person, if they are clocked in. */
export async function openSessionOf(
  executor: Executor,
  userId: string,
): Promise<SessionViewRow | undefined> {
  const [row] = await sessionQuery(executor)
    .where(and(eq(schema.shiftSession.userId, userId), isNull(schema.shiftSession.clockedOutAt)))
    .limit(1);
  return row;
}

export async function sessionById(
  executor: Executor,
  id: string,
): Promise<SessionViewRow | undefined> {
  const [row] = await sessionQuery(executor).where(eq(schema.shiftSession.id, id)).limit(1);
  return row;
}

// --- roster ---

export function rosterQuery(executor: Executor) {
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
