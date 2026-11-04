/**
 * Roster planner solver (T-305e, PRD R-7.2). Deterministic and dependency-free: no model decides anything here,
 * and the same input always gives the same plan. The AI only explains a plan afterwards (`roster_planner` agent).
 *
 * Time model: a shift is a local wall-clock window; the week is seven local dates from `weekStart`. Times are
 * handled as minutes from local midnight of `weekStart` and a zone without daylight saving is assumed for the
 * arithmetic of rest between shifts `[ASSUMED]` (the default zone of the project has none).
 *
 * Hard rules (never broken by the solver): a person is not given a shift that overlaps a day they are
 * unavailable, the rest between two shifts is at least `minRestHours`, at most `maxShiftsPerWeek` shifts per week,
 * at most `maxConsecutiveDays` working days in a row, at most `maxConsecutiveNights` night shifts in a row.
 * Coverage (the number of people each shift needs) is a goal the solver tries to meet in full with a bounded
 * exhaustive search; when it cannot, it says so, whether the search proved no plan exists, and why each short slot
 * is short. Fairness of nights and heavy days (weekend or holiday) is soft: a local search evens it out.
 */
import { addDaysToDateKey, minutesOfDay } from './sla.js';

const DAY_MINUTES = 1440;
export const ROSTER_WEEK_DAYS = 7;
/** Shifts further back than this are ignored (they cannot touch the week through the rules above). */
const CONTEXT_DAYS = 8;
/** Nodes of the exhaustive search before the solver settles for the best plan it has. */
export const ROSTER_SEARCH_NODE_LIMIT = 2_000;
const LOCAL_SEARCH_PASSES = 30;

export const ROSTER_DEFAULT_RULES = {
  minRestHours: 11,
  maxShiftsPerWeek: 5,
  maxConsecutiveDays: 6,
  maxConsecutiveNights: 3,
} as const;

export interface RosterRules {
  readonly minRestHours: number;
  readonly maxShiftsPerWeek: number;
  readonly maxConsecutiveDays: number;
  readonly maxConsecutiveNights: number;
}

export interface RosterShift {
  readonly id: string;
  readonly name: string;
  /** Local `HH:MM`. An end that is not after the start means the shift ends the next day. */
  readonly startsAt: string;
  readonly endsAt: string;
  readonly onCall: boolean;
}

export interface RosterPerson {
  readonly id: string;
  readonly name: string;
  /** Queues the person belongs to (the skill a coverage rule can ask for). */
  readonly queueIds: readonly string[];
  /** Local dates (`YYYY-MM-DD`) of leave or not available. */
  readonly unavailable: readonly string[];
}

export interface CoverageRule {
  readonly shiftId: string;
  /** Weekdays the rule applies to, 0 = Sunday to 6 = Saturday; empty = every day. */
  readonly weekdays: readonly number[];
  /** People needed on that shift on those days. */
  readonly required: number;
  /** When set, that many of them must belong to this queue. */
  readonly queueId: string | null;
}

export interface RosterAssignment {
  readonly userId: string;
  readonly shiftId: string;
  /** The local date the shift starts on. */
  readonly workDate: string;
}

export interface FairnessHistory {
  readonly nights: number;
  readonly heavyDays: number;
}

export interface RosterInput {
  /** First local date of the week (`YYYY-MM-DD`). */
  readonly weekStart: string;
  readonly people: readonly RosterPerson[];
  readonly shifts: readonly RosterShift[];
  readonly rules: RosterRules;
  readonly coverage: readonly CoverageRule[];
  /**
   * Shifts that already stand and cannot be moved: those that started, plus the days before the week (they
   * count for rest and consecutive days). They count toward coverage but are not part of the plan.
   */
  readonly fixed: readonly RosterAssignment[];
  /** Recent nights and heavy days per person (a few weeks back), so the fairness carries over. */
  readonly history: Readonly<Record<string, FairnessHistory>>;
  /** Local dates that count as heavy days besides Saturday and Sunday. */
  readonly holidays: readonly string[];
  /**
   * Slots that are past planning (the shift has started): the solver does not plan them and coverage does not
   * ask for them. The shifts that stand there are in `fixed`.
   */
  readonly frozen?: readonly { readonly shiftId: string; readonly workDate: string }[];
}

export type RosterViolationCode =
  | 'unavailable'
  | 'overlap'
  | 'rest'
  | 'max_shifts_week'
  | 'max_consecutive_days'
  | 'max_consecutive_nights';

export interface RosterFailure {
  readonly code: string;
  readonly userId: string | null;
  readonly shiftId: string | null;
  readonly workDate: string | null;
  /** English fallback; the UI translates by `code` and `params`. */
  readonly message: string;
  readonly params: Readonly<Record<string, number | string>>;
}

export type RosterReportItemId =
  | 'unavailable'
  | 'rest'
  | 'max_shifts_week'
  | 'max_consecutive_days'
  | 'max_consecutive_nights'
  | 'coverage'
  | 'fairness_nights'
  | 'fairness_heavy_days';

