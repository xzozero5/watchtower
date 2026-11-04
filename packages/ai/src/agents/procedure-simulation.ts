import {
  PROCEDURE_SIMULATION,
  judgeSimulation,
  type AiInsightReason,
  type ConditionFacts,
  type ProcedureSimulationCase,
  type ProcedureSimulationMetrics,
  type ProcedureSteps,
} from '@watchtower/shared';

import type { AutonomyStage } from '../contract.js';
import type { BudgetedTools } from '../toolkit/budget.js';
import type { AgentDeps } from './common.js';
import { draftReply, type DisclosureLevel, type DraftResult } from './draft.js';
import { buildGradeFacts, gradeResolution } from './grade.js';
import { investigateTicket, planRunbook, type InvestigationResult } from './investigate.js';
import {
  applyProcedureDisclosure,
  selectDisclosureRules,
  selectGuidelines,
} from './procedure-plan.js';
import type { TicketTurn } from './summarize.js';

/**
 * Simulation of a procedure version before it is published (T-303d, ADR-026 section 6). For each resolved
 * ticket it runs the investigator and the drafter twice: with the steps of the version under test and with the
 * version live now (or the default runbook), then compares what each drafted with the reply a person really
 * sent, and has the grader look for a policy violation in the new draft. The tools are whatever `toolsFor`
 * hands in: read-only, budgeted tools of the instance in the worker (bucket `simulation`), fixtures in CI.
 * Nothing here is sent to a customer or written to a ticket (N2, N3): the output is numbers.
 */

export interface SimulationCaseInput {
  /** Uuid of the ticket (or of the fixture): the audit rows of the run point at it. */
  readonly ticketId: string;
  /** For the chips of the grader, for example `OPS-12`. */
  readonly ticketKey: string;
  readonly seeded: boolean;
  readonly channel: string;
  readonly subject: string;
  /** The conversation up to the first reply of a person: what the AI would have seen. */
  readonly turns: readonly TicketTurn[];
  /** The reply a person sent, in plain text (what the draft is compared with). */
  readonly humanReply: string;
  readonly intentKey: string | null;
  readonly stage: AutonomyStage;
  readonly customerLanguage: 'th' | 'en';
  readonly disclosure: DisclosureLevel;
  /** What is known before the tools run (the `when` of a step). */
  readonly facts: ConditionFacts;
}

export interface SimulationVariant {
  /** The version id; null is the default runbook (no procedure). */
  readonly versionId: string | null;
  readonly steps: ProcedureSteps | undefined;
}

export interface SimulationEnv {
  /** The agents of one case: its redaction dictionary (the names of the people on the ticket). */
  agentsFor(input: SimulationCaseInput): AgentDeps;
  /** A fresh read-only, budgeted handle for one run of one variant. */
  toolsFor(input: SimulationCaseInput, variant: 'candidate' | 'baseline'): BudgetedTools;
  readonly mode: 'instance' | 'fixture';
  readonly abortSignal?: AbortSignal | undefined;
}

export type SimulationOutcome =
  | {
      readonly status: 'ok';
      readonly passed: boolean;
      readonly metrics: ProcedureSimulationMetrics;
    }
  | { readonly status: 'stopped'; readonly reason: AiInsightReason | 'tool_ceiling' };

const MAX_COMPARED_CHARS = 1500;

/**
 * Levenshtein distance between two texts over their first 1500 characters, as a share of the longer one,
 * 0 (the same) to 100 (nothing in common). Case and runs of space do not count. `[ASSUMED]` a character-level
 * measure is enough for a Thai or an English reply; it does not know two wordings can mean the same.
 */
export function normalizedEditDistance(a: string, b: string): number {
  const left = Array.from(a.toLowerCase().replaceAll(/\s+/g, ' ').trim()).slice(
    0,
    MAX_COMPARED_CHARS,
  );
  const right = Array.from(b.toLowerCase().replaceAll(/\s+/g, ' ').trim()).slice(
    0,
    MAX_COMPARED_CHARS,
  );
  const longest = Math.max(left.length, right.length);
  if (longest === 0) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return Math.round(((previous[right.length] ?? 0) / longest) * 1000) / 10;
}

interface VariantRun {
  readonly draft: DraftResult;
  readonly evidence: InvestigationResult['evidence'];
  readonly toolStatus: ReadonlyMap<string, 'ok' | 'error' | 'denied'>;
  readonly calls: number;
}

type RunResult =
  | { readonly kind: 'ok'; readonly run: VariantRun }
  | { readonly kind: 'failed' }
  | { readonly kind: 'stop'; readonly reason: AiInsightReason };

