import { z } from 'zod';

import { renderTrustedPrompt } from '../redaction/redacted-text.js';
import type { RedactionSession } from '../redaction/redactor.js';
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

export const SUMMARIZER_PROMPT_ID = 'summarizer';

/** The steps the summarizer may suggest. `approve_draft` belongs to the drafter (T-108). */
export const SUMMARY_NEXT_STEP_KINDS = [
  'reply',
  'escalate_dev',
  'wait_customer',
  'resolve',
  'other',
] as const;

export const summarizerAnswerSchema = z.object({
  summary: z.string().trim().min(1).max(300),
  nextStep: z.object({
    kind: z.enum(SUMMARY_NEXT_STEP_KINDS),
    label: z.string().trim().min(1).max(120),
  }),
});

export interface TicketTurn {
  /** Who wrote it. Notes are internal; the summary is for staff, so they are included. */
  readonly from: 'customer' | 'staff' | 'note';
  readonly text: string;
}

export interface SummarizeTicketInput {
  readonly ticketId: string;
  /** Redaction scope: the ticket id. */
  readonly scope: string;
  readonly session?: RedactionSession;
  readonly subject: string;
  /** Oldest first. */
  readonly turns: readonly TicketTurn[];
  readonly intentKey?: string | null;
  readonly abortSignal?: AbortSignal;
}

export interface TicketSummary {
  /** One line, placeholders restored for staff; show it to staff only. */
  readonly summary: string;
  readonly nextStep: {
    readonly kind: (typeof SUMMARY_NEXT_STEP_KINDS)[number];
    readonly label: string;
  };
}

const MAX_SUBJECT_CHARS = 300;
const MAX_TURN_CHARS = 1500;
const MAX_TURNS = 12;

/**
 * Keeps the first turn (what the customer asked) and the latest ones (where it stands now); a
 * long thread is cut in the middle, never at the end.
 */
function pickTurns(turns: readonly TicketTurn[]): readonly TicketTurn[] {
  if (turns.length <= MAX_TURNS) return turns;
  return [...turns.slice(0, 1), ...turns.slice(turns.length - (MAX_TURNS - 1))];
}

function renderTicket(input: SummarizeTicketInput): string {
  const lines = [`Subject: ${clip(input.subject, MAX_SUBJECT_CHARS)}`];
  for (const turn of pickTurns(input.turns)) {
    lines.push(`[${turn.from}] ${clip(turn.text, MAX_TURN_CHARS)}`);
  }
  return `<ticket>\n${lines.join('\n')}\n</ticket>`;
}

/**
 * Summarizer (PRD section 6.2): a one-line summary and one next step for the person who opens the
 * ticket. Same rules as the classifier: guard first, ticket-scoped redaction, audited call, and
 * `skipped` / `failed` instead of throwing.
 */
export async function summarizeTicket(
  deps: AgentDeps,
  input: SummarizeTicketInput,
): Promise<AgentOutcome<TicketSummary>> {
  const decision = await askGuard(deps.guard, {
    agent: 'summarizer',
    ticketId: input.ticketId,
    action: 'summarize',
  });
  if (!decision.allowed) return { status: 'skipped', reason: decision.reason };

  const prompt = deps.prompts.latest(SUMMARIZER_PROMPT_ID);
  const session = sessionFor(deps, input.scope, input.session);
  let system;
  let ticket;
  try {
    system = renderTrustedPrompt(prompt, {}, (text) => session.redact(text));
    ticket = session.redact(renderTicket(input));
  } catch (error) {
    const reason = skippedFor(error);
    if (reason !== null) return { status: 'skipped', reason };
    throw error;
  }

  let result;
  try {
    result = await deps.llm.generate({
      agent: 'summarizer',
      prompt: prompt.ref,
      system,
      messages: [{ role: 'user', content: ticket }],
      redaction: session,
      ticketId: input.ticketId,
      intent: input.intentKey ?? null,
      maxOutputTokens: 400,
      temperature: 0,
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    });
  } catch (error) {
    return failedFor(error);
  }

  const parsed = summarizerAnswerSchema.safeParse(extractJsonObject(result.response.text));
  if (!parsed.success) return { status: 'failed', reason: 'model_output_invalid' };
  const restore = (text: string): string => session.restore(text, 'internal').text;
  return {
    status: 'ok',
    runId: result.runId,
    value: {
      summary: restore(parsed.data.summary),
      nextStep: { kind: parsed.data.nextStep.kind, label: restore(parsed.data.nextStep.label) },
    },
  };
}
