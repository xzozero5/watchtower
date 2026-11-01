import {
  aiNextStepKindSchema,
  type AiProgress,
  type AiReport,
  type AiNextStepKind,
} from '@watchtower/shared';
import { z } from 'zod';

import type { AutonomyStage } from '../contract.js';
import { renderPrompt } from '../prompts.js';
import { joinRedacted, type RedactedText } from '../redaction/redacted-text.js';
import type { RedactionSession } from '../redaction/redactor.js';
import type { BudgetedTools } from '../toolkit/budget.js';
import { TOOL_NAMES, SYSTEM_TOOLS } from '../toolkit/tools.js';
import { ToolBudgetError, ToolNotAllowedError } from '../tools.js';
import {
  askGuard,
  clip,
  extractJsonObject,
  failedFor,
  sessionFor,
  skippedFor,
  type AgentDeps,
  type AgentOutcome,
} from './common.js';
import { neutralizeTags } from './leak-check.js';
import { protectEvidence, rawEvidenceFrom, type InvestigationEvidence } from './evidence.js';
import type { TicketTurn } from './summarize.js';

export const INVESTIGATOR_PROMPT_ID = 'investigator';

/** What the intent scope rests on (SR106-R8). `none`: only the generic tools run. */
export type ScopeBasis = 'human_confirmed' | 'confidence' | 'none';

export const investigatorAnswerSchema = z.object({
  findings: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(300),
        evidenceIds: z.array(z.string().max(100)).max(10).default([]),
      }),
    )
    .max(12),
  likelyCause: z.string().trim().max(600).nullable().default(null),
  confidence: z.number().min(0).max(1),
  openQuestions: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
  nextStep: z.object({
    kind: aiNextStepKindSchema.exclude(['approve_draft']),
    label: z.string().trim().min(1).max(120),
  }),
});

