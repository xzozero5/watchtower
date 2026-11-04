import {
  PROCEDURE_LIMITS,
  PROCEDURE_TOOL_NAMES,
  procedureStepsSchema,
  type ProcedureSteps,
} from '@watchtower/shared';
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

export const PROCEDURE_COMPILER_PROMPT_ID = 'procedure_compiler';

/** A redaction placeholder in an answer: the author's detail must not end up inside a shared procedure. */
const PLACEHOLDER = /\[[A-Z][A-Z_]*_\d+\]/;
/** Characters of the source after redaction; the source is capped at 8 KB before it gets here. */
const MAX_SOURCE_CHARS = PROCEDURE_LIMITS.maxSourceBytes;
const MAX_CATALOG_ITEMS = 60;

export interface ProcedureCompileInput {
  /** The intent the procedure is for. Scopes the redaction session. */
  readonly intentId: string;
  readonly intentKey: string;
  /** What the author wrote. Redacted here before any model sees it (N4). */
  readonly sourceMd: string;
  /** The tools this intent may use: the generic ones and `intent.allowed_tools`. */
  readonly tools: readonly string[];
  readonly templates: readonly { readonly name: string; readonly kind: 'logs' | 'data' }[];
  readonly queueKeys: readonly string[];
  readonly session?: RedactionSession;
  readonly abortSignal?: AbortSignal;
}

export interface ProcedureCompileResult {
  readonly steps: ProcedureSteps;
  /** What the model says it guessed; shown to the person who confirms. */
  readonly assumptions: readonly string[];
  readonly promptVersion: number;
}

export const procedureCompilerAnswerSchema = z.object({
  steps: procedureStepsSchema,
  assumptions: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
});

/** The author could write our own closing tag and speak as the prompt: the angle bracket is replaced (SR108 P2). */
const neutralizeTags = (value: string): string =>
  value.replaceAll(/<(\/?\s*(?:procedure|catalog|ticket|evidence|report)\b)/gi, '‹$1');
const oneLine = (value: string): string => neutralizeTags(value).replaceAll(/\s+/g, ' ').trim();

/**
 * Procedure compiler (PRD 6.3, ADR-026 section 3): reads the natural-language procedure of an intent and
 * drafts the steps. The AI drafts and a person confirms; nothing here changes an intent, a ticket or a
 * customer message (N3). The text passes through the redaction session before the model sees it (N4), the
 * answer must satisfy the strict step schema (no field for a query, a free input or a looser rule), and an
 * answer that carries a placeholder is refused. Whether the tools, templates and queues it names exist is
 * not decided here: the domain validates that, and the person sees the problems before confirming.
 */
export async function compileProcedure(
  deps: AgentDeps,
  input: ProcedureCompileInput,
): Promise<AgentOutcome<ProcedureCompileResult>> {
  const scope = `procedure:${input.intentId}`;
  const decision = await askGuard(deps.guard, {
    agent: 'procedure_compiler',
    ticketId: null,
    action: 'procedure.compile',
  });
  if (!decision.allowed) return { status: 'skipped', reason: decision.reason };

  const prompt = deps.prompts.latest(PROCEDURE_COMPILER_PROMPT_ID);
  const session = sessionFor(deps, scope, input.session);
  let system: RedactedText;
  let user: RedactedText;
  try {
    system = renderTrustedPrompt(prompt, {}, session);
    const known = new Set<string>(PROCEDURE_TOOL_NAMES);
    const catalog = [
      `tools: ${input.tools.filter((tool) => known.has(tool)).join(', ') || '(none)'}`,
      `templates: ${
        input.templates
          .slice(0, MAX_CATALOG_ITEMS)
          .map((template) => `${oneLine(template.name)} (${template.kind})`)
          .join(', ') || '(none)'
      }`,
      `queues: ${
        input.queueKeys
          .slice(0, MAX_CATALOG_ITEMS)
          .map((queue) => oneLine(queue))
          .join(', ') || '(none)'
      }`,
    ];
    const source = session.redact(neutralizeTags(input.sourceMd));
    user = joinRedacted(
      [
        session.redact(`<catalog>\n${catalog.join('\n')}\n</catalog>`),
        session.redact('<procedure>'),
        // Cut after redacting: a cut address or number is no longer recognized (N4).
        clipRedacted(source, MAX_SOURCE_CHARS),
        session.redact('</procedure>'),
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
      agent: 'procedure_compiler',
      prompt: prompt.ref,
      system,
      messages: [{ role: 'user', content: user }],
      redaction: session,
      ticketId: null,
      intent: input.intentKey,
      maxOutputTokens: 3500,
      temperature: 0,
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    });
  } catch (error) {
    return failedFor(error);
  }

  const parsed = procedureCompilerAnswerSchema.safeParse(extractJsonObject(result.response.text));
  if (!parsed.success) return { status: 'failed', reason: 'model_output_invalid' };
  if (PLACEHOLDER.test(JSON.stringify(parsed.data))) {
    return { status: 'failed', reason: 'model_output_invalid' };
  }
  return {
    status: 'ok',
    runId: result.runId,
    value: {
      steps: parsed.data.steps,
      assumptions: parsed.data.assumptions,
      promptVersion: prompt.ref.version,
    },
  };
}