export interface RosterReportItem {
  readonly id: RosterReportItemId;
  readonly kind: 'hard' | 'coverage' | 'fairness';
  readonly status: 'pass' | 'fail';
  readonly message: string;
  readonly failures: readonly RosterFailure[];
}

export interface RosterLoad {
  readonly userId: string;
  readonly shifts: number;
  readonly nights: number;
  readonly heavyDays: number;
}

export interface RosterReport {
  /** Every hard rule holds. */
  readonly hardOk: boolean;
  /** Every coverage rule is met. */
  readonly coverageOk: boolean;
  readonly items: readonly RosterReportItem[];
  readonly loads: readonly RosterLoad[];
}

export type RosterSolveStatus = 'complete' | 'no_solution' | 'unproven';

export interface RosterSolution {
  /** The planned shifts (without `fixed`). */
  readonly assignments: readonly RosterAssignment[];
  /**
   * `complete`: every coverage rule is met. `no_solution`: the search was exhaustive and proved that no plan meets
   * them all (the plan is the best found). `unproven`: the search hit its limit; a plan may exist.
   */
  readonly status: RosterSolveStatus;
  readonly nodes: number;
  readonly report: RosterReport;
}

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

interface ShiftInfo {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly startMin: number;
  readonly durationMin: number;
  readonly night: boolean;
}

interface Slot {
  readonly userId: string;
  readonly day: number;
  readonly shift: number;
}

interface Violation {
  readonly key: string;
  readonly code: RosterViolationCode;
  readonly day: number;
  readonly shift: number | null;
}

interface Unit {
  readonly day: number;
  readonly shift: number;
  readonly queueId: string | null;
}