export interface RunbookStep {
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

export interface RunbookContext {
  readonly intentKey: string | null;
  /** The subject and the first customer message: the words the tools search with. */
  readonly queryText: string;
}

const MAX_QUERY_CHARS = 300;

/**
 * The runbook of an intent as an ordered list of tool calls. The generic steps come first
 * (knowledge base, similar tickets, organization); the steps that reach a system outside Watchtower
 * follow, in the order the intent's `allowed_tools` names them. The inputs are built here from the
 * ticket, never chosen by a model: a prompt injection in a ticket cannot steer a tool (N2, SR106-R8).
 * `[ASSUMED]` until the service catalog exists (Phase 2), the "service" of the repo step and the
 * "template" of the data step are the intent key.
 */
export function planRunbook(context: RunbookContext, granted: readonly string[]): RunbookStep[] {
  const query = clip(context.queryText.replaceAll(/\s+/g, ' ').trim(), MAX_QUERY_CHARS) || 'ticket';
  const catalog: Record<string, RunbookStep | undefined> = {
    [TOOL_NAMES.kbSearch]: { tool: TOOL_NAMES.kbSearch, input: { query, limit: 3 } },
    [TOOL_NAMES.similarTickets]: { tool: TOOL_NAMES.similarTickets, input: { query, limit: 3 } },
    [TOOL_NAMES.orgContext]: { tool: TOOL_NAMES.orgContext, input: {} },
    [TOOL_NAMES.gcpLogs]: {
      tool: TOOL_NAMES.gcpLogs,
      input: { query, windowMinutes: 60, limit: 10 },
    },
  };
  if (context.intentKey !== null) {
    catalog[TOOL_NAMES.bigquery] = {
      tool: TOOL_NAMES.bigquery,
      input: { template: context.intentKey, limit: 20 },
    };
    catalog[TOOL_NAMES.repoChanges] = {
      tool: TOOL_NAMES.repoChanges,
      input: { service: context.intentKey, windowHours: 24 },
    };
  }
  const order = [
    TOOL_NAMES.kbSearch,
    TOOL_NAMES.similarTickets,
    TOOL_NAMES.orgContext,
    ...SYSTEM_TOOLS,
  ] as readonly string[];
  return order
    .filter((name) => granted.includes(name))
    .flatMap((name) => {
      const step = catalog[name];
      return step === undefined ? [] : [step];
    });
}

export interface InvestigateInput {
  readonly ticketId: string;
  readonly session?: RedactionSession;
  readonly channel: string;
  readonly subject: string;
  readonly turns: readonly TicketTurn[];
  readonly intentKey: string | null;
  readonly scopeBasis: ScopeBasis;
  readonly stage: AutonomyStage;
  /** The scoped, budgeted handle of this run (`withToolBudget`). */
  readonly tools: BudgetedTools;
  /** Called before each step so the web can show where the job is. */
  readonly onProgress?: (progress: AiProgress) => Promise<void>;
  readonly abortSignal?: AbortSignal;
}

export interface InvestigationResult {
  readonly report: AiReport;
  readonly evidence: readonly InvestigationEvidence[];
  readonly nextStep: { readonly kind: AiNextStepKind; readonly label: string };
  readonly session: RedactionSession;
}

const MAX_TURN_CHARS = 1500;
const MAX_TURNS = 8;

function renderTicket(input: InvestigateInput): string {
  const turns =
    input.turns.length <= MAX_TURNS
      ? input.turns
      : [...input.turns.slice(0, 1), ...input.turns.slice(input.turns.length - (MAX_TURNS - 1))];
  const lines = [`Subject: ${clip(neutralizeTags(input.subject), 300)}`];
  for (const turn of turns) {
    lines.push(`[${turn.from}] ${clip(neutralizeTags(turn.text), MAX_TURN_CHARS)}`);
  }
  return `<ticket>\n${lines.join('\n')}\n</ticket>`;
}

function reportConfidence(text: string): number | null {
  const parsed = investigatorAnswerSchema.safeParse(extractJsonObject(text));
  return parsed.success ? parsed.data.confidence : null;
}

/**
 * Investigator (PRD section 6.2, R-5.1 to R-5.3): runs the runbook of the ticket's intent with the
 * read-only tools it was granted, turns the answers into evidence cards, and asks the model for a
 * short report that cites them. Everything a tool returns reaches the model only through
 * `redactToolOutput` (N4), and the model never chooses a tool call. A tool that fails, is not
 * allowed or is over budget leaves a gap that the report lists; it does not stop the run. Like the
 * other agents it returns `skipped` or `failed` instead of throwing for a refusal or a bad answer.
 */
export async function investigateTicket(
  deps: AgentDeps,
  input: InvestigateInput,
): Promise<AgentOutcome<InvestigationResult>> {
  const decision = await askGuard(deps.guard, {
    agent: 'investigator',
    ticketId: input.ticketId,
    action: 'investigate',
  });
  if (!decision.allowed) return { status: 'skipped', reason: decision.reason };

  const session = sessionFor(deps, input.ticketId, input.session);
  // The ticket goes through the session first: a detail that is in the ticket and also in a tool result
  // is then the ticket's own (it keeps its origin), and only what is someone else's stays a placeholder.
  let ticketText: RedactedText;
  try {
    ticketText = session.redact(renderTicket(input));
  } catch (error) {
    const reason = skippedFor(error);
    if (reason !== null) return { status: 'skipped', reason };
    throw error;
  }
  const firstCustomer = input.turns.find((turn) => turn.from === 'customer')?.text ?? '';
  const steps = planRunbook(
    { intentKey: input.intentKey, queryText: `${input.subject} ${firstCustomer}` },
    input.tools.list().map((tool) => tool.name),
  );
  const total = steps.length + 1;
  const progress = async (step: number): Promise<void> => {
    await input.onProgress?.({ phase: 'investigating', step, steps: total });
  };

  const evidence: InvestigationEvidence[] = [];
  const forModel: RedactedText[] = [];
  const toolStatus: AiReport['tools'] = [];
  for (const [index, step] of steps.entries()) {
    await progress(index);
    const mock = input.tools.list().find((tool) => tool.name === step.tool)?.mock ?? false;
    try {
      const output = await input.tools.call(step.tool, step.input);
      toolStatus.push({ name: step.tool, status: 'ok', mock });
      const protectedCards = protectEvidence(
        session,
        rawEvidenceFrom(step.tool, output),
        evidence.length + 1,
      );
      for (const card of protectedCards) {
        evidence.push(card.card);
        forModel.push(card.forModel);
      }
    } catch (error) {
      const refused = skippedFor(error);
      if (refused !== null) return { status: 'skipped', reason: refused };
      const denied = error instanceof ToolBudgetError || error instanceof ToolNotAllowedError;
      toolStatus.push({ name: step.tool, status: denied ? 'denied' : 'error', mock });
    }
  }
  await progress(steps.length);

  const base = {
    tools: toolStatus,
    scope: { intent: input.intentKey, basis: input.scopeBasis },
  } as const;
  const prompt = deps.prompts.latest(INVESTIGATOR_PROMPT_ID);
  const version = `v${String(prompt.ref.version)}`;

  // Nothing found: there is nothing to cite, so no model call is spent (and none is invented).
  if (evidence.length === 0) {
    return {
      status: 'ok',
      runId: null,
      value: {
        evidence,
        session,
        nextStep: { kind: 'other', label: 'No evidence found. Read the ticket.' },
        report: {
          findings: [],
          likelyCause: null,
          confidence: 0,
          openQuestions: ['No tool returned evidence for this ticket.'],
          promptVersion: version,
          ...base,
        },
      },
    };
  }

  let system: RedactedText;
  let message: RedactedText;
  try {
    system = session.redact(renderPrompt(prompt.body, {}));
    message = joinRedacted(
      [
        ticketText,
        session.redact('<evidence>'),
        joinRedacted(forModel, '\n'),
        session.redact('</evidence>'),
      ],
      '\n',
    );
  } catch (error) {
    const reason = skippedFor(error);
    if (reason !== null) return { status: 'skipped', reason };
    throw error;
  }

  let result;
  try {
    result = await deps.llm.generate({
      agent: 'investigator',
      prompt: prompt.ref,
      system,
      messages: [{ role: 'user', content: message }],
      redaction: session,
      ticketId: input.ticketId,
      intent: input.intentKey,
      maxOutputTokens: 900,
      temperature: 0,
      toolCalls: () => input.tools.calls(),
      confidence: reportConfidence,
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    });
  } catch (error) {
    return failedFor(error);
  }

  const parsed = investigatorAnswerSchema.safeParse(extractJsonObject(result.response.text));
  if (!parsed.success) return { status: 'failed', reason: 'model_output_invalid' };
  const known = new Set(evidence.map((card) => card.id));
  // The `customer` audience: the ticket's own details come back, another customer's stay placeholders.
  const show = (text: string): string => session.restore(text, 'customer').text;
  const answer = parsed.data;
  return {
    status: 'ok',
    runId: result.runId,
    value: {
      evidence,
      session,
      nextStep: { kind: answer.nextStep.kind, label: show(answer.nextStep.label) },
      report: {
        findings: answer.findings.map((finding) => ({
          text: show(finding.text).slice(0, 600),
          // An id the model made up supports nothing: the finding then shows as uncited.
          evidenceIds: finding.evidenceIds.filter((id) => known.has(id)),
        })),
        likelyCause: answer.likelyCause === null ? null : show(answer.likelyCause).slice(0, 600),
        confidence: answer.confidence,
        openQuestions: answer.openQuestions.map((question) => show(question).slice(0, 300)),
        promptVersion: version,
        ...base,
      },
    },
  };
}
