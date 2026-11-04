import type { RosterExplainFacts } from '@watchtower/ai';
import type { RosterPlan } from '@watchtower/shared';

/**
 * The facts of a plan as the roster planner agent gets them (T-305e). People are labels (`staff-1`, in the order
 * of their ids) so no name reaches a model; `restoreNames` puts the names back into the answer for the lead.
 * Everything here comes from the solver and the checker, none of it from a model.
 */
export function buildExplainFacts(plan: RosterPlan): {
  readonly facts: RosterExplainFacts;
  readonly names: ReadonlyMap<string, string>;
} {
  const ordered = [...plan.inputs.people].sort((a, b) => (a.id < b.id ? -1 : 1));
  const labelOf = new Map(
    ordered.map((person, index) => [person.id, `staff-${String(index + 1)}`]),
  );
  const names = new Map(
    ordered.map((person, index) => [`staff-${String(index + 1)}`, person.name]),
  );
  const shiftName = new Map(plan.inputs.shifts.map((shift) => [shift.id, shift.name]));
  const label = (userId: string | null): string | null =>
    userId === null ? null : (labelOf.get(userId) ?? 'staff-other');

  const dates = [...new Set(plan.entries.map((entry) => entry.workDate))].sort();
  const facts: RosterExplainFacts = {
    weekStart: plan.weekStart,
    solverStatus: plan.solver.status,
    rules: { ...plan.inputs.rules },
    shifts: plan.inputs.shifts.map((shift) => ({
      name: shift.name,
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
      onCall: shift.onCall,
    })),
    loads: plan.report.loads.map((load) => ({
      label: label(load.userId) ?? 'staff-other',
      shifts: load.shifts,
      nights: load.nights,
      heavyDays: load.heavyDays,
    })),
    days: dates.map((date) => ({
      date,
      shifts: plan.inputs.shifts.map((shift) => ({
        shift: shift.name,
        people: plan.entries
          .filter((entry) => entry.workDate === date && entry.shiftId === shift.id)
          .map((entry) => label(entry.userId) ?? 'staff-other'),
      })),
    })),
    checks: plan.report.items.map((item) => ({
      id: item.id,
      status: item.status,
      failures: item.failures.slice(0, 12).map((failure) => ({
        code: failure.code,
        label: label(failure.userId),
        date: failure.workDate,
        shift: failure.shiftId === null ? null : (shiftName.get(failure.shiftId) ?? null),
        params: failure.params,
      })),
    })),
  };
  return { facts, names };
}

/** Puts staff names back in place of the labels the model was given. A label that is not known stays as it is. */
export function restoreNames(text: string, names: ReadonlyMap<string, string>): string {
  return text.replaceAll(/\bstaff-\d+\b/g, (label) => names.get(label) ?? label);
}