interface Context {
  readonly input: RosterInput;
  readonly shifts: readonly ShiftInfo[];
  readonly shiftIndex: ReadonlyMap<string, number>;
  readonly people: ReadonlyMap<string, RosterPerson>;
  readonly order: readonly string[];
  readonly unavailableDays: ReadonlyMap<string, ReadonlySet<number>>;
  readonly heavy: readonly boolean[];
  /** `day:shift` of the slots that are frozen. */
  readonly frozen: ReadonlySet<string>;
  readonly fixed: readonly Slot[];
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`). */
export function dayDifference(from: string, to: string): number {
  const parse = (key: string): number => {
    const [year = 0, month = 1, day = 1] = key.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((parse(to) - parse(from)) / (DAY_MINUTES * 60_000));
}

/** 0 = Sunday to 6 = Saturday. */
export function weekdayOf(key: string): number {
  const [year = 0, month = 1, day = 1] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function shiftInfo(shift: RosterShift, index: number): ShiftInfo {
  const startMin = minutesOfDay(shift.startsAt);
  const endMin = minutesOfDay(shift.endsAt);
  const overnight = endMin <= startMin;
  return {
    index,
    id: shift.id,
    name: shift.name,
    startMin,
    durationMin: overnight ? endMin + DAY_MINUTES - startMin : endMin - startMin,
    night: overnight,
  };
}

function prepare(input: RosterInput): Context {
  const shifts = input.shifts.map(shiftInfo);
  const shiftIndex = new Map(shifts.map((shift) => [shift.id, shift.index]));
  const people = new Map(input.people.map((person) => [person.id, person]));
  const holidays = new Set(input.holidays);
  const heavy = Array.from({ length: ROSTER_WEEK_DAYS }, (_unused, day) => {
    const key = addDaysToDateKey(input.weekStart, day);
    const weekday = weekdayOf(key);
    return weekday === 0 || weekday === 6 || holidays.has(key);
  });
  const unavailableDays = new Map<string, ReadonlySet<number>>();
  for (const person of input.people) {
    unavailableDays.set(
      person.id,
      new Set(
        person.unavailable
          .map((key) => dayDifference(input.weekStart, key))
          .filter((day) => day >= -CONTEXT_DAYS && day <= ROSTER_WEEK_DAYS + 1),
      ),
    );
  }
  const fixed: Slot[] = [];
  for (const entry of input.fixed) {
    const shift = shiftIndex.get(entry.shiftId);
    const day = dayDifference(input.weekStart, entry.workDate);
    if (shift === undefined || day < -CONTEXT_DAYS || day >= ROSTER_WEEK_DAYS) continue;
    fixed.push({ userId: entry.userId, day, shift });
  }
  return {
    input,
    shifts,
    shiftIndex,
    people,
    order: [...input.people.map((person) => person.id)].sort(),
    unavailableDays,
    heavy,
    frozen: new Set(
      (input.frozen ?? []).flatMap((slot) => {
        const shift = shiftIndex.get(slot.shiftId);
        return shift === undefined
          ? []
          : [`${String(dayDifference(input.weekStart, slot.workDate))}:${String(shift)}`];
      }),
    ),
    fixed,
  };
}

const startOf = (ctx: Context, slot: Slot): number =>
  slot.day * DAY_MINUTES + (ctx.shifts[slot.shift]?.startMin ?? 0);
const endOf = (ctx: Context, slot: Slot): number =>
  startOf(ctx, slot) + (ctx.shifts[slot.shift]?.durationMin ?? 0);
const inWeek = (slot: Slot): boolean => slot.day >= 0 && slot.day < ROSTER_WEEK_DAYS;

/** Runs of consecutive days in a sorted list of distinct days. */
function runsOf(days: readonly number[]): { start: number; length: number }[] {
  const runs: { start: number; length: number }[] = [];
  for (const day of days) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.start + last.length === day) last.length += 1;
    else runs.push({ start: day, length: 1 });
  }
  return runs;
}

/**
 * Everything wrong with the shifts of one person that involves the week. People outside `input.people` (someone
 * rostered by hand who is not in the plan) have no rules here: they only count toward coverage.
 */
function personViolations(ctx: Context, userId: string, slots: readonly Slot[]): Violation[] {
  if (!ctx.people.has(userId)) return [];
  const rules = ctx.input.rules;
  const rest = rules.minRestHours * 60;
  const sorted = [...slots].sort((a, b) => startOf(ctx, a) - startOf(ctx, b) || a.shift - b.shift);
  const out: Violation[] = [];

  const unavailable = ctx.unavailableDays.get(userId) ?? new Set<number>();
  for (const slot of sorted) {
    if (!inWeek(slot)) continue;
    const start = startOf(ctx, slot);
    const end = endOf(ctx, slot);
    for (const day of unavailable) {
      if (start < (day + 1) * DAY_MINUTES && end > day * DAY_MINUTES) {
        out.push({
          key: `u:${String(day)}:${String(slot.day)}:${String(slot.shift)}`,
          code: 'unavailable',
          day: slot.day,
          shift: slot.shift,
        });
        break;
      }
    }
  }

  for (let i = 0; i < sorted.length; i += 1) {
    const a = sorted[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < sorted.length; j += 1) {
      const b = sorted[j];
      if (b === undefined) continue;
      if (startOf(ctx, b) >= endOf(ctx, a) + rest) continue;
      if (!inWeek(a) && !inWeek(b)) continue;
      out.push({
        key: `r:${String(a.day)}:${String(a.shift)}:${String(b.day)}:${String(b.shift)}`,
        code: startOf(ctx, b) < endOf(ctx, a) ? 'overlap' : 'rest',
        day: b.day,
        shift: b.shift,
      });
    }
  }

  const weekCount = sorted.filter(inWeek).length;
  if (weekCount > rules.maxShiftsPerWeek) {
    out.push({ key: `w:${String(weekCount)}`, code: 'max_shifts_week', day: 0, shift: null });
  }

  const days = [...new Set(sorted.map((slot) => slot.day))].sort((a, b) => a - b);
  for (const run of runsOf(days)) {
    if (run.length > rules.maxConsecutiveDays && run.start + run.length > 0) {
      out.push({
        key: `d:${String(run.start)}:${String(run.length)}`,
        code: 'max_consecutive_days',
        day: run.start + run.length - 1,
        shift: null,
      });
    }
  }
  const nightDays = [
    ...new Set(sorted.filter((slot) => ctx.shifts[slot.shift]?.night === true).map((s) => s.day)),
  ].sort((a, b) => a - b);
  for (const run of runsOf(nightDays)) {
    if (run.length > rules.maxConsecutiveNights && run.start + run.length > 0) {
      out.push({
        key: `n:${String(run.start)}:${String(run.length)}`,
        code: 'max_consecutive_nights',
        day: run.start + run.length - 1,
        shift: null,
      });
    }
  }
  return out;
}

/** Mutable state of a plan under construction. */
class Plan {
  private readonly byPerson = new Map<string, Slot[]>();
  private readonly baseKeys = new Map<string, Set<string>>();

  constructor(private readonly ctx: Context) {
    for (const slot of ctx.fixed) this.push(slot.userId, slot);
    for (const userId of ctx.order) {
      this.baseKeys.set(
        userId,
        new Set(personViolations(ctx, userId, this.byPerson.get(userId) ?? []).map((v) => v.key)),
      );
    }
  }

  private push(userId: string, slot: Slot): void {
    const list = this.byPerson.get(userId);
    if (list === undefined) this.byPerson.set(userId, [slot]);
    else list.push(slot);
  }

  slotsOf(userId: string): readonly Slot[] {
    return this.byPerson.get(userId) ?? [];
  }

  all(): Slot[] {
    return [...this.byPerson.values()].flat();
  }

  add(slot: Slot): void {
    this.push(slot.userId, slot);
  }

  remove(slot: Slot): void {
    const list = this.byPerson.get(slot.userId);
    if (list === undefined) return;
    const at = list.findIndex(
      (candidate) => candidate.day === slot.day && candidate.shift === slot.shift,
    );
    if (at >= 0) list.splice(at, 1);
  }

  /** Whether adding the slot brings in a violation that the fixed shifts do not already have. */
  canAdd(slot: Slot): boolean {
    const current = this.byPerson.get(slot.userId) ?? [];
    const base = this.baseKeys.get(slot.userId) ?? new Set<string>();
    return personViolations(this.ctx, slot.userId, [...current, slot]).every((violation) =>
      base.has(violation.key),
    );
  }

  /** Whether the person already works that shift on that day. */
  has(userId: string, day: number, shift: number): boolean {
    return this.slotsOf(userId).some((slot) => slot.day === day && slot.shift === shift);
  }
}

const isMember = (ctx: Context, userId: string, queueId: string | null): boolean =>
  queueId === null || (ctx.people.get(userId)?.queueIds.includes(queueId) ?? false);

/** The slots of a plan that coverage counts: the plan and the fixed shifts. */
function coverageCount(
  ctx: Context,
  slots: readonly Slot[],
  day: number,
  shift: number,
  queueId: string | null,
): number {
  let count = 0;
  const seen = new Set<string>();
  for (const slot of slots) {
    if (slot.day !== day || slot.shift !== shift || seen.has(slot.userId)) continue;
    seen.add(slot.userId);
    if (isMember(ctx, slot.userId, queueId)) count += 1;
  }
  return count;
}

interface Demand {
  readonly day: number;
  readonly shift: number;
  readonly queueId: string | null;
  readonly required: number;
}

/** What each (day, shift) needs, one entry per queue requirement and one for the plain head count. */
function demands(ctx: Context): Demand[] {
  const best = new Map<string, Demand>();
  for (const rule of ctx.input.coverage) {
    const shift = ctx.shiftIndex.get(rule.shiftId);
    if (shift === undefined || rule.required <= 0) continue;
    for (let day = 0; day < ROSTER_WEEK_DAYS; day += 1) {
      const weekday = weekdayOf(addDaysToDateKey(ctx.input.weekStart, day));
      if (rule.weekdays.length > 0 && !rule.weekdays.includes(weekday)) continue;
      if (ctx.frozen.has(`${String(day)}:${String(shift)}`)) continue;
      const key = `${String(day)}:${String(shift)}:${rule.queueId ?? ''}`;
      const have = best.get(key);
      if (have === undefined || have.required < rule.required) {
        best.set(key, { day, shift, queueId: rule.queueId, required: rule.required });
      }
    }
  }
  return [...best.values()];
}

/** The units the search has to fill: people still needed after the fixed shifts, per demand. */
function unitsOf(ctx: Context): Unit[] {
  const all = demands(ctx);
  const units: Unit[] = [];
  const groups = new Map<string, Demand[]>();
  for (const demand of all) {
    const key = `${String(demand.day)}:${String(demand.shift)}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [demand]);
    else list.push(demand);
  }
  for (const group of groups.values()) {
    const first = group[0];
    if (first === undefined) continue;
    let queueUnits = 0;
    for (const demand of group) {
      if (demand.queueId === null) continue;
      const have = coverageCount(ctx, ctx.fixed, demand.day, demand.shift, demand.queueId);
      const need = Math.max(0, demand.required - have);
      for (let n = 0; n < need; n += 1) {
        units.push({ day: demand.day, shift: demand.shift, queueId: demand.queueId });
      }
      queueUnits += need;
    }
    const general = group.find((demand) => demand.queueId === null);
    if (general !== undefined) {
      const fixedHeads = coverageCount(ctx, ctx.fixed, general.day, general.shift, null);
      const need = Math.max(0, general.required - fixedHeads - queueUnits);
      for (let n = 0; n < need; n += 1) {
        units.push({ day: general.day, shift: general.shift, queueId: null });
      }
    }
  }
  return units;
}

