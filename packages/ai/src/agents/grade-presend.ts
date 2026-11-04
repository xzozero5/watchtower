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
import { stripLinks } from './assistant.js';
import { neutralizeTags } from './leak-check.js';

export const PRE_SEND_GRADER_PROMPT_ID = 'grader_pre_send';

export const PRE_SEND_VIOLATION_CODES = [
  'disclosure',
  'promise',
  'unsupported_claim',
  'tone',
  'answer_mismatch',
  'other',
] as const;
export type PreSendViolationCode = (typeof PRE_SEND_VIOLATION_CODES)[number];

export interface PreSendSource {
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
}

export interface PreSendGradeInput {
  readonly ticketId: string;
  readonly session?: RedactionSession;
  readonly intentKey: string | null;
  readonly locale: 'th' | 'en';
  /** What the customer wrote, oldest first (the last few messages). */
  readonly customerTurns: readonly string[];
  /** The exact text that would go out, disclosure footer included. */
  readonly reply: string;
  /** Customer-facing knowledge base passages the reply cites. */
  readonly sources: readonly PreSendSource[];
  readonly abortSignal?: AbortSignal;
}

export interface PreSendViolation {
  readonly code: PreSendViolationCode;
  readonly text: string;
}

export interface PreSendGrade {
  /** 0..1, clamped. A reply with any violation is capped below 0.5 in code, whatever the model said. */
  readonly score: number;
  /** True only when the list of violations is empty. The score is judged separately against the intent's minimum. */
  readonly passed: boolean;
  readonly violations: readonly PreSendViolation[];
  readonly promptVersion: number;
  readonly mock: boolean;
}

const factIds = z.array(z.string().max(200)).max(20).default([]);
export const preSendAnswerSchema = z.object({
  score: z.number(),
  violations: z
    .array(
      z.object({
        code: z.string().max(40).default('other'),
        text: z.string().trim().min(1).max(600),
        factIds,
      }),
    )
    .max(10)
    .default([]),
});

const MAX_TURNS = 4;
const MAX_TURN_CHARS = 1200;
const MAX_SOURCES = 6;
const MAX_SOURCE_CHARS = 1200;
const MAX_REPLY_CHARS = 5000;

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/** A violation caps the score: the model cannot say "0.99, with problems". */
export const VIOLATION_SCORE_CEILING = 0.49;

/**
 * The independent check before an automatic send (ADR-025, PRD 6.6). It reads the customer's messages,
 * the passages the reply may rely on and the exact text that would go out, and answers a score and a
 * list of violations. It measures only: nothing here sends or changes anything (N3). The facts and the
 * reply pass through the redaction session before the model sees them (N4). The model's word is not
 * what lets a send through: the structural conditions of ADR-025 section 4 are checked in code, and a
 * run that failed, was refused or gave an unusable answer is no grade at all (never a pass).
 */
export async function gradePreSend(
  deps: AgentDeps,
  input: PreSendGradeInput,
): Promise<AgentOutcome<PreSendGrade>> {
  const decision = await askGuard(deps.guard, {
    agent: 'grader',
    ticketId: input.ticketId,
    action: 'grade_pre_send',
  });
  if (!decision.allowed) return { status: 'skipped', reason: decision.reason };

  const prompt = deps.prompts.latest(PRE_SEND_GRADER_PROMPT_ID);
  const session = sessionFor(deps, input.ticketId, input.session);
  const safe = (text: string): string =>
    neutralizeTags(text).replaceAll(/<(\/?\s*(?:facts|reply)\b)/gi, '‹$1');
  let system: RedactedText;
  let user: RedactedText;
  try {
    system = renderTrustedPrompt(
      prompt,
      { language: input.locale === 'th' ? 'Thai' : 'English' },
      session,
    );
    const lines: RedactedText[] = [];
    input.customerTurns.slice(-MAX_TURNS).forEach((turn, index) => {
      lines.push(
        clipRedacted(session.redact(`[f${String(index + 1)}] customer: ${safe(turn)}`), MAX_TURN_CHARS + 40),
      );
    });
    const offset = Math.min(input.customerTurns.length, MAX_TURNS);
    input.sources.slice(0, MAX_SOURCES).forEach((source, index) => {
      lines.push(
        clipRedacted(
          session.redact(
            `[f${String(offset + index + 1)}] source: ${safe(source.title)} - ${safe(source.snippet)}`,
          ),
          MAX_SOURCE_CHARS + 80,
        ),
      );
    });
    user = joinRedacted(
      [
        session.redact('<facts>'),
        ...lines,
        session.redact('</facts>'),
        session.redact('<reply>'),
        // Cut after redacting: a cut address or number is no longer recognized (N4).
        clipRedacted(session.redact(safe(input.reply)), MAX_REPLY_CHARS),
        session.redact('</reply>'),
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
      agent: 'grader',
      prompt: prompt.ref,
      system,
      messages: [{ role: 'user', content: user }],
      redaction: session,
      ticketId: input.ticketId,
      intent: input.intentKey,
      maxOutputTokens: 700,
      temperature: 0,
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    });
  } catch (error) {
    return failedFor(error);
  }

  const parsed = preSendAnswerSchema.safeParse(extractJsonObject(result.response.text));
  if (!parsed.success) return { status: 'failed', reason: 'model_output_invalid' };
  const violations: PreSendViolation[] = parsed.data.violations.map((item) => ({
    code: (PRE_SEND_VIOLATION_CODES as readonly string[]).includes(item.code)
      ? (item.code as PreSendViolationCode)
      : 'other',
    text: stripLinks(session.restore(item.text, 'internal').text).slice(0, 600),
  }));
  const raw = clamp01(parsed.data.score);
  const score = violations.length === 0 ? raw : Math.min(raw, VIOLATION_SCORE_CEILING);
  return {
    status: 'ok',
    runId: result.runId,
    value: {
      score: Math.round(score * 1000) / 1000,
      passed: violations.length === 0,
      violations,
      promptVersion: prompt.ref.version,
      mock: result.run.provider === 'mock',
    },
  };
}
