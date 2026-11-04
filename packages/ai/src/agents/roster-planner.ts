import { z } from 'zod';

import { clipRedacted, joinRedacted, renderTrustedPrompt } from '../redaction/redacted-text.js';
import type { RedactedText } from '../redaction/redacted-text.js';
import type { RedactionSession } from '../redaction/redactor.js';
import {
  askGuard,
  extractJsonObject,
  failedFor,
  sessionFor,
  skippedFor,
  type AgentDeps,
  type AgentOutcome,
} from './common.js';

export const ROSTER_PLANNER_PROMPT_ID = 'roster_planner';

/** A redaction placeholder in an answer: it would reach the lead as an unreadable token. */
const PLACEHOLDER = /\[[A-Z][A-Z_]*_\d+\]/;
const MAX_FACTS_CHARS = 12_000;
export const MAX_EXPLANATION_CHARS = 1500;

/**
 * The plan as the API prepares it for the model. People are labels (`staff-1`), never names: the API puts the
 * names back after the answer, so no staff name leaves the system. Everything here is derived by the
 * deterministic solver; the model adds no fact.
 */
export interface RosterExplainFacts {
  readonly weekStart: string;
  readonly solverStatus: 'complete' | 'no_solution' | 'unproven';
  readonly rules: Readonly<Record<string, number>>;
  readonly shifts: readonly {
    readonly name: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly onCall: boolean;
  }[];
  readonly loads: readonly {
    readonly label: string;
    readonly shifts: number;
    readonly nights: number;
    readonly heavyDays: number;
  }[];
  readonly days: readonly {
    readonly date: string;
    readonly shifts: readonly {
      readonly shift: string;
      readonly people: readonly string[];
    }[];
  }[];
  readonly checks: readonly {
    readonly id: string;
    readonly status: 'pass' | 'fail';
    readonly failures: readonly {
      readonly code: string;
      readonly label: string | null;
      readonly date: string | null;
      readonly shift: string | null;
      readonly params: Readonly<Record<string, number | string>>;
    }[];
  }[];
}

export interface RosterExplainInput {
  /** Scopes the redaction session. */
  readonly planId: string;
  readonly locale: 'th' | 'en';
  readonly facts: RosterExplainFacts;
  readonly session?: RedactionSession;
  readonly abortSignal?: AbortSignal;
}

export interface RosterExplainResult {
  readonly explanation: string;
  readonly promptVersion: number;
}

export const rosterExplainAnswerSchema = z.object({
  explanation: z.string().trim().min(1).max(MAX_EXPLANATION_CHARS),
});

/** Shift names are typed by a lead; our own closing tag in one must not be able to end the data block. */
const neutralizeTags = (value: string): string => value.replaceAll(/<(\/?\s*plan\b)/gi, '‹$1');

/**
 * Roster planner explainer (PRD R-7.2): says in words what a plan the solver made does and where to look. It
 * explains only: it has no way to change the plan, the roster or any ticket. The facts pass through the
 * redaction session before the model sees them (N4) and the call is audited by the shared runtime. When the
 * model is not reachable the result is `skipped` or `failed` and the caller shows the plan without the text.
 */
export async function explainRoster(
  deps: AgentDeps,
  input: RosterExplainInput,
): Promise<AgentOutcome<RosterExplainResult>> {
  const scope = `roster_plan:${input.planId}`;
  const decision = await askGuard(deps.guard, {
    agent: 'roster_planner',
    ticketId: null,
    action: 'roster.explain',
  });
  if (!decision.allowed) return { status: 'skipped', reason: decision.reason };

  const prompt = deps.prompts.latest(ROSTER_PLANNER_PROMPT_ID);
  const session = sessionFor(deps, scope, input.session);
  let system: RedactedText;
  let user: RedactedText;
  try {
    system = renderTrustedPrompt(
      prompt,
      { language: input.locale === 'th' ? 'Thai' : 'English' },
      session,
    );
    const facts = session.redact(neutralizeTags(JSON.stringify(input.facts)));
    user = joinRedacted(
      [
        session.redact('<plan>'),
        // Cut after redacting: a cut value is no longer recognized (N4).
        clipRedacted(facts, MAX_FACTS_CHARS),
        session.redact('</plan>'),
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
      agent: 'roster_planner',
      prompt: prompt.ref,
      system,
      messages: [{ role: 'user', content: user }],
      redaction: session,
      ticketId: null,
      maxOutputTokens: 900,
      temperature: 0,
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    });
  } catch (error) {
    return failedFor(error);
  }

  const parsed = rosterExplainAnswerSchema.safeParse(extractJsonObject(result.response.text));
  if (!parsed.success || PLACEHOLDER.test(parsed.data.explanation)) {
    return { status: 'failed', reason: 'model_output_invalid' };
  }
  return {
    status: 'ok',
    runId: result.runId,
    value: { explanation: parsed.data.explanation, promptVersion: prompt.ref.version },
  };
}
