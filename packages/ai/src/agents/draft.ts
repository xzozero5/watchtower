import { detectLanguage, type AiReport } from '@watchtower/shared';
import { z } from 'zod';

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
import type { InvestigationEvidence } from './evidence.js';
import type { TicketTurn } from './summarize.js';

export const DRAFTER_PROMPT_ID = 'drafter';

export const DISCLOSURE_LEVELS = ['verified', 'restricted'] as const;
export type DisclosureLevel = (typeof DISCLOSURE_LEVELS)[number];

/** Kinds that state something checkable: they need evidence, or they show as uncited. */
export const CITED_KINDS = ['fact', 'instruction'] as const;

export const drafterAnswerSchema = z.object({
  language: z.enum(['th', 'en']).optional(),
  sentences: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(600),
        kind: z.enum(['fact', 'instruction', 'question', 'courtesy']),
        evidenceIds: z.array(z.string().max(100)).max(6).default([]),
        newParagraph: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(20),
});

export interface DraftSentence {
  readonly text: string;
  readonly kind: 'fact' | 'instruction' | 'question' | 'courtesy';
  readonly evidenceIds: readonly string[];
  readonly newParagraph: boolean;
}

/**
 * The disclosure policy (PRD section 6.6, po decision 26) as code, not only as an instruction to
 * the model. For a contact who is not verified, a sentence is removed when:
 *  - it cites evidence that is not written for customers (logs, data, repo, other tickets, the
 *    organization record, internal articles), or
 *  - it holds a link (an internal URL or any other: a person may add one on purpose).
 * Returns what is kept and how many sentences were removed. A verified contact keeps everything.
 */
export function applyDisclosure(
  sentences: readonly DraftSentence[],
  level: DisclosureLevel,
  evidence: readonly Pick<InvestigationEvidence, 'id' | 'customerSafe'>[],
): { kept: DraftSentence[]; removed: number } {
  if (level === 'verified') return { kept: [...sentences], removed: 0 };
  const safe = new Set(evidence.filter((card) => card.customerSafe).map((card) => card.id));
  const kept: DraftSentence[] = [];
  let removed = 0;
  for (const sentence of sentences) {
    const usesInternal = sentence.evidenceIds.some((id) => !safe.has(id));
    const hasLink = /https?:\/\/|www\./i.test(sentence.text);
    if (usesInternal || hasLink) removed += 1;
    else kept.push(sentence);
  }
  return { kept, removed };
}

/** The sentences joined into the text a customer reads: a space between sentences, a blank line between paragraphs. */
export function composeBody(sentences: readonly DraftSentence[]): string {
  let body = '';
  for (const [index, sentence] of sentences.entries()) {
    if (index > 0) body += sentence.newParagraph ? '\n\n' : ' ';
    body += sentence.text;
  }
  return body;
}

export interface DraftInput {
  readonly ticketId: string;
  readonly session?: RedactionSession;
  readonly subject: string;
  readonly turns: readonly TicketTurn[];
  readonly intentKey: string | null;
  readonly customerLanguage: 'th' | 'en';
  readonly disclosure: DisclosureLevel;
  readonly evidence: readonly InvestigationEvidence[];
  readonly report: AiReport | null;
  /** The person's note for a new draft (`regenerate with note`). */
  readonly note?: string | undefined;
  readonly abortSignal?: AbortSignal;
}

export interface DraftResult {
  /** What the customer would read, placeholders restored for the customer's own details only. */
  readonly body: string;
  readonly language: 'th' | 'en';
  readonly customerLanguage: 'th' | 'en';
  readonly citations: readonly { readonly evidenceId: string; readonly sentence: number }[];
  readonly citedEvidenceIds: readonly string[];
  readonly uncitedClaims: number;
  readonly disclosure: { readonly level: DisclosureLevel; readonly removedSentences: number };
  /** A person must read it before anything else: a foreign placeholder is left in, or the language is wrong. */
  readonly needsReview: boolean;
  readonly promptVersion: number;
}

const MAX_TURN_CHARS = 1500;
const MAX_TURNS = 8;

function renderTicket(input: DraftInput): string {
  const turns =
    input.turns.length <= MAX_TURNS
      ? input.turns
      : [...input.turns.slice(0, 1), ...input.turns.slice(input.turns.length - (MAX_TURNS - 1))];
  const lines = [`Subject: ${clip(input.subject, 300)}`];
  // Internal notes are for staff; the reply is for the customer, so they stay out of the prompt.
  for (const turn of turns) {
    if (turn.from !== 'note') lines.push(`[${turn.from}] ${clip(turn.text, MAX_TURN_CHARS)}`);
  }
  return `<ticket>\n${lines.join('\n')}\n</ticket>`;
}