function loadsOf(ctx: Context, slots: readonly Slot[]): Map<string, RosterLoad> {
  const loads = new Map<string, { shifts: number; nights: number; heavyDays: number }>();
  for (const userId of ctx.order) {
    const history = ctx.input.history[userId];
    loads.set(userId, {
      shifts: 0,
      nights: history?.nights ?? 0,
      heavyDays: history?.heavyDays ?? 0,
    });
  }
  for (const slot of slots) {
    const load = loads.get(slot.userId);
    if (load === undefined || !inWeek(slot)) continue;
    load.shifts += 1;
    if (ctx.shifts[slot.shift]?.night === true) load.nights += 1;
    if (ctx.heavy[slot.day] === true) load.heavyDays += 1;
  }
  return new Map([...loads].map(([userId, load]) => [userId, { userId, ...load }]));
}

/** Smaller is fairer: squares punish one person carrying many nights or heavy days. */
function objective(ctx: Context, slots: readonly Slot[]): number {
  let total = 0;
  for (const load of loadsOf(ctx, slots).values()) {
    total += load.nights * load.nights * 4 + load.heavyDays * load.heavyDays * 3 + load.shifts ** 2;
  }
  return total;
}

function pickCost(ctx: Context, plan: Plan, userId: string, slot: Slot): number {
  const load = loadsOf(ctx, plan.slotsOf(userId)).get(userId);
  const night = ctx.shifts[slot.shift]?.night === true;
  const heavy = ctx.heavy[slot.day] === true;
  return (
    (night ? (load?.nights ?? 0) * 100 : 0) +
    (heavy ? (load?.heavyDays ?? 0) * 60 : 0) +
    (load?.shifts ?? 0)
  );
}