async function runVariant(
  env: SimulationEnv,
  input: SimulationCaseInput,
  which: 'candidate' | 'baseline',
  variant: SimulationVariant,
): Promise<RunResult> {
  const agents = env.agentsFor(input);
  const tools = env.toolsFor(input, which);
  const procedure =
    variant.steps === undefined || variant.versionId === null
      ? undefined
      : { versionId: variant.versionId, steps: variant.steps, facts: input.facts };
  const investigated = await investigateTicket(agents, {
    ticketId: input.ticketId,
    channel: input.channel,
    subject: input.subject,
    turns: input.turns,
    intentKey: input.intentKey,
    scopeBasis: input.intentKey === null ? 'none' : 'human_confirmed',
    stage: input.stage,
    procedure,
    tools,
    ...(env.abortSignal === undefined ? {} : { abortSignal: env.abortSignal }),
  });
  if (investigated.status === 'skipped') return { kind: 'stop', reason: investigated.reason };
  if (investigated.status === 'failed') {
    return investigated.reason === 'provider_offline'
      ? { kind: 'stop', reason: investigated.reason }
      : { kind: 'failed' };
  }
  const selection = { stage: input.stage, facts: input.facts };
  const drafted = await draftReply(agents, {
    ticketId: input.ticketId,
    subject: input.subject,
    turns: input.turns,
    intentKey: input.intentKey,
    customerLanguage: input.customerLanguage,
    disclosure: input.disclosure,
    evidence: investigated.value.evidence,
    procedure:
      variant.steps === undefined || variant.versionId === null
        ? undefined
        : {
            versionId: variant.versionId,
            guidelines: selectGuidelines(variant.steps, selection),
            disclosure: selectDisclosureRules(variant.steps, selection),
          },
    ...(env.abortSignal === undefined ? {} : { abortSignal: env.abortSignal }),
  });
  if (drafted.status === 'skipped') return { kind: 'stop', reason: drafted.reason };
  if (drafted.status === 'failed') {
    return drafted.reason === 'provider_offline'
      ? { kind: 'stop', reason: drafted.reason }
      : { kind: 'failed' };
  }
  return {
    kind: 'ok',
    run: {
      draft: drafted.value,
      evidence: investigated.value.evidence,
      toolStatus: new Map(investigated.value.report.tools.map((tool) => [tool.name, tool.status])),
      calls: tools.calls().length,
    },
  };
}

const mean = (values: readonly number[]): number =>
  values.length === 0
    ? 0
    : Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;

/**
 * Runs the simulation. `baseline` is the version live now, or `{ versionId: null, steps: undefined }` for the
 * default runbook. A guard refusal (kill switch, daily budget), an offline provider or the tool ceiling stops
 * the whole run: a half-finished simulation must not look like a pass.
 */