function renderReport(report: AiReport | null): string {
  if (report === null) return '<report>\nNo report.\n</report>';
  const lines = report.findings.map(
    (finding) => `- ${finding.text} [${finding.evidenceIds.join(', ')}]`,
  );
  if (report.likelyCause !== null) lines.push(`Likely cause: ${report.likelyCause}`);
  return `<report>\n${lines.join('\n')}\n</report>`;
}

/**
 * Drafter (PRD section 6.2, R-5.1 to 5.3 and section 6.6): one reply in the customer's language,
 * sentence by sentence, each marked with the evidence behind it. Citations that point at nothing are
 * dropped; a statement without one is counted as an uncited claim for the reviewer. The disclosure
 * policy is applied to the answer in code. The result is a draft for a person: nothing here sends
 * (N3), and the evidence the model read passed through `redactToolOutput` (N4).
 */
export async function draftReply(
  deps: AgentDeps,
  input: DraftInput,
): Promise<AgentOutcome<DraftResult>> {
  const decision = await askGuard(deps.guard, {
    agent: 'drafter',
    ticketId: input.ticketId,
    action: 'draft',
  });
  if (!decision.allowed) return { status: 'skipped', reason: decision.reason };

  const prompt = deps.prompts.latest(DRAFTER_PROMPT_ID);
  const session = sessionFor(deps, input.ticketId, input.session);
  let system: RedactedText;
  let message: RedactedText;
  try {
    system = session.redact(
      renderPrompt(prompt.body, {
        language: input.customerLanguage === 'th' ? 'Thai' : 'English',
        disclosure: input.disclosure,
        // The note is typed by a person on this ticket, so it is ticket text: redact it like any.
        note:
          input.note === undefined || input.note === ''
            ? ''
            : `Note from the agent for this draft: ${clip(input.note, 500)}`,
      }),
    );
    // The ticket first, so a detail that is in the ticket and in a tool result keeps the ticket's origin.
    const ticketText = session.redact(renderTicket(input));
    const evidenceLines = input.evidence.map((card) =>
      joinRedacted(
        [
          session.redact(
            `[${card.id}] ${card.kind}${card.customerSafe ? ' (customer-safe)' : ''}${card.mock ? ' (mock data)' : ''}:`,
          ),
          session.redactToolOutput(card.tool, card.title),
          session.redactToolOutput(card.tool, card.snippet),
        ],
        ' ',
      ),
    );
    message = joinRedacted(
      [
        ticketText,
        session.redact(renderReport(input.report)),
        session.redact('<evidence>'),
        joinRedacted(evidenceLines, '\n'),
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
      agent: 'drafter',
      prompt: prompt.ref,
      system,
      messages: [{ role: 'user', content: message }],
      redaction: session,
      ticketId: input.ticketId,
      intent: input.intentKey,
      maxOutputTokens: 1200,
      temperature: 0.2,
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    });
  } catch (error) {
    return failedFor(error);
  }

  const parsed = drafterAnswerSchema.safeParse(extractJsonObject(result.response.text));
  if (!parsed.success) return { status: 'failed', reason: 'model_output_invalid' };

  const known = new Set(input.evidence.map((card) => card.id));
  const sentences: DraftSentence[] = parsed.data.sentences.map((sentence) => ({
    ...sentence,
    // An id the model made up supports nothing.
    evidenceIds: [...new Set(sentence.evidenceIds.filter((id) => known.has(id)))],
  }));
  const { kept, removed } = applyDisclosure(sentences, input.disclosure, input.evidence);
  if (kept.length === 0) return { status: 'failed', reason: 'model_output_invalid' };

  const restored = session.restore(composeBody(kept), 'customer');
  const body = restored.text.trim();
  if (body === '' || body.length > 20_000) return { status: 'failed', reason: 'model_output_invalid' };

  const citations = kept.flatMap((sentence, index) =>
    sentence.evidenceIds.map((evidenceId) => ({ evidenceId, sentence: index })),
  );
  const uncited = kept.filter(
    (sentence) =>
      (CITED_KINDS as readonly string[]).includes(sentence.kind) && sentence.evidenceIds.length === 0,
  ).length;
  const language = detectLanguage(body);
  return {
    status: 'ok',
    runId: result.runId,
    value: {
      body,
      language,
      customerLanguage: input.customerLanguage,
      citations,
      citedEvidenceIds: [...new Set(citations.map((citation) => citation.evidenceId))],
      uncitedClaims: uncited,
      disclosure: { level: input.disclosure, removedSentences: removed },
      needsReview: restored.needsReview || language !== input.customerLanguage,
      promptVersion: prompt.ref.version,
    },
  };
}