function candidatesFor(ctx: Context, plan: Plan, unit: Unit): string[] {
  const found: { userId: string; cost: number }[] = [];
  for (const userId of ctx.order) {
    if (!isMember(ctx, userId, unit.queueId)) continue;
    if (plan.has(userId, unit.day, unit.shift)) continue;
    const slot: Slot = { userId, day: unit.day, shift: unit.shift };
    if (!plan.canAdd(slot)) continue;
    found.push({ userId, cost: pickCost(ctx, plan, userId, slot) });
  }
  found.sort((a, b) => a.cost - b.cost || (a.userId < b.userId ? -1 : 1));
  return found.map((entry) => entry.userId);
}

interface SearchResult {
  readonly slots: Slot[];
  readonly status: RosterSolveStatus;
  readonly nodes: number;
}

/** Bounded exhaustive search over the units, most constrained first, falling back to the best partial plan. */
function search(ctx: Context, units: readonly Unit[]): SearchResult {
  const plan = new Plan(ctx);
  const added: Slot[] = [];
  const ordered = [...units];

  // Necessary conditions first: they prove "no plan" without a search.
  const emptyPlan = new Plan(ctx);
  const scarcity = new Map<Unit, number>();
  for (const unit of ordered) scarcity.set(unit, candidatesFor(ctx, emptyPlan, unit).length);
  ordered.sort(
    (a, b) =>
      (scarcity.get(a) ?? 0) - (scarcity.get(b) ?? 0) ||
      a.day - b.day ||
      a.shift - b.shift ||
      (a.queueId ?? '').localeCompare(b.queueId ?? ''),
  );
  let provenImpossible = false;
  const groupNeed = new Map<string, number>();
  for (const unit of ordered) {
    const key = `${String(unit.day)}:${String(unit.shift)}`;
    groupNeed.set(key, (groupNeed.get(key) ?? 0) + 1);
  }
  for (const [key, need] of groupNeed) {
    const [day = 0, shift = 0] = key.split(':').map(Number);
    const open = ctx.order.filter(
      (userId) => !emptyPlan.has(userId, day, shift) && emptyPlan.canAdd({ userId, day, shift }),
    ).length;
    if (open < need) provenImpossible = true;
  }
  let capacity = 0;
  for (const userId of ctx.order) {
    const used = ctx.fixed.filter((slot) => slot.userId === userId && inWeek(slot)).length;
    capacity += Math.max(0, ctx.input.rules.maxShiftsPerWeek - used);
  }
  if (ordered.length > capacity) provenImpossible = true;

  let nodes = 0;
  const limit = { hit: false };
  let best: Slot[] = [];
  const remaining = new Set(ordered.keys());
  const lastPick = new Map<string, number>();
  const orderOf = new Map(ctx.order.map((userId, i) => [userId, i]));
  const kindOf = (unit: Unit): string =>
    `${String(unit.day)}:${String(unit.shift)}:${unit.queueId ?? ''}`;

  const visit = (): boolean => {
    if (remaining.size === 0) return true;
    nodes += 1;
    if (nodes > ROSTER_SEARCH_NODE_LIMIT) {
      limit.hit = true;
      return false;
    }
    if (added.length > best.length) best = [...added];
    // The unit with the fewest people left to choose from goes first; one with nobody is a dead end. Units of
    // the same kind are interchangeable, so each takes a person after the one the previous took.
    let index = -1;
    let options: string[] = [];
    for (const candidate of [...remaining].sort((a, b) => a - b)) {
      const unit = ordered[candidate];
      if (unit === undefined) return false;
      const floor = lastPick.get(kindOf(unit)) ?? -1;
      const open = candidatesFor(ctx, plan, unit).filter(
        (userId) => (orderOf.get(userId) ?? 0) > floor,
      );
      if (open.length === 0) return false;
      if (index < 0 || open.length < options.length) {
        index = candidate;
        options = open;
      }
    }
    const unit = ordered[index];
    if (unit === undefined) return false;
    const kind = kindOf(unit);
    const before = lastPick.get(kind);
    remaining.delete(index);
    for (const userId of options) {
      const slot: Slot = { userId, day: unit.day, shift: unit.shift };
      plan.add(slot);
      added.push(slot);
      lastPick.set(kind, orderOf.get(userId) ?? 0);
      if (visit()) return true;
      added.pop();
      plan.remove(slot);
      if (limit.hit) break;
    }
    if (before === undefined) lastPick.delete(kind);
    else lastPick.set(kind, before);
    remaining.add(index);
    return false;
  };

  if (!provenImpossible && visit()) {
    return { slots: [...added], status: 'complete', nodes };
  }

  // No complete plan: start from the best partial one and fill what can still be filled.
  const fallback = new Plan(ctx);
  const slots: Slot[] = [];
  const filled = new Set<number>();
  for (const slot of best) {
    const at = ordered.findIndex(
      (unit, i) => !filled.has(i) && unit.day === slot.day && unit.shift === slot.shift,
    );
    if (at >= 0) filled.add(at);
    fallback.add(slot);
    slots.push(slot);
  }
  for (const [i, unit] of ordered.entries()) {
    if (filled.has(i)) continue;
    const [first] = candidatesFor(ctx, fallback, unit);
    if (first === undefined) continue;
    const slot: Slot = { userId: first, day: unit.day, shift: unit.shift };
    fallback.add(slot);
    slots.push(slot);
  }
  return {
    slots,
    status: provenImpossible || !limit.hit ? 'no_solution' : 'unproven',
    nodes,
  };
}

