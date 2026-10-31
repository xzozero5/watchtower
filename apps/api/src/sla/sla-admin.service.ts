import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  DEFAULT_WEEKLY_HOURS,
  holidayRecordSchema,
  weeklyHoursSchema,
  type BusinessCalendarRecord,
  type HolidayRecord,
  type Holiday,
  type CreateBusinessCalendar,
  type CreateSlaPolicy,
  type SlaPolicy,
  type UpdateBusinessCalendar,
  type UpdateSlaPolicy,
} from '@watchtower/shared';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AuditScope } from '../audit/audit-scope.js';
import { badRequest, conflict, notFound } from '../auth/http-errors.js';
import { PG, isPgError, pgConstraint } from '../common/db-errors.js';
import { DATABASE } from '../database/database.module.js';
import type { DbTransaction } from '../realtime/unit-of-work.js';
import { targetsFromRow } from './sla.service.js';

type PolicyRow = typeof schema.slaPolicy.$inferSelect;
type CalendarRow = typeof schema.businessCalendar.$inferSelect;

const holidaysSchema = z.array(holidayRecordSchema);

function toApiPolicy(row: PolicyRow): SlaPolicy {
  return {
    id: row.id,
    name: row.name,
    tier: row.tier,
    targets: targetsFromRow(row),
    businessCalendarId: row.businessCalendarId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toApiCalendar(row: CalendarRow): BusinessCalendarRecord {
  const hours = weeklyHoursSchema.safeParse(row.hours);
  const holidays = holidaysSchema.safeParse(row.holidays);
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    hours: hours.success ? hours.data : DEFAULT_WEEKLY_HOURS,
    holidays: holidays.success ? holidays.data : [],
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const UNCHECKED = { checked: false, checkedAt: null, checkedBy: null } as const;

/**
 * Holidays as the caller sent them, with the check state they already had. A date that is new, or
 * whose name changed, starts unchecked: someone has to look at it again. A caller cannot send the
 * state itself (the input schema drops it); only `markHolidayChecked` sets it.
 */
function withCheckState(
  incoming: readonly Holiday[],
  existing: readonly HolidayRecord[],
): HolidayRecord[] {
  const before = new Map(existing.map((holiday) => [`${holiday.date}\n${holiday.name}`, holiday]));
  return incoming.map((holiday) => {
    const kept = before.get(`${holiday.date}\n${holiday.name}`);
    return kept === undefined
      ? { date: holiday.date, name: holiday.name, ...UNCHECKED }
      : { ...holiday, checked: kept.checked, checkedAt: kept.checkedAt, checkedBy: kept.checkedBy };
  });
}

/** Administration of SLA policies and business calendars (head, `sla.manage`). */
@Injectable()
export class SlaAdminService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  // --- policies ---

  async listPolicies(): Promise<SlaPolicy[]> {
    const rows = await this.database.db
      .select()
      .from(schema.slaPolicy)
      .orderBy(asc(schema.slaPolicy.name));
    return rows.map(toApiPolicy);
  }

  async getPolicy(id: string): Promise<SlaPolicy> {
    return toApiPolicy(await this.policyRow(id));
  }

  async createPolicy(input: CreateSlaPolicy): Promise<SlaPolicy> {
    try {
      const [row] = await this.database.db
        .insert(schema.slaPolicy)
        .values({
          name: input.name,
          tier: input.tier ?? null,
          targets: input.targets,
          businessCalendarId: input.businessCalendarId ?? null,
        })
        .returning();
      if (!row) throw new Error('sla policy insert returned no row');
      AuditScope.set({ targetType: 'sla_policy', targetId: row.id, after: toApiPolicy(row) });
      return toApiPolicy(row);
    } catch (error) {
      throw this.translatePolicy(error);
    }
  }

  async updatePolicy(id: string, patch: UpdateSlaPolicy): Promise<SlaPolicy> {
    const before = await this.policyRow(id);
    AuditScope.set({ targetType: 'sla_policy', targetId: id, before: toApiPolicy(before) });
    try {
      const [row] = await this.database.db
        .update(schema.slaPolicy)
        .set({
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.tier === undefined ? {} : { tier: patch.tier }),
          ...(patch.targets === undefined ? {} : { targets: patch.targets }),
          ...(patch.businessCalendarId === undefined
            ? {}
            : { businessCalendarId: patch.businessCalendarId }),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.slaPolicy.id, id))
        .returning();
      if (!row) throw notFound('No such SLA policy');
      AuditScope.set({ after: toApiPolicy(row) });
      return toApiPolicy(row);
    } catch (error) {
      throw this.translatePolicy(error);
    }
  }

  async removePolicy(id: string): Promise<void> {
    const before = await this.policyRow(id);
    AuditScope.set({ targetType: 'sla_policy', targetId: id, before: toApiPolicy(before) });
    try {
      await this.database.db.delete(schema.slaPolicy).where(eq(schema.slaPolicy.id, id));
    } catch (error) {
      if (isPgError(error, PG.foreignKeyViolation)) {
        throw conflict('Organizations or tickets use this SLA policy');
      }
      throw error;
    }
  }

  // --- calendars ---

  async listCalendars(): Promise<BusinessCalendarRecord[]> {
    const rows = await this.database.db
      .select()
      .from(schema.businessCalendar)
      .orderBy(asc(schema.businessCalendar.name));
    return rows.map(toApiCalendar);
  }

  async getCalendar(id: string): Promise<BusinessCalendarRecord> {
    return toApiCalendar(await this.calendarRow(id));
  }

  async createCalendar(input: CreateBusinessCalendar): Promise<BusinessCalendarRecord> {
    try {
      const row = await this.database.db.transaction(async (tx) => {
        if (input.isDefault) await this.clearDefault(tx, undefined);
        const [created] = await tx
          .insert(schema.businessCalendar)
          .values({
            name: input.name,
            timezone: input.timezone,
            hours: input.hours,
            holidays: withCheckState(input.holidays, []),
            isDefault: input.isDefault,
          })
          .returning();
        if (!created) throw new Error('calendar insert returned no row');
        return created;
      });
      AuditScope.set({
        targetType: 'business_calendar',
        targetId: row.id,
        after: { id: row.id, name: row.name, timezone: row.timezone, isDefault: row.isDefault },
      });
      return toApiCalendar(row);
    } catch (error) {
      throw this.translateCalendar(error);
    }
  }

  async updateCalendar(id: string, patch: UpdateBusinessCalendar): Promise<BusinessCalendarRecord> {
    const before = await this.calendarRow(id);
    AuditScope.set({
      targetType: 'business_calendar',
      targetId: id,
      before: { id, name: before.name, timezone: before.timezone, isDefault: before.isDefault },
    });
    try {
      const row = await this.database.db.transaction(async (tx) => {
        if (patch.isDefault === true) await this.clearDefault(tx, id);
        const [updated] = await tx
          .update(schema.businessCalendar)
          .set({
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
            ...(patch.hours === undefined ? {} : { hours: patch.hours }),
            ...(patch.holidays === undefined
              ? {}
              : { holidays: withCheckState(patch.holidays, toApiCalendar(before).holidays) }),
            ...(patch.isDefault === undefined ? {} : { isDefault: patch.isDefault }),
            updatedAt: sql`now()`,
          })
          .where(eq(schema.businessCalendar.id, id))
          .returning();
        if (!updated) throw notFound('No such calendar');
        return updated;
      });
      AuditScope.set({
        after: { id, name: row.name, timezone: row.timezone, isDefault: row.isDefault },
        metadata: { changedFields: Object.keys(patch) },
      });
      return toApiCalendar(row);
    } catch (error) {
      throw this.translateCalendar(error);
    }
  }

  /**
   * Marks one holiday as checked (or not) against the official announcement `[VERIFY]`, recording
   * who and when. The row is locked while it is read and written, so two heads checking different
   * dates of the same calendar do not overwrite each other.
   */
  async markHolidayChecked(
    id: string,
    date: string,
    checked: boolean,
    actorUserId: string,
  ): Promise<BusinessCalendarRecord> {
    const row = await this.database.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.businessCalendar)
        .where(eq(schema.businessCalendar.id, id))
        .for('update')
        .limit(1);
      if (!current) throw notFound('No such calendar');
      const holidays = toApiCalendar(current).holidays;
      const holiday = holidays.find((candidate) => candidate.date === date);
      if (!holiday) throw notFound('No holiday on this date in the calendar');
      AuditScope.set({
        targetType: 'business_calendar',
        targetId: id,
        before: { date, name: holiday.name, checked: holiday.checked },
      });
      const now = new Date();
      const next = holidays.map((candidate) =>
        candidate.date !== date
          ? candidate
          : {
              ...candidate,
              checked,
              checkedAt: checked ? now.toISOString() : null,
              checkedBy: checked ? actorUserId : null,
            },
      );
      const [updated] = await tx
        .update(schema.businessCalendar)
        .set({ holidays: next, updatedAt: sql`now()` })
        .where(eq(schema.businessCalendar.id, id))
        .returning();
      if (!updated) throw notFound('No such calendar');
      return updated;
    });
    AuditScope.set({ after: { date, checked }, metadata: { date, checked } });
    return toApiCalendar(row);
  }

  async removeCalendar(id: string): Promise<void> {
    const before = await this.calendarRow(id);
    AuditScope.set({
      targetType: 'business_calendar',
      targetId: id,
      before: { id, name: before.name, timezone: before.timezone },
    });
    try {
      await this.database.db
        .delete(schema.businessCalendar)
        .where(eq(schema.businessCalendar.id, id));
    } catch (error) {
      if (isPgError(error, PG.foreignKeyViolation)) {
        throw conflict('An SLA policy uses this calendar');
      }
      throw error;
    }
  }

  private async policyRow(id: string): Promise<PolicyRow> {
    const [row] = await this.database.db
      .select()
      .from(schema.slaPolicy)
      .where(eq(schema.slaPolicy.id, id))
      .limit(1);
    if (!row) throw notFound('No such SLA policy');
    return row;
  }

  private async calendarRow(id: string): Promise<CalendarRow> {
    const [row] = await this.database.db
      .select()
      .from(schema.businessCalendar)
      .where(eq(schema.businessCalendar.id, id))
      .limit(1);
    if (!row) throw notFound('No such calendar');
    return row;
  }

  private async clearDefault(tx: DbTransaction, except: string | undefined): Promise<void> {
    await tx
      .update(schema.businessCalendar)
      .set({ isDefault: false })
      .where(
        and(
          eq(schema.businessCalendar.isDefault, true),
          except ? ne(schema.businessCalendar.id, except) : undefined,
        ),
      );
  }

  private translatePolicy(error: unknown): unknown {
    if (isPgError(error, PG.uniqueViolation)) {
      return conflict('The name, or the tier, already has an SLA policy');
    }
    if (isPgError(error, PG.foreignKeyViolation)) {
      return pgConstraint(error) === 'sla_policy_tier_fkey'
        ? badRequest('tier is not a known tier')
        : badRequest('businessCalendarId does not refer to a calendar');
    }
    return error;
  }

  private translateCalendar(error: unknown): unknown {
    if (isPgError(error, PG.uniqueViolation))
      return conflict('A calendar with this name already exists');
    return error;
  }
}
