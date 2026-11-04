import {
  evaluateCondition,
  type ConditionFacts,
  type ProcedureStep,
  type ProcedureSteps,
  type ProcedureToolStep,
} from '@watchtower/shared';

/**
 * What a published procedure asks of an investigation (T-303c, ADR-026 sections 1, 5 and 7), worked out in
 * code and never by a model. Every function here is pure: the facts of the ticket come in, the steps that
 * apply come out. A procedure can narrow and re-order the default runbook, add questions and guidelines, make
 * a disclosure rule stricter, propose an escalation and call for a person; it cannot add a tool, put text in a
 * tool input, loosen a rule or raise a stage (the schema has no field for any of them).
 */

export interface ProcedureSelection {
  /** The autonomy stage of the intent (0 to 4). A step with `stages` runs only at those. */
  readonly stage: number;
  /** What is known about the ticket right now. A fact that is missing is "not known yet". */
  readonly facts: ConditionFacts;
}

const appliesAtStage = (step: ProcedureStep, stage: number): boolean =>
  step.stages === undefined || step.stages.includes(stage);

/**
 * The `tool` steps that run, in the order the procedure wrote them. A step whose `when` does not hold (or
 * names a fact that is not known before the tools ran, like `evidence.count`) is left out, and so is a second
 * step for a tool that already has one.
 */
export function selectToolSteps(
  procedure: ProcedureSteps,
  selection: ProcedureSelection,
): ProcedureToolStep[] {
  const seen = new Set<string>();
  const selected: ProcedureToolStep[] = [];
  for (const step of procedure.steps) {
    if (step.kind !== 'tool' || !appliesAtStage(step, selection.stage)) continue;
    if (!evaluateCondition(step.when, selection.facts, { unknown: false })) continue;
    if (seen.has(step.tool)) continue;
    seen.add(step.tool);
    selected.push(step);
  }
  return selected;
}

export interface ProcedureCheck {
  readonly stepId: string;
  readonly question: string;
}

/** The questions the investigator answers from the evidence: those that apply at this stage and have a tool step behind them that runs. */
export function selectChecks(
  procedure: ProcedureSteps,
  selection: ProcedureSelection,
  ranToolStepIds: ReadonlySet<string>,
): ProcedureCheck[] {
  return procedure.steps.flatMap((step) =>
    step.kind === 'check' &&
    appliesAtStage(step, selection.stage) &&
    step.evidenceFrom.some((id) => ranToolStepIds.has(id))
      ? [{ stepId: step.id, question: step.question }]
      : [],
  );
}

export interface ProcedureGuideline {
  readonly stepId: string;
  readonly text: string;
  readonly lang: 'th' | 'en' | undefined;
}

/** Stage 0 observes only and sends no guideline anywhere (ADR-026 section 5). */
export function selectGuidelines(
  procedure: ProcedureSteps,
  selection: ProcedureSelection,
): ProcedureGuideline[] {
  if (selection.stage <= 0) return [];
  return procedure.steps.flatMap((step) =>
    step.kind === 'reply_guideline' && appliesAtStage(step, selection.stage)
      ? [{ stepId: step.id, text: step.text, lang: step.lang }]
      : [],
  );
}

export interface ProcedureDisclosureRule {
  readonly stepId: string;
  readonly rule: 'never_mention' | 'verified_only';
  readonly topic: string;
}

/** Disclosure rules apply at every stage that has a procedure, including 0 and 1: a rule only ever makes a reply safer. */
export function selectDisclosureRules(
  procedure: ProcedureSteps,
  selection: ProcedureSelection,
): ProcedureDisclosureRule[] {
  return procedure.steps.flatMap((step) =>
    step.kind === 'disclosure' && appliesAtStage(step, selection.stage)
      ? [{ stepId: step.id, rule: step.rule, topic: step.topic }]
      : [],
  );
}

export type ProcedureEscalation = Pick<
  Extract<ProcedureStep, { kind: 'escalate' }>,
  'to' | 'priority' | 'note'
> & { readonly stepId: string };

export interface ProcedureRequireHuman {
  readonly stepId: string;
  readonly reason: string;
}

export interface ProcedureActions {
  readonly escalations: ProcedureEscalation[];
  readonly requireHuman: ProcedureRequireHuman[];
}

/**
 * The escalations to propose and the reasons a person must look, once the investigation is done (so
 * `evidence.count` and `investigation.hasLikelyCause` are known). An escalation whose fact is unknown is not
 * proposed; a `require_human` whose fact is unknown holds: it errs toward a person looking (ADR-026 section 2).
 */
export function selectActions(
  procedure: ProcedureSteps,
  selection: ProcedureSelection,
): ProcedureActions {
  const escalations: ProcedureEscalation[] = [];
  const requireHuman: ProcedureRequireHuman[] = [];
  for (const step of procedure.steps) {
    if (!appliesAtStage(step, selection.stage)) continue;
    if (step.kind === 'escalate') {
      if (evaluateCondition(step.when, selection.facts, { unknown: false })) {
        escalations.push({
          stepId: step.id,
          to: step.to,
          ...(step.priority === undefined ? {} : { priority: step.priority }),
          note: step.note,
        });
      }
    } else if (step.kind === 'require_human') {
      if (evaluateCondition(step.when, selection.facts, { unknown: true })) {
        requireHuman.push({ stepId: step.id, reason: step.reason });
      }
    }
  }
  return { escalations, requireHuman };
}

/**
 * Normalises text for a topic match: lower case, runs of space collapsed, so "Refund  Policy" finds "refund policy".
 * `[UNVERIFIED 60%]` a literal match is what a lead's `never_mention` topic gets: a paraphrase of the topic is not
 * caught here (the instruction in the drafter prompt asks the model to avoid the topic, this removes what is left).
 */
function normalised(text: string): string {
  return text.toLowerCase().replaceAll(/\s+/g, ' ').trim();
}

/**
 * Sentences that name a topic the procedure forbids for this reader. `never_mention` always; `verified_only`
 * unless the contact is verified. Returns what is kept and how many were removed. Runs after the code rules of
 * the system (`applyDisclosure`), so it can only remove more.
 */
export function applyProcedureDisclosure<T extends { readonly text: string }>(
  sentences: readonly T[],
  rules: readonly ProcedureDisclosureRule[],
  level: 'verified' | 'restricted',
): { kept: T[]; removed: number } {
  const topics = rules
    .filter((rule) => rule.rule === 'never_mention' || level !== 'verified')
    .map((rule) => normalised(rule.topic))
    .filter((topic) => topic !== '');
  if (topics.length === 0) return { kept: [...sentences], removed: 0 };
  const kept = sentences.filter((sentence) => {
    const text = normalised(sentence.text);
    return !topics.some((topic) => text.includes(topic));
  });
  return { kept, removed: sentences.length - kept.length };
}
