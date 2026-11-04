import {
  PROCEDURE_GENERIC_TOOLS,
  PROCEDURE_TOOL_TEMPLATE_KIND,
  type Condition,
  type ConditionClause,
  type ProcedureIssue,
  type ProcedureStep,
  type ProcedureSteps,
  type ProcedureToolStep,
  type ProcedureValidation,
} from '@watchtower/shared';

/** What the steps are checked against: the intent's grants and what exists in this instance (ADR-026 section 3). */
export interface ProcedureValidationContext {
  /** `intent.allowed_tools`. The generic tools (KB, similar tickets, organization) need no grant. */
  readonly allowedTools: readonly string[];
  /** Saved templates the AI may run for this intent (active, `run_by_ai`, of the intent). */
  readonly templates: readonly { readonly name: string; readonly kind: 'logs' | 'data' }[];
  /** Names of the team queues (`escalate.to.queueKey` is compared without regard to case). */
  readonly queueKeys: readonly string[];
}

const ALL_STAGES: readonly number[] = [0, 1, 2, 3, 4];
const stagesOf = (step: ProcedureStep): readonly number[] => step.stages ?? ALL_STAGES;

/** A set of `all` clauses that no ticket can satisfy: two values for one field, or an empty range. */
function contradiction(condition: Condition | undefined): string | null {
  const clauses: readonly ConditionClause[] = condition?.all ?? [];
  const byField = new Map<string, ConditionClause[]>();
  for (const clause of clauses)
    byField.set(clause.field, [...(byField.get(clause.field) ?? []), clause]);
  for (const [field, list] of byField) {
    const eqs = list.filter((clause) => clause.op === 'eq').map((clause) => clause.value);
    if (new Set(eqs.map(String)).size > 1) return `${field} cannot equal two different values`;
    const only = eqs[0];
    for (const clause of list) {
      if (clause.op === 'neq' && only !== undefined && clause.value === only) {
        return `${field} cannot both equal and differ from the same value`;
      }
      if (
        clause.op === 'in' &&
        only !== undefined &&
        Array.isArray(clause.value) &&
        !clause.value.includes(String(only))
      ) {
        return `${field} cannot equal a value that is outside its own list`;
      }
    }
    const lowest = Math.max(
      ...list
        .filter((clause) => clause.op === 'gte' && typeof clause.value === 'number')
        .map((clause) => Number(clause.value)),
    );
    const highest = Math.min(
      ...list
        .filter((clause) => clause.op === 'lte' && typeof clause.value === 'number')
        .map((clause) => Number(clause.value)),
    );
    if (Number.isFinite(lowest) && Number.isFinite(highest) && lowest > highest) {
      return `${field} cannot be at least ${String(lowest)} and at most ${String(highest)}`;
    }
  }
  return null;
}

function whenOf(step: ProcedureStep): Condition | undefined {
  return step.kind === 'tool' || step.kind === 'escalate' || step.kind === 'require_human'
    ? step.when
    : undefined;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Semantic validation of steps that already passed the Zod schema (ADR-026 section 3). Pure: the caller
 * reads the intent, the templates and the queues. The result lists every problem, so a person fixes them in
 * one pass; `ok` is what the confirm step needs.
 */
export function validateProcedureSteps(
  procedure: ProcedureSteps,
  context: ProcedureValidationContext,
): ProcedureValidation {
  const issues: ProcedureIssue[] = [];
  const add = (code: ProcedureIssue['code'], stepId: string | null, message: string): void => {
    issues.push({ code, stepId, message });
  };
  const granted = new Set<string>([...PROCEDURE_GENERIC_TOOLS, ...context.allowedTools]);
  const templates = new Map(context.templates.map((template) => [template.name, template.kind]));
  const queues = new Set(context.queueKeys.map((key) => key.toLowerCase()));
  const index = new Map(procedure.steps.map((step, position) => [step.id, position]));
  const dead = new Set<string>();

  procedure.steps.forEach((step, position) => {
    const contradictory = contradiction(whenOf(step));
    if (contradictory !== null) {
      add(
        'contradictory_condition',
        step.id,
        `The condition of ${step.id} can never hold: ${contradictory}`,
      );
      dead.add(step.id);
    }

    if (step.kind === 'tool') {
      if (!granted.has(step.tool)) {
        add(
          'tool_not_allowed',
          step.id,
          `${step.tool} is not allowed for this intent: add it to the intent's allowed tools first`,
        );
      }
      if (step.template !== undefined) {
        const wanted = PROCEDURE_TOOL_TEMPLATE_KIND[step.tool];
        const found = templates.get(step.template);
        if (wanted === undefined) {
          add('template_not_for_tool', step.id, `${step.tool} does not take a template`);
        } else if (found === undefined) {
          add(
            'template_not_found',
            step.id,
            `No template named ${step.template} that the AI may run for this intent`,
          );
        } else if (found !== wanted) {
          add(
            'template_wrong_tool',
            step.id,
            `${step.template} is a ${found} template; ${step.tool} runs ${wanted} templates`,
          );
        }
      }
      const twin = procedure.steps
        .slice(0, position)
        .find(
          (earlier): earlier is ProcedureToolStep =>
            earlier.kind === 'tool' &&
            earlier.tool === step.tool &&
            earlier.template === step.template &&
            sameJson(earlier.params, step.params) &&
            sameJson(earlier.when, step.when) &&
            sameJson(earlier.stages, step.stages),
        );
      if (twin !== undefined) {
        add('duplicate_tool_step', step.id, `${step.id} does the same as ${twin.id}`);
        dead.add(step.id);
      }
    }

    if (
      step.kind === 'escalate' &&
      'queueKey' in step.to &&
      !queues.has(step.to.queueKey.toLowerCase())
    ) {
      add('queue_not_found', step.id, `No team queue named ${step.to.queueKey}`);
    }

    if (step.kind === 'check') {
      let live = false;
      let wellFormed = true;
      for (const ref of step.evidenceFrom) {
        const at = index.get(ref);
        const target = at === undefined ? undefined : procedure.steps[at];
        if (at === undefined || target === undefined) {
          wellFormed = false;
          add(
            'evidence_unknown_step',
            step.id,
            `${step.id} reads from ${ref}, which is not a step`,
          );
        } else if (at >= position) {
          wellFormed = false;
          add(
            'evidence_not_earlier',
            step.id,
            `${step.id} reads from ${ref}, which does not come before it`,
          );
        } else if (target.kind !== 'tool') {
          wellFormed = false;
          add(
            'evidence_not_tool',
            step.id,
            `${step.id} reads from ${ref}, which is not a tool step`,
          );
        } else if (
          !dead.has(ref) &&
          stagesOf(target).some((stage) => stagesOf(step).includes(stage))
        ) {
          live = true;
        }
      }
      // Every source of the check is missing, dead, or never runs at a stage where the check runs.
      if (wellFormed && !live) {
        add(
          'dead_step',
          step.id,
          `${step.id} never has any evidence to read: its sources do not run at its stages or can never run`,
        );
        dead.add(step.id);
      }
    }
  });

  return { ok: issues.length === 0, issues };
}
