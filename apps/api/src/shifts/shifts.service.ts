import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { readShiftOverview } from '@watchtower/domain';
import {
  AUDIT_ACTIONS,
  SHIFT_LATE_GRACE_MINUTES,
  addDaysToDateKey,
  crossesMidnight,
  isGateOpen,
  lateMinutes,
  localDateKeyOf,
  pickRosterWindow,
  shiftWindow,
  type ClockIn,
  type ClockOut,
  type ClockOutResult,
  type CreateRosterEntry,
  type CreateShiftDefinition,
  type RosterEntry,
  type RosterList,
  type RosterQuery,
  type ShiftDefinition,
  type ShiftDefinitionList,
  type ShiftOverview,
  type ShiftSession,
  type ShiftStatus,
  type UpdateShiftDefinition,
} from '@watchtower/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { AuditService } from '../audit/audit.service.js';
import { badRequest, conflict, forbidden, notFound } from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import { PG, isPgError } from '../common/db-errors.js';
import { DATABASE } from '../database/database.module.js';
import { UnitOfWorkService, type UnitOfWork } from '../realtime/unit-of-work.js';
import { TICKET_KEYS, type TicketKeys } from '../tickets/ticket-keys.js';
import { HandoffReader } from './handoff-reader.js';
import {
  HandoffIncompleteError,
  SHIFT_NOW,
  openSessionOf,
  rosterQuery,
  sessionQuery,
  shiftTimezone,
  toRosterEntry,
  toSession,
  type ShiftNow,
} from './shift-core.js';
import { ShiftNotes } from './shift-notes.service.js';

type DefinitionRow = typeof schema.shiftDefinition.$inferSelect;