/** Unmet coverage of one (day, shift) over all rules that apply to it. */
function slotShortfall(ctx: Context, slots: readonly Slot[], day: number, shift: number): number {
  let missing = 0;
  for (const demand of demands(ctx)) {
    if (demand.day !== day || demand.shift !== shift) continue;
    missing += Math.max(0, demand.required - coverageCount(ctx, slots, day, shift, demand.queueId));
  }
  return missing;
}

/** Evens out nights and heavy days: moves a shift to another person, or swaps two, while that gets fairer. */
function improve(ctx: Context, planned: Slot[]): Slot[] {
  const plan = new Plan(ctx);
  for (const slot of planned) plan.add(slot);
  let current = [...planned];

  const score = (slots: readonly Slot[]): number => objective(ctx, [...ctx.fixed, ...slots]);
  const shortfallOf = (slots: readonly Slot[], day: number, shift: number): number =>
    slotShortfall(ctx, [...ctx.fixed, ...slots], day, shift);

  for (let pass = 0; pass < LOCAL_SEARCH_PASSES; pass += 1) {
    let changed = false;

    // Move one shift to another person.
    for (const slot of [...current]) {
      let done = false;
      for (const userId of ctx.order) {
        if (userId === slot.userId || plan.has(userId, slot.day, slot.shift)) continue;
        const moved: Slot = { userId, day: slot.day, shift: slot.shift };
        plan.remove(slot);
        if (!plan.canAdd(moved)) {
          plan.add(slot);
          continue;
        }
        const next = current.filter((candidate) => candidate !== slot).concat(moved);
        if (
          shortfallOf(next, slot.day, slot.shift) <= shortfallOf(current, slot.day, slot.shift) &&
          score(next) < score(current)
        ) {
          plan.add(moved);
          current = next;
          changed = true;
          done = true;
          break;
        }
        plan.add(slot);
      }
      if (done) break;
    }

    // Swap the people of two shifts.
    if (!changed) {
      outer: for (let i = 0; i < current.length; i += 1) {
        for (let j = i + 1; j < current.length; j += 1) {
          const a = current[i];
          const b = current[j];
          if (a === undefined || b === undefined || a.userId === b.userId) continue;
          if (plan.has(b.userId, a.day, a.shift) || plan.has(a.userId, b.day, b.shift)) continue;
          const a2: Slot = { userId: b.userId, day: a.day, shift: a.shift };
          const b2: Slot = { userId: a.userId, day: b.day, shift: b.shift };
          plan.remove(a);
          plan.remove(b);
          const ok = plan.canAdd(a2);
          if (ok) plan.add(a2);
          const ok2 = ok && plan.canAdd(b2);
          if (ok2) {
            const next = current.filter((s) => s !== a && s !== b).concat(a2, b2);
            if (
              score(next) < score(current) &&
              shortfallOf(next, a.day, a.shift) <= shortfallOf(current, a.day, a.shift) &&
              shortfallOf(next, b.day, b.shift) <= shortfallOf(current, b.day, b.shift)
            ) {
              plan.add(b2);
              current = next;
              changed = true;
              break outer;
            }
          }
          if (ok) plan.remove(a2);
          plan.add(a);
          plan.add(b);
        }
      }
    }
    if (!changed) break;
  }
  return current;
}

const toAssignment = (ctx: Context, slot: Slot): RosterAssignment => ({
  userId: slot.userId,
  shiftId: ctx.shifts[slot.shift]?.id ?? '',
  workDate: addDaysToDateKey(ctx.input.weekStart, slot.day),
});

