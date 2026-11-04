import {
  CONDITION_FIELDS,
  PROCEDURE_LIMITS,
  PROCEDURE_TOOL_NAMES,
  procedureStepsSchema,
  type ConditionClause,
  type ConditionField,
  type ProcedureStep,
  type ProcedureSteps,
} from '@watchtower/shared';

/** Pure helpers of the procedure editor: new steps, ids, a diff against the live version, local schema checks. */

export const STEP_KINDS = [
  'tool',
  'check',
  'reply_guideline',
  'disclosure',
  'escalate',
  'require_human',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const STAGES = [0, 1, 2, 3, 4] as const;

/** `check_1`, `check_2`, ... the first id no step uses. */
export function freshStepId(kind: StepKind, steps: readonly ProcedureStep[]): string {
  const used = new Set(steps.map((step) => step.id));
  for (let n = 1; n <= PROCEDURE_LIMITS.maxSteps + 1; n += 1) {
    const id = `${kind}_${String(n)}`;
    if (!used.has(id)) return id;
  }
  return `${kind}_x`;
}

/** A step of `kind` that is as empty as the schema allows; the person fills it in. */
export function newStep(kind: StepKind, steps: readonly ProcedureStep[]): ProcedureStep {
  const id = freshStepId(kind, steps);
  switch (kind) {
    case 'tool': {
      const [tool] = PROCEDURE_TOOL_NAMES;
      return { kind, id, tool };
    }
    case 'check': {
      const firstTool = steps.find((step) => step.kind === 'tool');
      return { kind, id, question: '', evidenceFrom: firstTool ? [firstTool.id] : [] };
    }
    case 'reply_guideline':
      return { kind, id, text: '' };
    case 'disclosure':
      return { kind, id, rule: 'never_mention', topic: '' };
    case 'escalate':
      return {
        kind,
        id,
        when: { all: [defaultClause('ticket.priority')] },
        to: { role: 'lead' },
        note: '',
      };
    case 'require_human':
      return { kind, id, when: { all: [defaultClause('ticket.priority')] }, reason: '' };
  }
}

export function defaultClause(field: ConditionField): ConditionClause {
  const spec = CONDITION_FIELDS[field];
  const op = spec.ops[0];
  const value =
    spec.kind === 'boolean'
      ? true
      : spec.kind === 'priority'
        ? 'P1'
        : spec.kind === 'slug'
          ? 'web'
          : 0;
  return { field, op, value };
}

/** The step list with the step at `index` swapped with its neighbour (`-1` up, `1` down). Out of range: unchanged. */
export function moveStep<T>(items: readonly T[], index: number, by: -1 | 1): T[] {
  const target = index + by;
  const next = [...items];
  if (target < 0 || target >= next.length || index < 0 || index >= next.length) return next;
  const a = next[index] as T;
  const b = next[target] as T;
  next[index] = b;
  next[target] = a;
  return next;
}

/** A step id that was renamed must be renamed in the `evidenceFrom` of the checks that point to it. */
export function renameStepId(
  steps: readonly ProcedureStep[],
  from: string,
  to: string,
): ProcedureStep[] {
  return steps.map((step) => {
    if (step.id === from) return { ...step, id: to };
    if (step.kind === 'check' && step.evidenceFrom.includes(from)) {
      return { ...step, evidenceFrom: step.evidenceFrom.map((id) => (id === from ? to : id)) };
    }
    return step;
  });
}

/** Removing a step also removes it from `evidenceFrom`, so a check never points at nothing silently. */
export function removeStep(steps: readonly ProcedureStep[], id: string): ProcedureStep[] {
  return steps
    .filter((step) => step.id !== id)
    .map((step) =>
      step.kind === 'check' && step.evidenceFrom.includes(id)
        ? { ...step, evidenceFrom: step.evidenceFrom.filter((from) => from !== id) }
        : step,
    );
}

// --- diff against the version that is live ---------------------------------------------------------

export type StepChange =
  | { type: 'added'; id: string; kind: StepKind }
  | { type: 'removed'; id: string; kind: StepKind }
  | { type: 'changed'; id: string; kind: StepKind; fields: string[] }
  | { type: 'moved'; id: string; kind: StepKind };

export interface ProcedureDiff {
  autosendChanged: boolean;
  changes: StepChange[];
}

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

function changedFields(before: ProcedureStep, after: ProcedureStep): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete('id');
  const fields: string[] = [];
  for (const key of keys) {
    const a = (before as Record<string, unknown>)[key];
    const b = (after as Record<string, unknown>)[key];
    if (stable(a) !== stable(b)) fields.push(key);
  }
  return fields.sort();
}

/**
 * What differs between the live steps (`base`, null when the intent runs the default runbook) and `next`.
 * Steps are matched by id. A step with the same id and fields in another place counts as moved.
 */
export function diffProcedure(base: ProcedureSteps | null, next: ProcedureSteps): ProcedureDiff {
  const before = base?.steps ?? [];
  const beforeById = new Map(before.map((step) => [step.id, step]));
  const afterById = new Map(next.steps.map((step) => [step.id, step]));
  const changes: StepChange[] = [];

  for (const step of before) {
    if (!afterById.has(step.id)) changes.push({ type: 'removed', id: step.id, kind: step.kind });
  }
  const survivors = before.filter((step) => afterById.has(step.id)).map((step) => step.id);
  const order = next.steps.filter((step) => beforeById.has(step.id)).map((step) => step.id);
  next.steps.forEach((step) => {
    const old = beforeById.get(step.id);
    if (!old) {
      changes.push({ type: 'added', id: step.id, kind: step.kind });
      return;
    }
    if (old.kind !== step.kind) {
      changes.push({ type: 'changed', id: step.id, kind: step.kind, fields: ['kind'] });
      return;
    }
    const fields = changedFields(old, step);
    if (fields.length > 0) {
      changes.push({ type: 'changed', id: step.id, kind: step.kind, fields });
    } else if (survivors.indexOf(step.id) !== order.indexOf(step.id)) {
      changes.push({ type: 'moved', id: step.id, kind: step.kind });
    }
  });

  return {
    autosendChanged: (base?.autosend ?? 'never') !== next.autosend,
    changes,
  };
}

// --- local schema check ------------------------------------------------------------------------------

export interface LocalIssue {
  /** The step the problem is in; null for the list as a whole. */
  stepId: string | null;
  message: string;
}

/**
 * The schema of `@watchtower/shared` run in the browser, so a form mistake shows beside its step before a save
 * round trip. The api still decides (semantic validation needs this instance's tools, templates and queues).
 */
export function localIssues(steps: ProcedureSteps): LocalIssue[] {
  const parsed = procedureStepsSchema.safeParse(steps);
  if (parsed.success) return [];
  return parsed.error.issues.slice(0, 50).map((issue) => {
    const [head, index] = issue.path;
    const step = head === 'steps' && typeof index === 'number' ? steps.steps[index] : undefined;
    const where = issue.path.slice(step ? 2 : 0).join('.');
    return {
      stepId: step?.id ?? null,
      message: where ? `${where}: ${issue.message}` : issue.message,
    };
  });
}

export const sameSteps = (a: ProcedureSteps, b: ProcedureSteps): boolean => stable(a) === stable(b);

/** Number of bytes of text the steps carry against the limit; the form shows it so a long guideline is not a surprise. */
export const TEXT_LIMIT_BYTES = PROCEDURE_LIMITS.maxTextBytes;
