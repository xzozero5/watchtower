import { INBOUND_CLASSIFICATION_TYPES } from '@watchtower/shared';
import { z } from 'zod';

import type { PromptFile } from '../prompts.js';
import { renderPrompt } from '../prompts.js';
import { joinRedacted, type RedactedText } from '../redaction/redacted-text.js';
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

export const CLASSIFIER_PROMPT_ID = 'classifier';

export const classifierAnswerSchema = z.object({
  type: z.enum(INBOUND_CLASSIFICATION_TYPES),
  intentKey: z.string().min(1).max(120).nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500),
});

export interface KnownIntent {
  readonly key: string;
  readonly name: string;
}

export interface ClassifyTicketInput {
  /** Ticket id, or null when the message has no ticket yet (the ingest classifier). */
  readonly ticketId: string | null;
  /** Redaction scope: the ticket id, or `inbound:<message id>` before the ticket exists. */
  readonly scope: string;
  /** The session of the ticket, so the same value gets the same token in every agent. */
  readonly session?: RedactionSession;
  readonly channel: string;
  readonly subject: string;
  readonly body: string;
  /** The active intents the instance knows (key and name). */
  readonly intents: readonly KnownIntent[];
  readonly abortSignal?: AbortSignal;
}

/** What the classifier gets when the text has already been through the session (the ingest hook). */
export interface ClassifyRedactedInput {
  readonly ticketId: string | null;
  /** The session `subject` and `body` came from: the audit counts come from it. */
  readonly session: RedactionSession;
  readonly channel: string;
  readonly subject: RedactedText;
  readonly body: RedactedText;
  readonly intents: readonly KnownIntent[];
  readonly abortSignal?: AbortSignal;
}

export interface TicketClassification {
  readonly type: (typeof INBOUND_CLASSIFICATION_TYPES)[number];
  /** A key from `intents`, or null. An unknown key from the model becomes null. */
  readonly intentKey: string | null;
  readonly confidence: number;
  /** Placeholders restored for staff; show it to staff only. */
  readonly reason: string;
}

const MAX_SUBJECT_CHARS = 500;
const MAX_BODY_CHARS = 4000;
const MAX_INTENTS = 200;

/** One line per intent. The `*` bullet and `key: name` shape are what the dev mock parses. */
export function renderIntentList(intents: readonly KnownIntent[]): string {
  if (intents.length === 0) return '(no intents are defined: answer null)';
  return intents
    .slice(0, MAX_INTENTS)
    .map((intent) => `* ${intent.key}: ${intent.name.replaceAll(/\s+/g, ' ').slice(0, 80)}`)
    .join('\n');
}

function confidenceOf(text: string): number | null {
  const parsed = classifierAnswerSchema.safeParse(extractJsonObject(text));
  return parsed.success ? parsed.data.confidence : null;
}

function frame(
  session: RedactionSession,
  channel: string,
  subject: RedactedText,
  body: RedactedText,
): RedactedText {
  return joinRedacted(
    [
      session.redact(`<message channel="${channel.replaceAll(/[^a-z_]/g, '')}">`),
      joinRedacted([session.redact('Subject:'), subject], ' '),
      body,
      session.redact('</message>'),
    ],
    '\n',
  );
}

/**
 * Classifier (stage 0, PRD section 6.2): what kind of message is this and which intent fits. Reads
 * the message through the ticket's redaction session, asks the guard first, and goes through the
 * audited LLM so the call leaves an `ai_run` row. It never throws for a refusal or a bad answer;
 * it returns `skipped` (no model call) or `failed`.
 */
export async function classifyTicket(
  deps: AgentDeps,
  input: ClassifyTicketInput,
): Promise<AgentOutcome<TicketClassification>> {
  const decision = await askGuard(deps.guard, {
    agent: 'classifier',
    ticketId: input.ticketId,
    action: 'classify',
  });
  if (!decision.allowed) return { status: 'skipped', reason: decision.reason };

  const session = sessionFor(deps, input.scope, input.session);
  let message: RedactedText;
  try {
    message = frame(
      session,
      input.channel,
      session.redact(clip(input.subject, MAX_SUBJECT_CHARS)),
      session.redact(clip(input.body, MAX_BODY_CHARS)),
    );
  } catch (error) {
    const reason = skippedFor(error);
    if (reason !== null) return { status: 'skipped', reason };
    throw error;
  }
  return runClassifier(deps, session, input, message);
}

/**
 * The same, for text that is already redacted (the ingest hook redacts subject and body itself
 * before it hands them over). Do not redact twice: a second pass would escape the placeholders.
 */
export async function classifyRedacted(
  deps: AgentDeps,
  input: ClassifyRedactedInput,
): Promise<AgentOutcome<TicketClassification>> {
  const decision = await askGuard(deps.guard, {
    agent: 'classifier',
    ticketId: input.ticketId,
    action: 'classify',
  });
  if (!decision.allowed) return { status: 'skipped', reason: decision.reason };

  let message: RedactedText;
  try {
    message = frame(input.session, input.channel, input.subject, input.body);
  } catch (error) {
    const reason = skippedFor(error);
    if (reason !== null) return { status: 'skipped', reason };
    throw error;
  }
  return runClassifier(deps, input.session, input, message);
}

async function runClassifier(
  deps: AgentDeps,
  session: RedactionSession,
  input: {
    readonly ticketId: string | null;
    readonly intents: readonly KnownIntent[];
    readonly abortSignal?: AbortSignal | undefined;
  },
  message: RedactedText,
): Promise<AgentOutcome<TicketClassification>> {
  const prompt: PromptFile = deps.prompts.latest(CLASSIFIER_PROMPT_ID);
  let system: RedactedText;
  try {
    system = session.redact(
      renderPrompt(prompt.body, { intents: renderIntentList(input.intents) }),
    );
  } catch (error) {
    const reason = skippedFor(error);
    if (reason !== null) return { status: 'skipped', reason };
    throw error;
  }

  let result;
  try {
    result = await deps.llm.generate({
      agent: 'classifier',
      prompt: prompt.ref,
      system,
      messages: [{ role: 'user', content: message }],
      redaction: session,
      ticketId: input.ticketId,
      maxOutputTokens: 300,
      temperature: 0,
      confidence: confidenceOf,
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    });
  } catch (error) {
    return failedFor(error);
  }

  const parsed = classifierAnswerSchema.safeParse(extractJsonObject(result.response.text));
  if (!parsed.success) return { status: 'failed', reason: 'model_output_invalid' };
  const known = new Set(input.intents.map((intent) => intent.key));
  const answer = parsed.data;
  return {
    status: 'ok',
    runId: result.runId,
    value: {
      type: answer.type,
      intentKey: answer.intentKey !== null && known.has(answer.intentKey) ? answer.intentKey : null,
      confidence: answer.confidence,
      reason: session.restore(answer.reason, 'internal').text,
    },
  };
}