export async function runProcedureSimulation(
  env: SimulationEnv,
  options: {
    readonly cases: readonly SimulationCaseInput[];
    readonly candidate: SimulationVariant & { readonly steps: ProcedureSteps };
    readonly baseline: SimulationVariant;
    readonly maxToolCalls?: number;
  },
): Promise<SimulationOutcome> {
  const ceiling = options.maxToolCalls ?? PROCEDURE_SIMULATION.maxToolCalls;
  const { candidate, baseline } = options;
  const toolSteps = candidate.steps.steps.flatMap((step) => (step.kind === 'tool' ? [step] : []));
  const planned = new Set<string>();
  const worked = new Set<string>();
  const rows: ProcedureSimulationCase[] = [];
  /** The cases both variants could draft: the only ones the two are compared on. */
  const pairs: { distance: number; baseDistance: number; uncited: number; baseUncited: number }[] =
    [];
  const candidateDistances: number[] = [];
  let violations = 0;
  let leaks = 0;
  let failed = 0;
  let calls = 0;

  for (const input of options.cases) {
    if (calls > ceiling) return { status: 'stopped', reason: 'tool_ceiling' };
    const left = await runVariant(env, input, 'candidate', candidate);
    if (left.kind === 'stop') return { status: 'stopped', reason: left.reason };
    if (left.kind === 'ok') calls += left.run.calls;
    const right = await runVariant(env, input, 'baseline', baseline);
    if (right.kind === 'stop') return { status: 'stopped', reason: right.reason };
    if (right.kind === 'ok') calls += right.run.calls;

    if (left.kind !== 'ok') {
      failed += 1;
      rows.push({
        ticketId: input.ticketId,
        seeded: input.seeded,
        ok: false,
        editDistance: null,
        baselineEditDistance: null,
        uncitedClaims: 0,
        violations: 0,
        disclosureLeaks: 0,
      });
      continue;
    }
    const mine = left.run;

    // Which tool steps were planned for this ticket and which of them worked.
    const plan = planRunbook(
      {
        intentKey: input.intentKey,
        queryText: `${input.subject} ${input.turns.find((turn) => turn.from === 'customer')?.text ?? ''}`,
        stage: input.stage,
        facts: input.facts,
      },
      [...mine.toolStatus.keys()],
      candidate.steps,
    );
    for (const step of plan) {
      if (step.stepId === undefined) continue;
      planned.add(step.stepId);
      if (mine.toolStatus.get(step.tool) === 'ok') worked.add(step.stepId);
    }

    const grade = await gradeResolution(env.agentsFor(input), {
      ticketId: input.ticketId,
      intentKey: input.intentKey,
      locale: input.customerLanguage,
      ...buildGradeFacts({
        ticketKey: input.ticketKey,
        turns: input.turns,
        draftText: mine.draft.body,
        csat: null,
        kbCited: false,
        sentReply: input.humanReply,
      }),
      csat: null,
      kbCited: false,
      ...(env.abortSignal === undefined ? {} : { abortSignal: env.abortSignal }),
    });
    if (grade.status === 'skipped') return { status: 'stopped', reason: grade.reason };
    const gradeFailed = grade.status === 'failed';
    if (grade.status === 'failed' && grade.reason === 'provider_offline') {
      return { status: 'stopped', reason: grade.reason };
    }
    const caseViolations = grade.status === 'ok' ? grade.value.violations.length : 0;
    const disclosureViolations =
      grade.status === 'ok'
        ? grade.value.violations.filter((violation) => violation.code === 'disclosure').length
        : 0;
    // The same rules the drafter enforces, applied to what it wrote: a topic that is still there is a leak.
    const rules = selectDisclosureRules(candidate.steps, {
      stage: input.stage,
      facts: input.facts,
    });
    const leaked =
      applyProcedureDisclosure([{ text: mine.draft.body }], rules, input.disclosure).removed > 0
        ? 1
        : 0;
    const caseLeaks = Math.max(leaked, disclosureViolations);

    const distance = normalizedEditDistance(mine.draft.body, input.humanReply);
    const baseDistance =
      right.kind === 'ok' ? normalizedEditDistance(right.run.draft.body, input.humanReply) : null;
    if (gradeFailed) failed += 1;
    candidateDistances.push(distance);
    if (right.kind === 'ok' && baseDistance !== null && !gradeFailed) {
      pairs.push({
        distance,
        baseDistance,
        uncited: mine.draft.uncitedClaims,
        baseUncited: right.run.draft.uncitedClaims,
      });
    }
    violations += caseViolations;
    leaks += caseLeaks;
    rows.push({
      ticketId: input.ticketId,
      seeded: input.seeded,
      ok: !gradeFailed,
      editDistance: distance,
      baselineEditDistance: baseDistance,
      uncitedClaims: mine.draft.uncitedClaims,
      violations: caseViolations,
      disclosureLeaks: caseLeaks,
    });
  }

  const deadSteps = toolSteps
    .map((step) => step.id)
    .filter((id) => planned.has(id) && !worked.has(id));
  const caseCount = options.cases.length;
  const sum = (values: readonly number[]): number =>
    values.reduce((total, value) => total + value, 0);
  const base = {
    mode: env.mode,
    caseCount,
    failedCases: failed,
    seededCases: options.cases.filter((item) => item.seeded).length,
    // The comparison with the baseline counts only the cases both could draft: one that failed says nothing.
    candidate: {
      editDistance: mean(pairs.map((pair) => pair.distance)),
      uncitedClaims: sum(pairs.map((pair) => pair.uncited)),
      drafted: candidateDistances.length,
      violations,
      disclosureLeaks: leaks,
    },
    baseline:
      caseCount === 0
        ? null
        : {
            editDistance: mean(pairs.map((pair) => pair.baseDistance)),
            uncitedClaims: sum(pairs.map((pair) => pair.baseUncited)),
            drafted: pairs.length,
          },
    baselineVersionId: baseline.versionId,
    deadSteps,
    toolCalls: calls,
    cases: rows,
  };
  const failReasons = judgeSimulation(base);
  return { status: 'ok', passed: failReasons.length === 0, metrics: { ...base, failReasons } };
}
