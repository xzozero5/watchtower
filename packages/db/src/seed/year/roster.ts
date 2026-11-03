import { addDays, bangkokTime, DAY, localParts, MINUTE, type Rng } from './prng.js';
import type { WorldStaff } from './world.js';

/**
 * Who works when. The roster is built first because everything else follows it: a reply cannot
 * come from someone who is not on shift, and an overnight P1 goes to the on-call person.
 */

export interface ShiftDef {
  readonly id: string;
  readonly name: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly onCall: boolean;
}

export type ShiftKind = 'day' | 'evening' | 'oncall';

export interface RosterSlot {
  readonly id: string;
  readonly shift: ShiftDef;
  readonly kind: ShiftKind;
  readonly person: WorldStaff;
  readonly workDate: string;
  readonly start: Date;
  readonly end: Date;
}

function kindOf(shift: ShiftDef): ShiftKind {
  if (shift.onCall) return 'oncall';
  return shift.startsAt < '12:00' ? 'day' : 'evening';
}

function parseHm(value: string): [number, number] {
  const [h, m] = value.split(':').map(Number) as [number, number];
  return [h, m];
}

export function shiftWindow(shift: ShiftDef, workDate: string): { start: Date; end: Date } {
  const [sh, sm] = parseHm(shift.startsAt);
  const [eh, em] = parseHm(shift.endsAt);
  const start = bangkokTime(workDate, sh, sm);
  const crossesMidnight = eh * 60 + em <= sh * 60 + sm;
  const end = bangkokTime(crossesMidnight ? addDays(workDate, 1) : workDate, eh, em);
  return { start, end };
}

export function buildRoster(
  rng: Rng,
  staff: readonly WorldStaff[],
  shifts: readonly ShiftDef[],
  startKey: string,
  endKey: string,
  offDays: ReadonlySet<string>,
): RosterSlot[] {
  const day = shifts.find((s) => kindOf(s) === 'day');
  const evening = shifts.find((s) => kindOf(s) === 'evening');
  const onCall = shifts.find((s) => kindOf(s) === 'oncall');
  if (!day || !evening || !onCall)
    throw new Error('the roster needs a day, an evening and an on-call shift');

  const slots: RosterSlot[] = [];
  const add = (shift: ShiftDef, person: WorldStaff, workDate: string): void => {
    slots.push({
      id: rng.uuid(),
      shift,
      kind: kindOf(shift),
      person,
      workDate,
      ...shiftWindow(shift, workDate),
    });
  };

  let key = startKey;
  let dayIndex = 0;
  while (key <= endKey) {
    const at = bangkokTime(key, 12);
    const joined = (person: WorldStaff): boolean => person.createdAt.getTime() <= at.getTime();
    const agents = staff.filter((s) => s.role === 'agent' && joined(s));
    const leads = staff.filter((s) => s.role === 'lead' && joined(s));
    const devs = staff.filter((s) => s.role === 'dev' && joined(s));
    const weekday = localParts(at).weekday;
    const off = weekday === 0 || weekday === 6 || offDays.has(key);

    const used = new Set<string>();
    const take = (pool: readonly WorldStaff[], offset: number): WorldStaff | undefined => {
      for (let step = 0; step < pool.length; step += 1) {
        const person = pool[(offset + step) % pool.length];
        if (person && !used.has(person.id)) {
          used.add(person.id);
          return person;
        }
      }
      return undefined;
    };

    if (off) {
      const person = take(agents, dayIndex);
      if (person) add(day, person, key);
    } else {
      const lead = take(leads, dayIndex);
      if (lead) add(day, lead, key);
      for (let i = 0; i < 3; i += 1) {
        const person = take(agents, dayIndex * 2 + i);
        if (person) add(day, person, key);
      }
      for (let i = 0; i < 2; i += 1) {
        const person = take(agents, dayIndex * 2 + 3 + i);
        if (person) add(evening, person, key);
      }
    }
    // On-call: one agent or lead per night, one developer per week.
    const week = Math.floor(dayIndex / 7);
    const nightPool = [...agents, ...leads];
    const night = take(nightPool, week * 2 + (dayIndex % 7 < 4 ? 0 : 1));
    if (night) add(onCall, night, key);
    const devPerson = devs.length > 0 ? devs[week % devs.length] : undefined;
    if (devPerson) add(onCall, devPerson, key);

    key = addDays(key, 1);
    dayIndex += 1;
  }
  return slots;
}

export interface DutyNow {
  /** Day and evening shifts covering the instant (agents and leads). */
  readonly desk: readonly WorldStaff[];
  /** On-call people covering the instant (agents, leads and developers). */
  readonly oncall: readonly WorldStaff[];
}

/** Answers "who is on shift at this instant" from the roster. */
export class Duty {
  private readonly byDate = new Map<string, RosterSlot[]>();

  constructor(readonly slots: readonly RosterSlot[]) {
    for (const slot of slots) {
      const list = this.byDate.get(slot.workDate) ?? [];
      list.push(slot);
      this.byDate.set(slot.workDate, list);
    }
  }

  active(at: Date): DutyNow {
    const today = localParts(at).dateKey;
    const yesterday = addDays(today, -1);
    const desk: WorldStaff[] = [];
    const oncall: WorldStaff[] = [];
    for (const key of [yesterday, today]) {
      for (const slot of this.byDate.get(key) ?? []) {
        if (slot.start.getTime() <= at.getTime() && at.getTime() < slot.end.getTime()) {
          (slot.kind === 'oncall' ? oncall : desk).push(slot.person);
        }
      }
    }
    return { desk, oncall };
  }

  /**
   * The first moment at or after `at` when someone can pick up work of this urgency: the desk for
   * anything, the on-call person for P1 and P2. A small jitter keeps replies from piling up on the
   * minute a shift starts.
   */
  coveredFrom(at: Date, urgent: boolean, rng: Rng): Date {
    let t = at;
    for (let guard = 0; guard < 24 * 6 * 6; guard += 1) {
      const duty = this.active(t);
      const staffedOncall = duty.oncall.some((p) => p.role === 'agent' || p.role === 'lead');
      if (duty.desk.length > 0 || (urgent && staffedOncall)) {
        return t === at ? t : new Date(t.getTime() + rng.int(1, 25) * MINUTE);
      }
      t = new Date(t.getTime() + 10 * MINUTE);
    }
    return new Date(at.getTime() + DAY);
  }
}
