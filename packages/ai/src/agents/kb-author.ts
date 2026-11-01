import { z } from 'zod';

import { renderPrompt } from '../prompts.js';
import type { RedactedText } from '../redaction/redacted-text.js';
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
import { neutralizeTags } from './leak-check.js';
import type { TicketTurn } from './summarize.js';

export const KB_AUTHOR_PROMPT_ID = 'kb_author';

export const kbAuthorAnswerSchema = z.object({
  title: z.string().trim().max(300),
  bodyMd: z.string().trim().max(6000),
  intentTags: z.array(z.string().max(63)).max(5).default([]),
  kind: z.enum(['article', 'runbook']).default('article'),
});

export interface KbAuthorInput {
  readonly ticketId: string;
  readonly session?: RedactionSession;
  readonly subject: string;
  readonly turns: readonly TicketTurn[];
  readonly intentKey: string | null;
  /** Intent keys that exist, so a made-up tag is dropped. */
  readonly knownIntents: readonly string[];
  readonly abortSignal?: AbortSignal;
}

export interface KbAuthorDraft {
  readonly title: string;
  readonly bodyMd: string;
  readonly intentTags: readonly string[];
  readonly kind: 'article' | 'runbook';
  readonly promptVersion: number;
}

const MAX_TURN_CHARS = 1500;
const MAX_TURNS = 12;
const INTENT_TAG = /^[a-z][a-z0-9_]{1,62}$/;
/** A redaction placeholder left in the text: a customer's detail must never reach a shared article. */
const PLACEHOLDER = /\[[A-Z][A-Z_]*_\d+\]/;

/**
 * KB Author (PRD section 6.2, AC-4): drafts an article from a resolved ticket that cited nothing.
 * The text is a draft for review, never published by the AI. Unlike the other agents it never
 * restores placeholders: an article is shared with other customers' agents (and maybe customers), so
 * a placeholder in the answer is a failed answer, not something to fill in. `value: null` means the
 * ticket did not hold enough to write from.
 */
export async function authorKbDraft(
  deps: AgentDeps,
  input: KbAuthorInput,
): Promise<AgentOutcome<KbAuthorDraft | null>> {
  const decision = await askGuard(deps.guard, {
    agent: 'kb_author',
    ticketId: input.ticketId,
    action: 'kb_author',
  });
  if (!decision.allowed) return { status: 'skipped', reason: decision.reason };

  const prompt = deps.prompts.latest(KB_AUTHOR_PROMPT_ID);
  const session = sessionFor(deps, input.ticketId, input.session);
  let system: RedactedText;
  let message: RedactedText;
  try {
    system = session.redact(renderPrompt(prompt.body, {}));
    const turns =
      input.turns.length <= MAX_TURNS
        ? input.turns
        : [...input.turns.slice(0, 1), ...input.turns.slice(input.turns.length - (MAX_TURNS - 1))];
    const lines = [`Subject: ${clip(neutralizeTags(input.subject), 300)}`];
    for (const turn of turns) {
      lines.push(`[${turn.from}] ${clip(neutralizeTags(turn.text), MAX_TURN_CHARS)}`);
    }
    message = session.redact(`<ticket>\n${lines.join('\n')}\n</ticket>`);
  } catch (error) {
    const reason = skippedFor(error);
    if (reason !== null) return { status: 'skipped', reason };
    throw error;
  }

  let result;
  try {
    result = await deps.llm.generate({
      agent: 'kb_author',
      prompt: prompt.ref,
      system,
      messages: [{ role: 'user', content: message }],
      redaction: session,
      ticketId: input.ticketId,
      intent: input.intentKey,
      maxOutputTokens: 1500,
      temperature: 0.2,
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    });
  } catch (error) {
    return failedFor(error);
  }

  const parsed = kbAuthorAnswerSchema.safeParse(extractJsonObject(result.response.text));
  if (!parsed.success) return { status: 'failed', reason: 'model_output_invalid' };
  const answer = parsed.data;
  if (answer.title === '' || answer.bodyMd === '') {
    return { status: 'ok', runId: result.runId, value: null };
  }
  if (PLACEHOLDER.test(answer.title) || PLACEHOLDER.test(answer.bodyMd)) {
    return { status: 'failed', reason: 'model_output_invalid' };
  }
  const known = new Set(input.knownIntents);
  const tags = answer.intentTags.filter((tag) => INTENT_TAG.test(tag) && known.has(tag));
  if (input.intentKey !== null && !tags.includes(input.intentKey) && known.has(input.intentKey)) {
    tags.push(input.intentKey);
  }
  return {
    status: 'ok',
    runId: result.runId,
    value: {
      title: answer.title.slice(0, 300),
      bodyMd: answer.bodyMd,
      intentTags: tags.slice(0, 5),
      kind: answer.kind,
      promptVersion: prompt.ref.version,
    },
  };
}
