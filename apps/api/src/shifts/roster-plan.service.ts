import { Inject, Injectable } from '@nestjs/common';
import { explainRoster } from '@watchtower/ai';
import { schema, type Database } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  ROSTER_DEFAULT_RULES,
  ROSTER_PLAN_LIMITS,
  ROSTER_WEEK_DAYS,
  addDaysToDateKey,
  crossesMidnight,
  evaluateRoster,
  holidaySchema,
  localDateKeyOf,
  rosterAssignmentSchema,
  rosterPlanInputsSchema,
  rosterReportSchema,
  shiftWindow,
  solveRoster,
  suggestCoverage,
  weekdayOf,
  type ApplyRosterPlan,
  type ApplyRosterPlanResult,
  type CoverageRuleBody,
  type CreateRosterPlan,
  type EditRosterPlan,
  type ExplainRosterPlan,
  type RosterAssignmentBody,
  type RosterInput,
  type RosterPlan,
  type RosterPlanDefaults,
  type RosterPlanInputs,
  type RosterPlanList,
  type VolumePoint,
} from '@watchtower/shared';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AI_RUNTIME, type AiRuntime } from '../ai/ai-runtime.js';
import { AuditService } from '../audit/audit.service.js';
import { ApiHttpError, badRequest, conflict, notFound } from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import { DATABASE } from '../database/database.module.js';
import { UnitOfWorkService, type UnitOfWork } from '../realtime/unit-of-work.js';
import { buildExplainFacts, restoreNames } from './roster-plan-facts.js';
import { SHIFT_NOW, shiftTimezone, type ShiftNow } from './shift-core.js';
import { ShiftsService } from './shifts.service.js';

type Db = Pick<Database['db'], 'select' | 'execute'>;
type PlanRow = typeof schema.rosterPlan.$inferSelect;
type Assignment = RosterAssignmentBody;
type Shift = RosterPlanInputs['shifts'][number];
type Person = RosterPlanInputs['people'][number];

const MIN_MS = 60_000;
const entriesSchema = z.array(rosterAssignmentSchema);
const volumeSchema = z.array(z.object({ date: z.string(), minute: z.number(), count: z.number() }));

const keyOf = (entry: Assignment): string => `${entry.userId}|${entry.shiftId}|${entry.workDate}`;
const slotKey = (entry: { shiftId: string; workDate: string }): string =>
  `${entry.shiftId}|${entry.workDate}`;

interface Standing {
  /** Shifts the plan cannot move: before the week, started, with a clock-in, or of someone outside the plan. */
  readonly fixed: Assignment[];
  /** Shifts of people in the plan that have not started: applying replaces these. */
  readonly replaceable: (Assignment & { id: string })[];
}

/**
 * The roster planner (T-305e, PRD R-7.2). The deterministic solver is `solveRoster` of `@watchtower/shared`;
 * this is its Nest face: it gathers the inputs (people, queues, leave, shifts, the roster that already stands,
 * ticket volume), keeps the plan as a draft, re-checks it after every hand edit, and writes the roster only when
 * a lead or head applies it, through the roster service and its audit. The AI explains a plan (`explainRoster`,
 * redacted and audited) and never changes one.
 */