function toDefinition(row: DefinitionRow): ShiftDefinition {
  return {
    id: row.id,
    name: row.name,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    overnight: crossesMidnight(row),
    onCall: row.onCall,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Shift definitions, the roster, and clock in / out (R-7.1, R-7.3). The AC-7 gate lives here: a
 * clock out is refused while the handoff is missing or incomplete, unless a lead or head overrides
 * it with a reason. Times are wall-clock times in the zone of the default business calendar.
 */
@Injectable()
export class ShiftsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(HandoffReader) private readonly handoffs: HandoffReader,
    @Inject(ShiftNotes) private readonly notes: ShiftNotes,
    @Inject(TICKET_KEYS) private readonly keys: TicketKeys,
    @Inject(SHIFT_NOW) private readonly now: ShiftNow,
  ) {}

  // --- definitions ---

  async definitions(): Promise<ShiftDefinitionList> {
    const rows = await this.database.db
      .select()
      .from(schema.shiftDefinition)
      .orderBy(asc(schema.shiftDefinition.startsAt), asc(schema.shiftDefinition.name));
    return { timezone: await shiftTimezone(this.database.db), definitions: rows.map(toDefinition) };
  }

  async createDefinition(
    principal: Principal,
    input: CreateShiftDefinition,
  ): Promise<ShiftDefinition> {
    return this.uow.run(async (uow) => {
      try {
        const [row] = await uow.tx
          .insert(schema.shiftDefinition)
          .values({
            name: input.name,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            onCall: input.onCall,
          })
          .returning();
        if (row === undefined) throw new Error('insert returned nothing');
        await this.audit.recordInTransaction(uow.tx, {
          actor: { type: 'user', id: principal.userId },
          action: AUDIT_ACTIONS.shiftDefinitionCreate,
          targetType: 'shift_definition',
          targetId: row.id,
          after: toDefinition(row),
        });
        return toDefinition(row);
      } catch (error) {
        if (isPgError(error, PG.uniqueViolation)) throw conflict('A shift with this name exists');
        throw error;
      }
    });
  }

  async updateDefinition(
    principal: Principal,
    id: string,
    input: UpdateShiftDefinition,
  ): Promise<ShiftDefinition> {
    return this.uow.run(async (uow) => {
      const [before] = await uow.tx
        .select()
        .from(schema.shiftDefinition)
        .where(eq(schema.shiftDefinition.id, id))
        .for('update');
      if (before === undefined) throw notFound('No such shift');
      const startsAt = input.startsAt ?? before.startsAt;
      const endsAt = input.endsAt ?? before.endsAt;
      if (startsAt === endsAt) throw badRequest('A shift cannot start and end at the same time');
      try {
        const [row] = await uow.tx
          .update(schema.shiftDefinition)
          .set({
            ...(input.name === undefined ? {} : { name: input.name }),
            startsAt,
            endsAt,
            ...(input.onCall === undefined ? {} : { onCall: input.onCall }),
            ...(input.active === undefined ? {} : { active: input.active }),
            updatedAt: this.now(),
          })
          .where(eq(schema.shiftDefinition.id, id))
          .returning();
        if (row === undefined) throw notFound('No such shift');
        await this.audit.recordInTransaction(uow.tx, {
          actor: { type: 'user', id: principal.userId },
          action: AUDIT_ACTIONS.shiftDefinitionUpdate,
          targetType: 'shift_definition',
          targetId: id,
          before: toDefinition(before),
          after: toDefinition(row),
        });
        return toDefinition(row);
      } catch (error) {
        if (isPgError(error, PG.uniqueViolation)) throw conflict('A shift with this name exists');
        throw error;
      }
    });
  }

  // --- roster ---

  /**
   * The roster between two local dates. A lead or head (`roster.manage`) sees everyone's and may
   * filter by person; anyone else sees only their own schedule (R-7.2 "agents see their schedule").
   */
  async roster(principal: Principal, query: RosterQuery): Promise<RosterList> {
    const db = this.database.db;
    const manager = principal.permissions.has('roster.manage');
    const userId = manager ? query.userId : principal.userId;
    const timezone = await shiftTimezone(db);
    const rows = await rosterQuery(db)
      .where(
        and(
          sql`${schema.rosterEntry.workDate} BETWEEN ${query.from}::date AND ${query.to}::date`,
          userId === undefined ? undefined : eq(schema.rosterEntry.userId, userId),
        ),
      )
      .orderBy(
        asc(schema.rosterEntry.workDate),
        asc(schema.shiftDefinition.startsAt),
        asc(schema.users.name),
      );
    return { timezone, entries: rows.map((row) => toRosterEntry(row, timezone)) };
  }

  /**
   * Puts a person on a shift. `within` is the transaction of a caller that writes many entries at once (the
   * roster planner's apply); without it the entry is written in its own transaction.
   */
  async assignRoster(
    principal: Principal,
    input: CreateRosterEntry,
    within?: UnitOfWork,
  ): Promise<RosterEntry> {
    const run = <T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> =>
      within === undefined ? this.uow.run(work) : work(within);
    return run(async (uow) => {
      const [person] = await uow.tx
        .select({ id: schema.users.id, role: schema.users.role, status: schema.users.status })
        .from(schema.users)
        .where(eq(schema.users.id, input.userId))
        .limit(1);
      if (person?.status !== 'active' || !['agent', 'lead', 'head'].includes(person.role)) {
        throw badRequest('userId must be an active staff user');
      }
      const [shift] = await uow.tx
        .select({ id: schema.shiftDefinition.id, active: schema.shiftDefinition.active })
        .from(schema.shiftDefinition)
        .where(eq(schema.shiftDefinition.id, input.shiftId))
        .limit(1);
      if (shift === undefined) throw badRequest('shiftId does not refer to a shift');
      if (!shift.active) throw badRequest('That shift is not active');

      const [inserted] = await uow.tx
        .insert(schema.rosterEntry)
        .values({
          shiftId: input.shiftId,
          userId: input.userId,
          workDate: input.workDate,
          createdBy: principal.userId,
        })
        .onConflictDoNothing()
        .returning({ id: schema.rosterEntry.id });
      const [row] = await rosterQuery(uow.tx)
        .where(
          and(
            eq(schema.rosterEntry.userId, input.userId),
            eq(schema.rosterEntry.shiftId, input.shiftId),
            sql`${schema.rosterEntry.workDate} = ${input.workDate}::date`,
          ),
        )
        .limit(1);
      if (row === undefined) throw new Error('roster entry vanished');
      const entry = toRosterEntry(row, await shiftTimezone(uow.tx));
      await this.audit.recordInTransaction(uow.tx, {
        actor: { type: 'user', id: principal.userId },
        action: AUDIT_ACTIONS.rosterAssign,
        targetType: 'roster_entry',
        targetId: entry.id,
        after: { userId: entry.userId, shiftId: entry.shiftId, workDate: entry.workDate },
        metadata: { created: inserted !== undefined },
      });
      return entry;
    });
  }

  async removeRoster(principal: Principal, id: string, within?: UnitOfWork): Promise<void> {
    const run = <T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> =>
      within === undefined ? this.uow.run(work) : work(within);
    await run(async (uow) => {
      const [row] = await uow.tx
        .delete(schema.rosterEntry)
        .where(eq(schema.rosterEntry.id, id))
        .returning();
      if (row === undefined) throw notFound('No such roster entry');
      await this.audit.recordInTransaction(uow.tx, {
        actor: { type: 'user', id: principal.userId },
        action: AUDIT_ACTIONS.rosterRemove,
        targetType: 'roster_entry',
        targetId: id,
        before: { userId: row.userId, shiftId: row.shiftId, workDate: row.workDate },
      });
    });
  }

  // --- status (the shift chip) ---

  async status(principal: Principal): Promise<ShiftStatus> {
    const db = this.database.db;
    const now = this.now();
    const timezone = await shiftTimezone(db);
    const open = await openSessionOf(db, principal.userId);
    const today = localDateKeyOf(now, timezone);
    const rosterRows = await rosterQuery(db)
      .where(
        and(
          eq(schema.rosterEntry.userId, principal.userId),
          sql`${schema.rosterEntry.workDate} BETWEEN ${addDaysToDateKey(today, -1)}::date AND ${addDaysToDateKey(today, 1)}::date`,
        ),
      )
      .orderBy(asc(schema.rosterEntry.workDate), asc(schema.shiftDefinition.startsAt));
    const handoffId = open === undefined ? null : await this.handoffs.idOfSession(db, open.s.id);
    const handoff =
      handoffId === null
        ? null
        : await db
            .select({ id: schema.handoff.id, status: schema.handoff.status })
            .from(schema.handoff)
            .where(eq(schema.handoff.id, handoffId))
            .limit(1)
            .then(([row]) =>
              row === undefined
                ? null
                : {
                    id: row.id,
                    status:
                      row.status === 'confirmed' ? ('confirmed' as const) : ('draft' as const),
                  },
            );
    const gate =
      open === undefined ? null : await this.handoffs.gate(db, principal.userId, open.s.id);
    const incoming = await this.handoffs.incoming(db, principal.userId);
    return {
      timezone,
      now: now.toISOString(),
      session: open === undefined ? null : toSession(open),
      roster: rosterRows.map((row) => toRosterEntry(row, timezone)),
      minutesToEnd:
        open?.s.scheduledEnd == null
          ? null
          : Math.floor((open.s.scheduledEnd.getTime() - now.getTime()) / 60_000),
      handoff,
      clockOutBlocked: gate === null || isGateOpen(gate) ? null : gate,
      unreadNotes: await this.notes.unreadCount(db, principal.userId),
      pendingAcks: incoming.total - incoming.acknowledged,
    };
  }

  // --- clock in and out ---

  /**
   * Clocks the caller in. The roster entry whose window is running (or starts within an hour) is
   * attached; without one the person still clocks in, flagged `onRoster: false` ("clock in
   * anyway"). `lateMinutes` is counted from the scheduled start.
   */
  async clockIn(principal: Principal, input: ClockIn): Promise<ShiftSession> {
    return this.uow.run(async (uow) => {
      const now = this.now();
      const existing = await openSessionOf(uow.tx, principal.userId);
      if (existing !== undefined) throw conflict('You are already clocked in');

      const timezone = await shiftTimezone(uow.tx);
      const today = localDateKeyOf(now, timezone);
      const entries = await rosterQuery(uow.tx).where(
        and(
          eq(schema.rosterEntry.userId, principal.userId),
          sql`${schema.rosterEntry.workDate} BETWEEN ${addDaysToDateKey(today, -1)}::date AND ${addDaysToDateKey(today, 1)}::date`,
        ),
      );
      const picked = pickRosterWindow(
        entries.map((row) => ({
          row,
          window: shiftWindow(row.shift, row.entry.workDate, timezone),
        })),
        now,
      );
      const late = picked === null ? 0 : lateMinutes(picked.window.start, now);

      let sessionId: string;
      try {
        const [created] = await uow.tx
          .insert(schema.shiftSession)
          .values({
            userId: principal.userId,
            shiftId: picked?.row.shift.id ?? null,
            rosterEntryId: picked?.row.entry.id ?? null,
            scheduledStart: picked?.window.start ?? null,
            scheduledEnd: picked?.window.end ?? null,
            clockedInAt: now,
            lateMinutes: late,
            device: input.device?.trim() ? input.device.trim() : null,
            locationConsent: input.locationConsent,
          })
          .returning({ id: schema.shiftSession.id });
        if (created === undefined) throw new Error('insert returned nothing');
        sessionId = created.id;
      } catch (error) {
        if (isPgError(error, PG.uniqueViolation)) throw conflict('You are already clocked in');
        throw error;
      }
      await this.audit.recordInTransaction(uow.tx, {
        actor: { type: 'user', id: principal.userId },
        action: AUDIT_ACTIONS.shiftClockIn,
        targetType: 'shift_session',
        targetId: sessionId,
        metadata: {
          onRoster: picked !== null,
          shiftId: picked?.row.shift.id ?? null,
          lateMinutes: late,
          late: late > SHIFT_LATE_GRACE_MINUTES,
          locationConsent: input.locationConsent,
        },
      });
      const [row] = await sessionQuery(uow.tx)
        .where(eq(schema.shiftSession.id, sessionId))
        .limit(1);
      if (row === undefined) throw new Error('session vanished');
      return toSession(row);
    });
  }

  /**
   * Clocks out (AC-7). Refused with 409 `handoff_incomplete` unless the handoff is confirmed and
   * every open P1/P2 ticket assigned to the person is in it with a next action. A lead or head
   * (`roster.manage`) may pass `override.reason` to clock out anyway; that and the missing items
   * are written to the audit log. `userId` clocks out someone else, which only a lead or head may.
   */
  async clockOut(principal: Principal, input: ClockOut): Promise<ClockOutResult> {
    const target = input.userId ?? principal.userId;
    const manager = principal.permissions.has('roster.manage');
    if (target !== principal.userId && !manager) {
      throw forbidden('Only a lead or head can clock someone else out');
    }
    if (input.override !== undefined && !manager) {
      throw forbidden('Only a lead or head can override an incomplete handoff');
    }
    return this.uow.run(async (uow) => {
      const [locked] = await uow.tx
        .select({ id: schema.shiftSession.id })
        .from(schema.shiftSession)
        .where(
          and(eq(schema.shiftSession.userId, target), isNull(schema.shiftSession.clockedOutAt)),
        )
        .for('update');
      if (locked === undefined) {
        throw conflict(
          target === principal.userId ? 'You are not clocked in' : 'That person is not clocked in',
        );
      }
      const gate = await this.handoffs.gate(uow.tx, target, locked.id);
      const blocked = !isGateOpen(gate);
      if (blocked && input.override === undefined) throw new HandoffIncompleteError(gate);

      const now = this.now();
      const overridden = blocked && input.override !== undefined;
      await uow.tx
        .update(schema.shiftSession)
        .set({
          clockedOutAt: now,
          ...(overridden
            ? { overrideBy: principal.userId, overrideReason: input.override?.reason ?? null }
            : {}),
        })
        .where(eq(schema.shiftSession.id, locked.id));
      await this.audit.recordInTransaction(uow.tx, {
        actor: { type: 'user', id: principal.userId },
        action: overridden ? AUDIT_ACTIONS.shiftClockOutOverride : AUDIT_ACTIONS.shiftClockOut,
        targetType: 'shift_session',
        targetId: locked.id,
        metadata: {
          userId: target,
          ...(overridden
            ? {
                reason: input.override?.reason,
                noConfirmedHandoff: gate.noConfirmedHandoff,
                blockers: gate.blockers,
              }
            : {}),
        },
      });
      const [row] = await sessionQuery(uow.tx)
        .where(eq(schema.shiftSession.id, locked.id))
        .limit(1);
      if (row === undefined) throw new Error('session vanished');
      return { session: toSession(row), overridden };
    });
  }

  /** "Mark brief read" (UI spec 9.2): stamps the open session. Safe to repeat. */
  async markBriefRead(principal: Principal): Promise<ShiftSession> {
    return this.uow.run(async (uow) => {
      const open = await openSessionOf(uow.tx, principal.userId);
      if (open === undefined) throw conflict('You are not clocked in');
      if (open.s.briefReadAt === null) {
        await uow.tx
          .update(schema.shiftSession)
          .set({ briefReadAt: this.now() })
          .where(eq(schema.shiftSession.id, open.s.id));
        await this.audit.recordInTransaction(uow.tx, {
          actor: { type: 'user', id: principal.userId },
          action: AUDIT_ACTIONS.shiftBriefRead,
          targetType: 'shift_session',
          targetId: open.s.id,
        });
      }
      const [row] = await sessionQuery(uow.tx)
        .where(eq(schema.shiftSession.id, open.s.id))
        .limit(1);
      if (row === undefined) throw new Error('session vanished');
      return toSession(row);
    });
  }

  // --- the lead's view ---

  /**
   * Who is on shift, who did not show up, and what the incoming shift has not acknowledged (AC-7:
   * "the lead's dashboard shows 0 unacknowledged items after acknowledgment"). A no-show is a
   * rostered shift whose start plus the grace period passed with nobody clocked in against it.
   * The alert to the lead itself (R-7.3, R-7.6) belongs to the notification task (T-105).
   */
  overview(): Promise<ShiftOverview> {
    return readShiftOverview(this.database.db, {
      now: this.now(),
      ticketKey: (number) => this.ticketKey(number),
    });
  }

  private ticketKey(number: number): string {
    return this.keys.format(number);
  }
}