/** Slots of a list of assignments of this week (entries outside the week or of unknown shifts are dropped). */
function slotsOfAssignments(ctx: Context, assignments: readonly RosterAssignment[]): Slot[] {
  const out: Slot[] = [];
  for (const entry of assignments) {
    const shift = ctx.shiftIndex.get(entry.shiftId);
    const day = dayDifference(ctx.input.weekStart, entry.workDate);
    if (shift === undefined || day < 0 || day >= ROSTER_WEEK_DAYS) continue;
    out.push({ userId: entry.userId, day, shift });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const VIOLATION_ITEM: Record<RosterViolationCode, RosterReportItemId> = {
  unavailable: 'unavailable',
  overlap: 'rest',
  rest: 'rest',
  max_shifts_week: 'max_shifts_week',
  max_consecutive_days: 'max_consecutive_days',
  max_consecutive_nights: 'max_consecutive_nights',
};

const ITEM_MESSAGE: Record<RosterReportItemId, string> = {
  unavailable: 'Nobody works a day they are on leave or unavailable',
  rest: 'At least the minimum rest between two shifts, and no overlapping shifts',
  max_shifts_week: 'No more than the maximum shifts per week',
  max_consecutive_days: 'No more than the maximum working days in a row',
  max_consecutive_nights: 'No more than the maximum night shifts in a row',
  coverage: 'Every shift has the people it needs',
  fairness_nights: 'Night shifts are shared evenly',
  fairness_heavy_days: 'Weekend and holiday shifts are shared evenly',
};

const FAILURE_MESSAGE: Record<RosterViolationCode, string> = {
  unavailable: 'Rostered on a day they are unavailable',
  overlap: 'Two shifts overlap',
  rest: 'Less than the minimum rest before this shift',
  max_shifts_week: 'More shifts than the weekly maximum',
  max_consecutive_days: 'Too many working days in a row',
  max_consecutive_nights: 'Too many night shifts in a row',
};

/** Why a person could not be added to a short slot: the first rule the addition would break. */
function blockReason(ctx: Context, plan: Plan, userId: string, slot: Slot, queueId: string | null) {
  if (!isMember(ctx, userId, queueId)) return 'not_in_queue';
  const current = plan.slotsOf(userId);
  const base = new Set(personViolations(ctx, userId, current).map((violation) => violation.key));
  const fresh = personViolations(ctx, userId, [...current, slot]).find(
    (violation) => !base.has(violation.key),
  );
  if (fresh === undefined) return 'available';
  return fresh.code === 'overlap' ? 'rest' : fresh.code;
}

/**
 * Checks a set of planned shifts against the rules. Used for the solver's own result and again after a person
 * edits the plan by hand, so what the lead sees is always a fresh check.
 */
export function evaluateRoster(
  input: RosterInput,
  assignments: readonly RosterAssignment[],
): RosterReport {
  const ctx = prepare(input);
  const planned = slotsOfAssignments(ctx, assignments);
  const all = [...ctx.fixed, ...planned];
  const items: RosterReportItem[] = [];

  const hard = new Map<RosterReportItemId, RosterFailure[]>();
  for (const id of [
    'unavailable',
    'rest',
    'max_shifts_week',
    'max_consecutive_days',
    'max_consecutive_nights',
  ] as const) {
    hard.set(id, []);
  }
  const byPerson = new Map<string, Slot[]>();
  for (const slot of all) {
    const list = byPerson.get(slot.userId);
    if (list === undefined) byPerson.set(slot.userId, [slot]);
    else list.push(slot);
  }
  const fixedOnly = new Map<string, Slot[]>();
  for (const slot of ctx.fixed) {
    const list = fixedOnly.get(slot.userId);
    if (list === undefined) fixedOnly.set(slot.userId, [slot]);
    else list.push(slot);
  }
  for (const userId of [...byPerson.keys()].sort()) {
    const base = new Set(
      personViolations(ctx, userId, fixedOnly.get(userId) ?? []).map((violation) => violation.key),
    );
    for (const violation of personViolations(ctx, userId, byPerson.get(userId) ?? [])) {
      // A rule broken by shifts that were already there is not this plan's doing, but it is still reported.
      const item = VIOLATION_ITEM[violation.code];
      hard.get(item)?.push({
        code: violation.code,
        userId,
        shiftId: violation.shift === null ? null : (ctx.shifts[violation.shift]?.id ?? null),
        workDate: addDaysToDateKey(input.weekStart, violation.day),
        message: FAILURE_MESSAGE[violation.code],
        params: { preExisting: base.has(violation.key) ? 1 : 0 },
      });
    }
  }
  for (const [id, failures] of hard) {
    items.push({
      id,
      kind: 'hard',
      status: failures.length === 0 ? 'pass' : 'fail',
      message: ITEM_MESSAGE[id],
      failures,
    });
  }

  // Coverage, with the reason each short slot is short.
  const plan = new Plan(ctx);
  for (const slot of planned) plan.add(slot);
  const coverageFailures: RosterFailure[] = [];
  const seen = new Set<string>();
  for (const rule of input.coverage) {
    const shift = ctx.shiftIndex.get(rule.shiftId);
    if (shift === undefined || rule.required <= 0) continue;
    for (let day = 0; day < ROSTER_WEEK_DAYS; day += 1) {
      const date = addDaysToDateKey(input.weekStart, day);
      if (rule.weekdays.length > 0 && !rule.weekdays.includes(weekdayOf(date))) continue;
      if (ctx.frozen.has(`${String(day)}:${String(shift)}`)) continue;
      const have = coverageCount(ctx, all, day, shift, rule.queueId);
      if (have >= rule.required) continue;
      const key = `${String(day)}:${String(shift)}:${rule.queueId ?? ''}:${String(rule.required)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const reasons: Record<string, number> = {};
      for (const userId of ctx.order) {
        if (
          plan.has(userId, day, shift) ||
          ctx.fixed.some((s) => s.userId === userId && s.day === day && s.shift === shift)
        ) {
          continue;
        }
        const reason = blockReason(ctx, plan, userId, { userId, day, shift }, rule.queueId);
        if (reason !== 'available') reasons[reason] = (reasons[reason] ?? 0) + 1;
      }
      coverageFailures.push({
        code: 'coverage_short',
        userId: null,
        shiftId: rule.shiftId,
        workDate: date,
        message: 'Fewer people than the shift needs',
        params: {
          required: rule.required,
          assigned: have,
          queueId: rule.queueId ?? '',
          ...reasons,
        },
      });
    }
  }
  items.push({
    id: 'coverage',
    kind: 'coverage',
    status: coverageFailures.length === 0 ? 'pass' : 'fail',
    message: ITEM_MESSAGE.coverage,
    failures: coverageFailures,
  });

  // Fairness.
  const loads = loadsOf(ctx, all);
  const loadList = [...loads.values()].sort((a, b) => (a.userId < b.userId ? -1 : 1));
  for (const [id, pick] of [
    ['fairness_nights', (load: RosterLoad) => load.nights],
    ['fairness_heavy_days', (load: RosterLoad) => load.heavyDays],
  ] as const) {
    const values = loadList.map(pick);
    const max = values.length === 0 ? 0 : Math.max(...values);
    const min = values.length === 0 ? 0 : Math.min(...values);
    const fair = max - min <= 1;
    items.push({
      id,
      kind: 'fairness',
      status: fair ? 'pass' : 'fail',
      message: ITEM_MESSAGE[id],
      failures: fair
        ? []
        : [
            {
              code: 'spread',
              userId: null,
              shiftId: null,
              workDate: null,
              message: 'The most and the fewest differ by more than one',
              params: { max, min },
            },
          ],
    });
  }

  return {
    hardOk: items.filter((item) => item.kind === 'hard').every((item) => item.status === 'pass'),
    coverageOk: coverageFailures.length === 0,
    items,
    loads: loadList.map((load) => ({ ...load, shifts: load.shifts })),
  };
}

/** Makes a plan for the week. Deterministic: the same input gives the same plan. */
export function solveRoster(input: RosterInput): RosterSolution {
  const ctx = prepare(input);
  const units = unitsOf(ctx);
  const result = search(ctx, units);
  const improved = improve(ctx, result.slots);
  const assignments = improved
    .map((slot) => toAssignment(ctx, slot))
    .sort(
      (a, b) =>
        a.workDate.localeCompare(b.workDate) ||
        a.shiftId.localeCompare(b.shiftId) ||
        a.userId.localeCompare(b.userId),
    );
  const report = evaluateRoster(input, assignments);
  return {
    assignments,
    // A plan that turned out complete after the local search is complete whatever the search said.
    status: report.coverageOk
      ? 'complete'
      : result.status === 'complete'
        ? 'unproven'
        : result.status,
    nodes: result.nodes,
    report,
  };
}

// ---------------------------------------------------------------------------------------------
// Coverage from history
// ---------------------------------------------------------------------------------------------

export interface VolumePoint {
  /** Local date `YYYY-MM-DD` and minute of the local day a ticket arrived. */
  readonly date: string;
  readonly minute: number;
  readonly count: number;
}

export interface CoverageSuggestionOptions {
  /** Days the volume covers (the divisor of the average). */
  readonly days: number;
  /** Tickets one person is expected to handle in one shift `[ASSUMED]`, a number the lead edits. */
  readonly ticketsPerPersonPerShift: number;
  readonly minimum: number;
  readonly maximum: number;
}

/**
 * How many people each shift needs on each weekday, from the tickets that arrived in the shift's window in the
 * past `days` days: the average per weekday divided by what one person handles, rounded up, kept between
 * `minimum` and `maximum`. A guess from volume, not from SLA; the lead edits it (N5).
 */
export function suggestCoverage(
  shifts: readonly RosterShift[],
  volume: readonly VolumePoint[],
  options: CoverageSuggestionOptions,
): CoverageRule[] {
  const rules: CoverageRule[] = [];
  const weeks = Math.max(1, options.days / 7);
  for (const shift of shifts) {
    const info = shiftInfo(shift, 0);
    const perWeekday = Array.from({ length: 7 }, () => 0);
    for (const point of volume) {
      let shiftDate: string | null = null;
      if (!info.night) {
        if (point.minute >= info.startMin && point.minute < info.startMin + info.durationMin) {
          shiftDate = point.date;
        }
      } else if (point.minute >= info.startMin) {
        shiftDate = point.date;
      } else if (point.minute < info.startMin + info.durationMin - DAY_MINUTES) {
        shiftDate = addDaysToDateKey(point.date, -1);
      }
      if (shiftDate === null) continue;
      const weekday = weekdayOf(shiftDate);
      perWeekday[weekday] = (perWeekday[weekday] ?? 0) + point.count;
    }
    const required = perWeekday.map((count) =>
      Math.min(
        options.maximum,
        Math.max(options.minimum, Math.ceil(count / weeks / options.ticketsPerPersonPerShift)),
      ),
    );
    const groups = new Map<number, number[]>();
    required.forEach((value, weekday) => {
      const list = groups.get(value);
      if (list === undefined) groups.set(value, [weekday]);
      else list.push(weekday);
    });
    for (const [value, weekdays] of [...groups].sort((a, b) => a[0] - b[0])) {
      rules.push({
        shiftId: shift.id,
        weekdays: weekdays.length === 7 ? [] : weekdays,
        required: value,
        queueId: null,
      });
    }
  }
  return rules;
}