@Injectable()
export class RosterPlanService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ShiftsService) private readonly shifts: ShiftsService,
    @Inject(AI_RUNTIME) private readonly runtime: AiRuntime,
    @Inject(SHIFT_NOW) private readonly now: ShiftNow,
  ) {}

  // --- reads ---

  async list(): Promise<RosterPlanList> {
    const rows = await this.database.db
      .select({
        id: schema.rosterPlan.id,
        weekStart: schema.rosterPlan.weekStart,
        status: schema.rosterPlan.status,
        entryCount: sql<number>`jsonb_array_length(${schema.rosterPlan.entries})`,
        createdAt: schema.rosterPlan.createdAt,
        appliedAt: schema.rosterPlan.appliedAt,
      })
      .from(schema.rosterPlan)
      .orderBy(desc(schema.rosterPlan.createdAt))
      .limit(30);
    return {
      plans: rows.map((row) => ({
        id: row.id,
        weekStart: row.weekStart,
        status: z.enum(['draft', 'applied', 'discarded']).parse(row.status),
        entryCount: row.entryCount,
        createdAt: row.createdAt.toISOString(),
        appliedAt: row.appliedAt?.toISOString() ?? null,
      })),
    };
  }

  async get(id: string): Promise<RosterPlan> {
    const db = this.database.db;
    const row = await this.find(db, id);
    return this.present(db, row, await shiftTimezone(db), this.now());
  }

  /** What a new plan starts from: the people, the shifts, the rules and the coverage guessed from ticket volume. */
  async defaults(weekStart: string): Promise<RosterPlanDefaults> {
    const db = this.database.db;
    const timezone = await shiftTimezone(db);
    const base = await this.base(db, undefined);
    const coverage = await this.suggest(db, base.shifts, base.people.length, timezone, this.now());
    return {
      weekStart,
      timezone,
      people: base.people.map((person) => ({
        ...person,
        role: base.roles.get(person.id) ?? 'agent',
      })),
      queues: base.queues,
      shifts: base.shifts,
      rules: { ...ROSTER_DEFAULT_RULES },
      coverage,
      coverageSource: 'suggested',
      ticketsPerPersonPerShift: ROSTER_PLAN_LIMITS.defaultTicketsPerPersonPerShift,
    };
  }

  // --- writes ---

  async create(principal: Principal, body: CreateRosterPlan): Promise<RosterPlan> {
    const now = this.now();
    return this.uow.run(async (uow) => {
      const tx = uow.tx;
      const timezone = await shiftTimezone(tx);
      if (addDaysToDateKey(body.weekStart, ROSTER_WEEK_DAYS - 1) < localDateKeyOf(now, timezone)) {
        throw badRequest('That week is already over');
      }
      const base = await this.base(tx, body.userIds);
      if (body.userIds !== undefined) {
        const known = new Set(base.people.map((person) => person.id));
        if (body.userIds.some((id) => !known.has(id))) {
          throw badRequest('userIds must be active agents or leads');
        }
      }
      if (base.people.length === 0) throw badRequest('There is nobody to roster');
      if (base.shifts.length === 0) throw badRequest('No shift is active: define a shift first');

      const leave = new Map<string, Set<string>>();
      for (const item of body.unavailable ?? []) {
        if (!base.people.some((person) => person.id === item.userId)) {
          throw badRequest('unavailable refers to a person who is not in the plan');
        }
        const set = leave.get(item.userId) ?? new Set<string>();
        for (const date of item.dates) set.add(date);
        leave.set(item.userId, set);
      }
      const people: Person[] = base.people.map((person) => ({
        ...person,
        unavailable: [...(leave.get(person.id) ?? [])].sort(),
      }));

      let coverage: CoverageRuleBody[];
      let coverageSource: 'suggested' | 'given';
      if (body.coverage === undefined) {
        coverage = await this.suggest(tx, base.shifts, people.length, timezone, now);
        coverageSource = 'suggested';
      } else {
        const shiftIds = new Set(base.shifts.map((shift) => shift.id));
        const queueIds = new Set(base.queues.map((queue) => queue.id));
        for (const rule of body.coverage) {
          if (!shiftIds.has(rule.shiftId))
            throw badRequest('coverage names a shift that is not active');
          if (rule.queueId !== null && !queueIds.has(rule.queueId)) {
            throw badRequest('coverage names a queue that does not exist');
          }
        }
        coverage = body.coverage;
        coverageSource = 'given';
      }

      const personIds = new Set(people.map((person) => person.id));
      const standing = await this.standing(tx, body.weekStart, timezone, now, personIds);
      const calendarHolidays = await this.calendarHolidays(tx, body.weekStart);
      const inputs: RosterPlanInputs = {
        weekStart: body.weekStart,
        people,
        shifts: base.shifts,
        rules: {
          minRestHours: body.rules?.minRestHours ?? ROSTER_DEFAULT_RULES.minRestHours,
          maxShiftsPerWeek: body.rules?.maxShiftsPerWeek ?? ROSTER_DEFAULT_RULES.maxShiftsPerWeek,
          maxConsecutiveDays:
            body.rules?.maxConsecutiveDays ?? ROSTER_DEFAULT_RULES.maxConsecutiveDays,
          maxConsecutiveNights:
            body.rules?.maxConsecutiveNights ?? ROSTER_DEFAULT_RULES.maxConsecutiveNights,
        },
        coverage,
        coverageSource,
        fixed: standing.fixed,
        history: await this.history(tx, body.weekStart, personIds),
        holidays: [...new Set([...(body.holidays ?? []), ...calendarHolidays])].sort(),
      };

      const solution = solveRoster(
        this.solverInput(inputs, standing.fixed, this.frozen(inputs, timezone, now)),
      );
      const [row] = await tx
        .insert(schema.rosterPlan)
        .values({
          weekStart: body.weekStart,
          inputs,
          entries: solution.assignments,
          solverStatus: solution.status,
          solverNodes: solution.nodes,
          createdBy: principal.userId,
        })
        .returning();
      if (row === undefined) throw new Error('roster plan was not stored');
      await this.audit.recordInTransaction(tx, {
        actor: { type: 'user', id: principal.userId },
        action: AUDIT_ACTIONS.rosterPlanCreate,
        targetType: 'roster_plan',
        targetId: row.id,
        after: { weekStart: body.weekStart, entries: solution.assignments.length },
        metadata: {
          solver: solution.status,
          nodes: solution.nodes,
          coverageSource,
          people: people.length,
          hardOk: solution.report.hardOk,
          coverageOk: solution.report.coverageOk,
        },
      });
      return this.present(tx, row, timezone, now);
    });
  }

  /** A hand edit of a draft. The plan is checked again by the same rules; an explanation written before is dropped. */
  async edit(principal: Principal, id: string, body: EditRosterPlan): Promise<RosterPlan> {
    const now = this.now();
    return this.uow.run(async (uow) => {
      const tx = uow.tx;
      const row = await this.lock(tx, id);
      if (row.status !== 'draft') throw conflict(`A plan in status ${row.status} cannot be edited`);
      const timezone = await shiftTimezone(tx);
      const inputs = rosterPlanInputsSchema.parse(row.inputs);
      const current = entriesSchema.parse(row.entries);
      const people = new Set(inputs.people.map((person) => person.id));
      const shifts = new Set(inputs.shifts.map((shift) => shift.id));
      const frozen = new Set(this.frozen(inputs, timezone, now).map(slotKey));
      const last = addDaysToDateKey(inputs.weekStart, ROSTER_WEEK_DAYS - 1);

      const present = new Set(current.map(keyOf));
      for (const entry of body.remove) {
        if (!present.has(keyOf(entry))) throw badRequest('A shift to remove is not in the plan');
      }
      for (const entry of body.add) {
        if (!people.has(entry.userId)) throw badRequest('A person to add is not in the plan');
        if (!shifts.has(entry.shiftId)) throw badRequest('A shift to add is not active');
        if (entry.workDate < inputs.weekStart || entry.workDate > last) {
          throw badRequest('A shift to add is outside the planned week');
        }
        if (frozen.has(slotKey(entry))) throw badRequest('A shift to add has already started');
      }
      const removed = new Set(body.remove.map(keyOf));
      const next = new Map(
        current.filter((entry) => !removed.has(keyOf(entry))).map((e) => [keyOf(e), e]),
      );
      for (const entry of body.add) next.set(keyOf(entry), entry);
      const entries = [...next.values()].sort(
        (a, b) =>
          a.workDate.localeCompare(b.workDate) ||
          a.shiftId.localeCompare(b.shiftId) ||
          a.userId.localeCompare(b.userId),
      );
      const [updated] = await tx
        .update(schema.rosterPlan)
        .set({
          entries,
          explanation: null,
          explanationLocale: null,
          explanationPromptVersion: null,
          explanationRunId: null,
          explanationAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.rosterPlan.id, id))
        .returning();
      if (updated === undefined) throw notFound('No such roster plan');
      await this.audit.recordInTransaction(tx, {
        actor: { type: 'user', id: principal.userId },
        action: AUDIT_ACTIONS.rosterPlanEdit,
        targetType: 'roster_plan',
        targetId: id,
        before: { entries: current.length },
        after: { entries: entries.length },
        metadata: { added: body.add.length, removed: body.remove.length },
      });
      return this.present(tx, updated, timezone, now);
    });
  }

  /** Asks the roster planner agent to explain the plan. 503 when the AI is off or offline; the plan is unaffected. */
  async explain(principal: Principal, id: string, body: ExplainRosterPlan): Promise<RosterPlan> {
    const db = this.database.db;
    const row = await this.find(db, id);
    if (row.status !== 'draft') throw conflict(`A plan in status ${row.status} is not explained`);
    if (!this.runtime.ready)
      throw unavailable(503, this.runtime.notReadyReason ?? 'provider_unavailable');
    const timezone = await shiftTimezone(db);
    const now = this.now();
    const plan = await this.present(db, row, timezone, now);
    const { facts, names } = buildExplainFacts(plan);

    const outcome = await explainRoster(this.runtime.deps, {
      planId: id,
      locale: body.locale,
      facts,
    });
    if (outcome.status === 'skipped') throw unavailable(503, outcome.reason);
    if (outcome.status === 'failed') {
      throw unavailable(outcome.reason === 'model_output_invalid' ? 502 : 503, outcome.reason);
    }
    const text = restoreNames(outcome.value.explanation, names);

    return this.uow.run(async (uow) => {
      const tx = uow.tx;
      const fresh = await this.lock(tx, id);
      if (fresh.status !== 'draft' || fresh.updatedAt.getTime() !== row.updatedAt.getTime()) {
        throw conflict('The plan changed while the explanation was written: ask again');
      }
      const [updated] = await tx
        .update(schema.rosterPlan)
        .set({
          explanation: text,
          explanationLocale: body.locale,
          explanationPromptVersion: outcome.value.promptVersion,
          explanationRunId: outcome.runId,
          explanationAt: sql`now()`,
        })
        .where(eq(schema.rosterPlan.id, id))
        .returning();
      if (updated === undefined) throw notFound('No such roster plan');
      await this.audit.recordInTransaction(tx, {
        actor: { type: 'user', id: principal.userId },
        action: AUDIT_ACTIONS.rosterPlanExplain,
        targetType: 'roster_plan',
        targetId: id,
        metadata: {
          locale: body.locale,
          promptVersion: outcome.value.promptVersion,
          aiRunId: outcome.runId,
        },
      });
      return this.present(tx, updated, timezone, now);
    });
  }

  /**
   * Writes the plan to the roster. Only a person does this (the route needs `roster.manage`), never a shift that
   * has started, and the plan is checked once more against the roster as it is now: a broken hard rule refuses it;
   * a shortfall needs `acceptShortfall`. Shifts are written and removed through `ShiftsService`, one audit row each.
   */
  async apply(
    principal: Principal,
    id: string,
    body: ApplyRosterPlan,
  ): Promise<ApplyRosterPlanResult> {
    const now = this.now();
    return this.uow.run(async (uow) => {
      const tx = uow.tx;
      const row = await this.lock(tx, id);
      if (row.status !== 'draft')
        throw conflict(`A plan in status ${row.status} cannot be applied`);
      const timezone = await shiftTimezone(tx);
      const inputs = rosterPlanInputsSchema.parse(row.inputs);
      const planned = entriesSchema.parse(row.entries);
      const personIds = new Set(inputs.people.map((person) => person.id));
      const standing = await this.standing(tx, inputs.weekStart, timezone, now, personIds);
      const frozen = this.frozen(inputs, timezone, now);
      const frozenKeys = new Set(frozen.map(slotKey));

      const started = planned.filter((entry) => frozenKeys.has(slotKey(entry)));
      if (started.length > 0) {
        throw conflict(
          `${String(started.length)} planned shift(s) have already started: remove them from the plan first`,
        );
      }
      const report = evaluateRoster(this.solverInput(inputs, standing.fixed, frozen), planned);
      if (!report.hardOk) {
        throw conflict(
          'The plan breaks a rule (rest, leave, shift limits): fix it before applying',
        );
      }
      if (!report.coverageOk && !body.acceptShortfall) {
        throw conflict(
          'Some shifts have fewer people than needed: apply with acceptShortfall to accept that',
        );
      }

      const plannedKeys = new Set(planned.map(keyOf));
      const standingKeys = new Set([...standing.replaceable, ...standing.fixed].map(keyOf));
      const toRemove = standing.replaceable.filter((entry) => !plannedKeys.has(keyOf(entry)));
      const toAdd = planned.filter((entry) => !standingKeys.has(keyOf(entry)));
      for (const entry of toRemove) await this.shifts.removeRoster(principal, entry.id, uow);
      for (const entry of toAdd) await this.shifts.assignRoster(principal, entry, uow);

      const [updated] = await tx
        .update(schema.rosterPlan)
        .set({
          status: 'applied',
          appliedBy: principal.userId,
          appliedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.rosterPlan.id, id))
        .returning();
      if (updated === undefined) throw notFound('No such roster plan');
      await this.audit.recordInTransaction(tx, {
        actor: { type: 'user', id: principal.userId },
        action: AUDIT_ACTIONS.rosterPlanApply,
        targetType: 'roster_plan',
        targetId: id,
        before: { status: 'draft' },
        after: { status: 'applied' },
        metadata: {
          weekStart: inputs.weekStart,
          added: toAdd.length,
          removed: toRemove.length,
          acceptedShortfall: !report.coverageOk,
        },
      });
      return {
        plan: await this.present(tx, updated, timezone, now),
        added: toAdd.length,
        removed: toRemove.length,
      };
    });
  }

  async discard(principal: Principal, id: string): Promise<RosterPlan> {
    const now = this.now();
    return this.uow.run(async (uow) => {
      const tx = uow.tx;
      const row = await this.lock(tx, id);
      if (row.status !== 'draft')
        throw conflict(`A plan in status ${row.status} cannot be discarded`);
      const [updated] = await tx
        .update(schema.rosterPlan)
        .set({ status: 'discarded', updatedAt: sql`now()` })
        .where(eq(schema.rosterPlan.id, id))
        .returning();
      if (updated === undefined) throw notFound('No such roster plan');
      await this.audit.recordInTransaction(tx, {
        actor: { type: 'user', id: principal.userId },
        action: AUDIT_ACTIONS.rosterPlanDiscard,
        targetType: 'roster_plan',
        targetId: id,
        before: { status: 'draft' },
        after: { status: 'discarded' },
      });
      return this.present(tx, updated, await shiftTimezone(tx), now);
    });
  }

  // --- inputs ---

  private async find(db: Db, id: string): Promise<PlanRow> {
    const [row] = await db
      .select()
      .from(schema.rosterPlan)
      .where(eq(schema.rosterPlan.id, id))
      .limit(1);
    if (row === undefined) throw notFound('No such roster plan');
    return row;
  }

  private async lock(tx: UnitOfWork['tx'], id: string): Promise<PlanRow> {
    const [row] = await tx
      .select()
      .from(schema.rosterPlan)
      .where(eq(schema.rosterPlan.id, id))
      .for('update')
      .limit(1);
    if (row === undefined) throw notFound('No such roster plan');
    return row;
  }

  /** The people who can be rostered (active agents and leads), their queues, and the active shifts. */
  private async base(db: Db, userIds: readonly string[] | undefined) {
    const shifts: Shift[] = (
      await db
        .select()
        .from(schema.shiftDefinition)
        .where(eq(schema.shiftDefinition.active, true))
        .orderBy(schema.shiftDefinition.startsAt, schema.shiftDefinition.name)
    ).map((row) => ({
      id: row.id,
      name: row.name,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      onCall: row.onCall,
    }));
    const users = await db
      .select({ id: schema.users.id, name: schema.users.name, role: schema.users.role })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.status, 'active'),
          inArray(schema.users.role, ['agent', 'lead']),
          userIds === undefined ? undefined : inArray(schema.users.id, [...userIds]),
        ),
      )
      .orderBy(schema.users.name, schema.users.id);
    const queues = await db
      .select({ id: schema.teamQueue.id, name: schema.teamQueue.name })
      .from(schema.teamQueue)
      .orderBy(schema.teamQueue.name);
    const members = await db
      .select({ queueId: schema.teamQueueMember.queueId, userId: schema.teamQueueMember.userId })
      .from(schema.teamQueueMember);
    const roles = new Map(users.map((user) => [user.id, user.role]));
    const people = users.map((user) => ({
      id: user.id,
      name: user.name,
      queueIds: members
        .filter((member) => member.userId === user.id)
        .map((member) => member.queueId),
      unavailable: [] as string[],
    }));
    return { shifts, people, queues, roles };
  }

  /** How many people each shift needs, guessed from the tickets of the past weeks `[ASSUMED]`; the lead edits it. */
  private async suggest(
    db: Db,
    shifts: readonly Shift[],
    peopleCount: number,
    timezone: string,
    now: Date,
  ): Promise<CoverageRuleBody[]> {
    const since = new Date(now.getTime() - ROSTER_PLAN_LIMITS.volumeDays * 24 * 60 * MIN_MS);
    const local = sql`(${schema.ticket.createdAt} AT TIME ZONE ${timezone})`;
    const result = await db.execute(sql`
      SELECT to_char(${local}, 'YYYY-MM-DD') AS date,
             (extract(hour FROM ${local}) * 60 + extract(minute FROM ${local}))::int AS minute,
             count(*)::int AS count
      FROM ticket
      WHERE ${schema.ticket.createdAt} >= ${since.toISOString()}::timestamptz
        AND ${schema.ticket.createdAt} < ${now.toISOString()}::timestamptz
      GROUP BY 1, 2`);
    const volume: VolumePoint[] = volumeSchema.parse(result.rows);
    return suggestCoverage(shifts, volume, {
      days: ROSTER_PLAN_LIMITS.volumeDays,
      ticketsPerPersonPerShift: ROSTER_PLAN_LIMITS.defaultTicketsPerPersonPerShift,
      minimum: 1,
      maximum: Math.max(1, Math.min(6, peopleCount)),
    }).map((rule) => ({ ...rule, weekdays: [...rule.weekdays] }));
  }

  private async calendarHolidays(db: Db, weekStart: string): Promise<string[]> {
    const [calendar] = await db
      .select({ holidays: schema.businessCalendar.holidays })
      .from(schema.businessCalendar)
      .where(eq(schema.businessCalendar.isDefault, true))
      .limit(1);
    const parsed = holidaySchema.array().safeParse(calendar?.holidays ?? []);
    if (!parsed.success) return [];
    const last = addDaysToDateKey(weekStart, ROSTER_WEEK_DAYS - 1);
    return parsed.data
      .map((holiday) => holiday.date)
      .filter((date) => date >= weekStart && date <= last);
  }

  /** The roster around the week: what the plan cannot move, and what applying would replace. */
  private async standing(
    db: Db,
    weekStart: string,
    timezone: string,
    now: Date,
    personIds: ReadonlySet<string>,
  ): Promise<Standing> {
    const rows = await db
      .select({
        id: schema.rosterEntry.id,
        userId: schema.rosterEntry.userId,
        shiftId: schema.rosterEntry.shiftId,
        workDate: schema.rosterEntry.workDate,
        startsAt: schema.shiftDefinition.startsAt,
        endsAt: schema.shiftDefinition.endsAt,
      })
      .from(schema.rosterEntry)
      .innerJoin(schema.shiftDefinition, eq(schema.shiftDefinition.id, schema.rosterEntry.shiftId))
      .where(
        and(
          sql`${schema.rosterEntry.workDate} >= ${addDaysToDateKey(weekStart, -8)}::date`,
          sql`${schema.rosterEntry.workDate} <= ${addDaysToDateKey(weekStart, ROSTER_WEEK_DAYS - 1)}::date`,
        ),
      );
    const clocked = new Set<string>();
    if (rows.length > 0) {
      const sessions = await db
        .select({ id: schema.shiftSession.rosterEntryId })
        .from(schema.shiftSession)
        .where(
          and(
            isNotNull(schema.shiftSession.rosterEntryId),
            inArray(
              schema.shiftSession.rosterEntryId,
              rows.map((row) => row.id),
            ),
          ),
        );
      for (const session of sessions) if (session.id !== null) clocked.add(session.id);
    }
    const fixed: Assignment[] = [];
    const replaceable: Standing['replaceable'] = [];
    for (const row of rows) {
      const entry = { userId: row.userId, shiftId: row.shiftId, workDate: row.workDate };
      if (row.workDate < weekStart) {
        fixed.push(entry);
        continue;
      }
      const started =
        shiftWindow(row, row.workDate, timezone).start.getTime() <=
        now.getTime() + ROSTER_PLAN_LIMITS.startedGraceMinutes * MIN_MS;
      if (started || clocked.has(row.id) || !personIds.has(row.userId)) fixed.push(entry);
      else replaceable.push({ ...entry, id: row.id });
    }
    return { fixed, replaceable };
  }

  /** Nights and weekend shifts each person worked in the past weeks, so the fairness carries over. */
  private async history(
    db: Db,
    weekStart: string,
    personIds: ReadonlySet<string>,
  ): Promise<RosterPlanInputs['history']> {
    const rows = await db
      .select({
        userId: schema.rosterEntry.userId,
        workDate: schema.rosterEntry.workDate,
        startsAt: schema.shiftDefinition.startsAt,
        endsAt: schema.shiftDefinition.endsAt,
      })
      .from(schema.rosterEntry)
      .innerJoin(schema.shiftDefinition, eq(schema.shiftDefinition.id, schema.rosterEntry.shiftId))
      .where(
        and(
          sql`${schema.rosterEntry.workDate} >= ${addDaysToDateKey(weekStart, -7 * ROSTER_PLAN_LIMITS.historyWeeks)}::date`,
          sql`${schema.rosterEntry.workDate} < ${weekStart}::date`,
        ),
      );
    const history: Record<string, { nights: number; heavyDays: number }> = {};
    for (const row of rows) {
      if (!personIds.has(row.userId)) continue;
      const load = (history[row.userId] ??= { nights: 0, heavyDays: 0 });
      if (crossesMidnight(row)) load.nights += 1;
      const weekday = weekdayOf(row.workDate);
      if (weekday === 0 || weekday === 6) load.heavyDays += 1;
    }
    return history;
  }

  /** Slots of the week whose shift has started (or starts within the early clock-in window). */
  private frozen(
    inputs: RosterPlanInputs,
    timezone: string,
    now: Date,
  ): { shiftId: string; workDate: string }[] {
    const limit = now.getTime() + ROSTER_PLAN_LIMITS.startedGraceMinutes * MIN_MS;
    const out: { shiftId: string; workDate: string }[] = [];
    for (let day = 0; day < ROSTER_WEEK_DAYS; day += 1) {
      const workDate = addDaysToDateKey(inputs.weekStart, day);
      for (const shift of inputs.shifts) {
        if (shiftWindow(shift, workDate, timezone).start.getTime() <= limit) {
          out.push({ shiftId: shift.id, workDate });
        }
      }
    }
    return out;
  }

  private solverInput(
    inputs: RosterPlanInputs,
    fixed: readonly Assignment[],
    frozen: readonly { shiftId: string; workDate: string }[],
  ): RosterInput {
    return {
      weekStart: inputs.weekStart,
      people: inputs.people,
      shifts: inputs.shifts,
      rules: inputs.rules,
      coverage: inputs.coverage,
      fixed,
      history: inputs.history,
      holidays: inputs.holidays,
      frozen,
    };
  }

  // --- view ---

  private async present(db: Db, row: PlanRow, timezone: string, now: Date): Promise<RosterPlan> {
    const inputs = rosterPlanInputsSchema.parse(row.inputs);
    const planned = entriesSchema.parse(row.entries);
    const draft = row.status === 'draft';
    const personIds = new Set(inputs.people.map((person) => person.id));
    // A draft is judged against the roster as it is now; a plan that was applied or discarded, as it was made.
    const standing: Standing = draft
      ? await this.standing(db, inputs.weekStart, timezone, now, personIds)
      : { fixed: inputs.fixed, replaceable: [] };
    const frozen = this.frozen(inputs, timezone, now);
    const frozenKeys = new Set(frozen.map(slotKey));
    const report = evaluateRoster(this.solverInput(inputs, standing.fixed, frozen), planned);

    const last = addDaysToDateKey(inputs.weekStart, ROSTER_WEEK_DAYS - 1);
    const lockedEntries = standing.fixed.filter(
      (entry) => entry.workDate >= inputs.weekStart && entry.workDate <= last,
    );
    const userIds = [...new Set([...planned, ...lockedEntries].map((entry) => entry.userId))];
    const names = new Map<string, string>(inputs.people.map((person) => [person.id, person.name]));
    const unknown = userIds.filter((userId) => !names.has(userId));
    if (unknown.length > 0) {
      const rows = await db
        .select({ id: schema.users.id, name: schema.users.name })
        .from(schema.users)
        .where(inArray(schema.users.id, unknown));
      for (const user of rows) names.set(user.id, user.name);
    }
    const shiftNames = new Map(inputs.shifts.map((shift) => [shift.id, shift.name]));
    const unknownShifts = [...new Set(lockedEntries.map((entry) => entry.shiftId))].filter(
      (shiftId) => !shiftNames.has(shiftId),
    );
    if (unknownShifts.length > 0) {
      const rows = await db
        .select({ id: schema.shiftDefinition.id, name: schema.shiftDefinition.name })
        .from(schema.shiftDefinition)
        .where(inArray(schema.shiftDefinition.id, unknownShifts));
      for (const shift of rows) shiftNames.set(shift.id, shift.name);
    }
    const toView = (entry: Assignment, locked: boolean) => ({
      userId: entry.userId,
      userName: names.get(entry.userId) ?? '',
      shiftId: entry.shiftId,
      shiftName: shiftNames.get(entry.shiftId) ?? '',
      workDate: entry.workDate,
      locked,
    });

    const replaceableKeys = new Set(standing.replaceable.map(keyOf));
    const plannedKeys = new Set(planned.map(keyOf));
    const fixedKeys = new Set(standing.fixed.map(keyOf));
    return {
      id: row.id,
      weekStart: inputs.weekStart,
      status: z.enum(['draft', 'applied', 'discarded']).parse(row.status),
      timezone,
      entries: [
        ...lockedEntries.map((e) => toView(e, true)),
        ...planned.map((e) => toView(e, false)),
      ].sort(
        (a, b) =>
          a.workDate.localeCompare(b.workDate) ||
          a.shiftName.localeCompare(b.shiftName) ||
          a.userName.localeCompare(b.userName),
      ),
      inputs,
      report: rosterReportSchema.parse(report),
      solver: {
        status: z.enum(['complete', 'no_solution', 'unproven']).parse(row.solverStatus),
        nodes: row.solverNodes,
      },
      explanation:
        row.explanation === null ||
        row.explanationLocale === null ||
        row.explanationPromptVersion === null ||
        row.explanationAt === null
          ? null
          : {
              text: row.explanation,
              locale: z.enum(['th', 'en']).parse(row.explanationLocale),
              promptVersion: row.explanationPromptVersion,
              createdAt: row.explanationAt.toISOString(),
            },
      diff: draft
        ? {
            add: planned.filter((e) => !replaceableKeys.has(keyOf(e)) && !fixedKeys.has(keyOf(e)))
              .length,
            remove: standing.replaceable.filter((e) => !plannedKeys.has(keyOf(e))).length,
            keep: planned.filter((e) => replaceableKeys.has(keyOf(e))).length,
            locked: lockedEntries.length,
            started: planned.filter((e) => frozenKeys.has(slotKey(e))).length,
          }
        : { add: 0, remove: 0, keep: 0, locked: lockedEntries.length, started: 0 },
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      appliedAt: row.appliedAt?.toISOString() ?? null,
    };
  }
}

function unavailable(status: 502 | 503, reason: string): ApiHttpError {
  return new ApiHttpError(
    status,
    'ai_unavailable',
    status === 502
      ? `The explanation did not fit the expected form (${reason}): try again; the plan is not affected`
      : `The AI is not available (${reason}): the plan is complete without the explanation, try later`,
  );
}
