import {
  authorKbDraft,
  buildGradeFacts,
  classifyTicket,
  draftReply,
  gradeResolution,
  narrateElements,
  type AgentDeps,
  type AgentOutcome,
  type AiRunRecord,
  type InvestigationEvidence,
} from '@watchtower/ai';

import {
  PROMPT_OF_AGENT,
  type ClassifierCase,
  type DrafterCase,
  type EvalCase,
  type EvalSource,
  type GraderCase,
  type InsightCase,
  type KbAuthorCase,
} from './case.js';
import {
  checkClassifier,
  checkDrafter,
  checkGrader,
  checkInsight,
  checkKbAuthor,
  type Check,
} from './checks.js';
import { runAssistantCase } from './assistant-run.js';
import type { assistantCitationMetrics } from './assistant-citations.js';
import { caseTicketId, type Rig } from './rig.js';

export interface CaseResult {
  readonly id: string;
  readonly agent: EvalCase['agent'];
  readonly source: EvalSource;
  readonly intent: string | null;
  readonly promptId: string;
  readonly promptVersion: number;
  readonly promptHash: string;
  readonly pass: boolean;
  /** `ok`: the agent answered. `skipped`: no model call (guard, budget). `failed`: the answer was unusable. */
  readonly status: 'ok' | 'skipped' | 'failed';
  readonly reason: string | null;
  readonly checks: readonly Check[];
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Null when no call had a price (unknown, not zero). */
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly citationMetrics?: ReturnType<typeof assistantCitationMetrics>;
}

const statusOf = <T>(outcome: AgentOutcome<T>): Pick<CaseResult, 'status' | 'reason'> =>
  outcome.status === 'ok'
    ? { status: 'ok', reason: null }
    : { status: outcome.status, reason: outcome.reason };

async function classifier(deps: AgentDeps, item: ClassifierCase) {
  const outcome = await classifyTicket(deps, {
    ticketId: caseTicketId(item.id),
    scope: `eval:${item.id}`,
    channel: item.input.channel,
    subject: item.input.subject,
    body: item.input.body,
    intents: item.input.intents,
  });
  return {
    ...statusOf(outcome),
    checks: outcome.status === 'ok' ? checkClassifier(outcome.value, item.expect) : [],
  };
}

async function drafter(deps: AgentDeps, item: DrafterCase) {
  const evidence: InvestigationEvidence[] = item.input.evidence.map((card) => ({
    id: card.id,
    kind: card.kind,
    title: card.title,
    snippet: card.snippet,
    confidence: card.confidence,
    tool: card.tool,
    customerSafe: card.customerSafe,
    mock: card.mock,
    ...(card.href === undefined ? {} : { href: card.href }),
  }));
  const outcome = await draftReply(deps, {
    ticketId: caseTicketId(item.id),
    subject: item.input.subject,
    turns: item.input.turns,
    intentKey: item.input.intentKey,
    customerLanguage: item.input.customerLanguage,
    disclosure: item.input.disclosure,
    evidence,
  });
  return {
    ...statusOf(outcome),
    checks: outcome.status === 'ok' ? checkDrafter(outcome.value, item.expect) : [],
  };
}

async function grader(deps: AgentDeps, item: GraderCase) {
  const csat = item.input.csat ?? null;
  const built = buildGradeFacts({
    ticketKey: item.input.ticketKey,
    turns: item.input.turns,
    sentReply: item.input.sentReply,
    draftText: item.input.draftText,
    csat,
    kbCited: item.input.kbCited,
  });
  const outcome = await gradeResolution(deps, {
    ticketId: caseTicketId(item.id),
    intentKey: item.intent ?? null,
    locale: item.input.locale,
    facts: built.facts,
    hasDraft: built.hasDraft,
    csat,
    kbCited: item.input.kbCited,
  });
  return {
    ...statusOf(outcome),
    checks: outcome.status === 'ok' ? checkGrader(outcome.value, item.expect) : [],
  };
}

async function kbAuthor(deps: AgentDeps, item: KbAuthorCase) {
  const outcome = await authorKbDraft(deps, {
    ticketId: caseTicketId(item.id),
    subject: item.input.subject,
    turns: item.input.turns,
    intentKey: item.input.intentKey,
    knownIntents: item.input.knownIntents,
  });
  return {
    ...statusOf(outcome),
    checks: outcome.status === 'ok' ? checkKbAuthor(outcome.value, item.expect) : [],
  };
}

async function insightNarrator(deps: AgentDeps, item: InsightCase) {
  const outcome = await narrateElements(deps, {
    elements: item.input.elements,
    locales: item.input.locales,
    names: item.names ?? [],
    scope: `eval:${item.id}`,
  });
  return {
    ...(outcome.status === 'ok'
      ? { status: 'ok' as const, reason: null }
      : { status: outcome.status, reason: outcome.reason }),
    checks: outcome.status === 'ok' ? checkInsight(outcome, item) : [],
  };
}

function sum(
  runs: readonly AiRunRecord[],
): Pick<CaseResult, 'inputTokens' | 'outputTokens' | 'costUsd' | 'latencyMs'> {
  const priced = runs.filter((run) => run.costUsd !== null);
  return {
    inputTokens: runs.reduce((n, run) => n + run.inputTokens, 0),
    outputTokens: runs.reduce((n, run) => n + run.outputTokens, 0),
    costUsd: priced.length === 0 ? null : priced.reduce((n, run) => n + (run.costUsd ?? 0), 0),
    latencyMs: runs.reduce((n, run) => n + run.latencyMs, 0),
  };
}

/**
 * Runs one case through its agent with the given prompt pins and checks the answer. An agent that
 * does not answer (guard, budget, unusable output) is a failed case with the reason, never a pass and
 * never an exception that stops the whole run. A bug in the harness itself does throw.
 */
export async function runCase(
  rig: Rig,
  item: EvalCase,
  source: EvalSource,
  pins: Readonly<Record<string, number>>,
): Promise<CaseResult> {
  rig.select(item);
  rig.drainRuns();
  const deps = rig.depsFor(item, pins);
  const promptId = PROMPT_OF_AGENT[item.agent];
  const prompt = deps.prompts.latest(promptId);

  let outcome: {
    status: 'ok' | 'skipped' | 'failed';
    reason: string | null;
    checks: Check[];
    citationMetrics?: ReturnType<typeof assistantCitationMetrics>;
  };
  switch (item.agent) {
    case 'personal_assistant':
      outcome = await runAssistantCase(deps, item);
      break;
    case 'classifier':
      outcome = { ...(await classifier(deps, item)) };
      break;
    case 'drafter':
      outcome = { ...(await drafter(deps, item)) };
      break;
    case 'grader':
      outcome = { ...(await grader(deps, item)) };
      break;
    case 'kb_author':
      outcome = { ...(await kbAuthor(deps, item)) };
      break;
    case 'insight_narrator':
      outcome = { ...(await insightNarrator(deps, item)) };
      break;
  }
  const runs = rig.drainRuns();
  const checks =
    outcome.status === 'ok'
      ? outcome.checks
      : [{ name: 'agent answered', pass: false, detail: outcome.reason ?? outcome.status }];
  return {
    id: item.id,
    agent: item.agent,
    source,
    intent: item.intent ?? null,
    promptId,
    promptVersion: prompt.ref.version,
    promptHash: prompt.ref.hash,
    pass: checks.every((check) => check.pass),
    status: outcome.status,
    reason: outcome.reason,
    checks,
    ...(outcome.citationMetrics === undefined ? {} : { citationMetrics: outcome.citationMetrics }),
    calls: runs.length,
    ...sum(runs),
  };
}
