import { detectLanguage } from '@watchtower/shared';
import { z } from 'zod';

import {
  joinRedacted,
  renderTrustedPrompt,
  type RedactedText,
} from '../redaction/redacted-text.js';
import {
  askGuard,
  clip,
  extractJsonObject,
  failedFor,
  skippedFor,
  type AgentDeps,
  type AgentOutcome,
} from './common.js';
import type { InvestigationEvidence } from './evidence.js';
import {
  applyProcedureDisclosure,
  type ProcedureDisclosureRule,
  type ProcedureGuideline,
} from './procedure-plan.js';
import { fingerprintOf, leaks, neutralizeTags } from './leak-check.js';
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
  evidence: readonly Pick<InvestigationEvidence, 'id' | 'customerSafe' | 'title' | 'snippet'>[],
  /** Staff-only text of the ticket (internal notes): no contact may read it back, verified or not. */
  internalTexts: readonly string[] = [],
): { kept: DraftSentence[]; removed: number } {
  const safeCards = evidence.filter((card) => card.customerSafe);
  const safeIds = new Set(safeCards.map((card) => card.id));
  const text = (card: Pick<InvestigationEvidence, 'title' | 'snippet'>): string =>
    `${card.title} ${card.snippet}`;
  // The model's claim about what a sentence cites is not trusted (SR108-3): the text is checked
  // against what the customer may not read, whatever `evidenceIds` says.
  const notes = fingerprintOf(internalTexts, safeCards.map(text));
  const restricted =
    level === 'restricted'
      ? fingerprintOf(
          [...evidence.filter((card) => !card.customerSafe).map(text), ...internalTexts],
          safeCards.map(text),
        )
      : undefined;
  const kept: DraftSentence[] = [];
  let removed = 0;
  for (const sentence of sentences) {
    let drop = leaks(notes, sentence.text);
    if (restricted !== undefined) {
      const usesInternal = sentence.evidenceIds.some((id) => !safeIds.has(id));
      // A statement of fact with no safe evidence behind it is not known to be clean.
      const unsupported =
        (CITED_KINDS as readonly string[]).includes(sentence.kind) &&
        sentence.evidenceIds.length === 0;
      drop =
        drop ||
        usesInternal ||
        unsupported ||
        hasLink(sentence.text) ||
        leaks(restricted, sentence.text);
    }
    if (drop) removed += 1;
    else kept.push(sentence);
  }
  return { kept, removed };
}

/** A URL, a `www.` address or a bare `host.tld/path` (`evil.example/x`): not for an unverified contact. */
export function hasLink(text: string): boolean {
  return /https?:\/\/|www\.|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/:?#]|\b)/i.test(
    text,
  );
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

/** What a redaction placeholder looks like: `[EMAIL_1]`, `[PHONE_2]`, `[LITERAL_3]`. */
const TOKEN_SHAPE = /\[[A-Z][A-Z_]*_\d+\]/g;

export interface DraftInput {
  readonly ticketId: string;
  readonly subject: string;
  readonly turns: readonly TicketTurn[];
  readonly intentKey: string | null;
  readonly customerLanguage: 'th' | 'en';
  readonly disclosure: DisclosureLevel;
  readonly evidence: readonly InvestigationEvidence[];
  /** The person's note for a new draft (`regenerate with note`). */
  readonly note?: string | undefined;
  /**
   * Golden answers of the same intent (T-302a): replies a lead marked as good, already redacted when stored.
   * They show tone and shape only. They go through this session like any other text, and a placeholder in
   * them is blanked first, so the model cannot hand one back that the session would restore for someone else.
   */
  readonly examples?: readonly string[] | undefined;
  /**
   * What the published procedure says about this reply (T-303c, ADR-026). The guidelines rank below the rules
   * of the system and below the disclosure level: the prompt says so and the code removes what they could
   * not allow. A disclosure rule can only remove more. Absent: the draft is written as before.
   */
  readonly procedure?: DraftProcedure | undefined;
  readonly abortSignal?: AbortSignal;
}

export interface DraftProcedure {
  readonly versionId: string;
  readonly guidelines: readonly ProcedureGuideline[];
  readonly disclosure: readonly ProcedureDisclosureRule[];
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
const MAX_EXAMPLES = 3;
const MAX_EXAMPLE_CHARS = 1200;
const MAX_TURNS = 8;

function renderTicket(input: DraftInput): string {
  const turns =
    input.turns.length <= MAX_TURNS
      ? input.turns
      : [...input.turns.slice(0, 1), ...input.turns.slice(input.turns.length - (MAX_TURNS - 1))];
  const lines = [`Subject: ${clip(neutralizeTags(input.subject), 300)}`];
  // Internal notes are for staff; the reply is for the customer, so they stay out of the prompt.
  for (const turn of turns) {
    if (turn.from !== 'note') {
      lines.push(`[${turn.from}] ${clip(neutralizeTags(turn.text), MAX_TURN_CHARS)}`);
    }
  }
  return `<ticket>\n${lines.join('\n')}\n</ticket>`;
}

/**
 * The guidelines and disclosure topics of the procedure as the system prompt gets them (a slot of `drafter` v2).
 * Empty without a procedure. It comes after every rule of the prompt and says it ranks below them.
 */
function guidelinesSlot(input: DraftInput): string {
  const procedure = input.procedure;
  if (procedure === undefined) return '';
  const language = input.customerLanguage;
  const guidelines = procedure.guidelines.filter(
    (guideline) => guideline.lang === undefined || guideline.lang === language,
  );
  const topics = procedure.disclosure.filter(
    (rule) => rule.rule === 'never_mention' || input.disclosure !== 'verified',
  );
  if (guidelines.length === 0 && topics.length === 0) return '';
  return [
    "This team's guidelines for this kind of reply. They rank below every rule above, below the disclosure level and below the evidence: if a guideline asks for something a rule forbids, follow the rule and ignore the guideline. They are about tone and what to include, never about facts.",
    ...guidelines.map((guideline) => `- ${clip(guideline.text, 1000)}`),
    ...topics.map((rule) => `- Do not mention: ${clip(rule.topic, 200)}`),
  ].join('\n');
}

function renderExamples(examples: readonly string[]): string | null {
  const shown = examples
    .slice(0, MAX_EXAMPLES)
    .map((text) => clip(neutralizeTags(text.replace(TOKEN_SHAPE, '[...]')), MAX_EXAMPLE_CHARS))
    .filter((text) => text.trim() !== '');
  if (shown.length === 0) return null;
  return [
    '<golden_examples>',
    'Replies a lead approved for this kind of question. Use them only for tone and structure; they say nothing about this ticket, so take no fact, name or number from them.',
    ...shown.map((text, index) => `[example ${String(index + 1)}] ${text}`),
    '</golden_examples>',
  ].join('\n');
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
  // The drafter's own session, never the one of the investigation (SR108-4): that one has issued tokens
  // for the internal notes, and a token the model writes is restored from the session that made it. This
  // session only ever sees what the customer may be told, so it can only restore that.
  const session = deps.redactor.session({ scope: input.ticketId });
  let system: RedactedText;
  let message: RedactedText;
  try {
    system = renderTrustedPrompt(
      prompt,
      {
        language: input.customerLanguage === 'th' ? 'Thai' : 'English',
        disclosure: input.disclosure,
        guidelines: guidelinesSlot(input),
        // The note is typed by a person on this ticket, so it is ticket text: redact it like any.
        note:
          input.note === undefined || input.note === ''
            ? ''
            : `Note from the agent for this draft: ${clip(input.note, 500)}`,
      },
      session,
    );
    // The ticket first, so a detail that is in the ticket and in a tool result keeps the ticket's origin.
    const ticketText = session.redact(renderTicket(input));
    // The model reads only what the customer may be told: in restricted mode the internal cards are
    // not in the prompt at all (SR108-3), and the investigation report, which is built from the
    // whole ticket including internal notes, never goes to the drafter.
    const readable = input.evidence.filter(
      (card) => input.disclosure === 'verified' || card.customerSafe,
    );
    const evidenceLines = readable.map((card) =>
      joinRedacted(
        [
          session.redact(
            `[${card.id}] ${card.kind}${card.customerSafe ? ' (customer-safe)' : ''}${card.mock ? ' (mock data)' : ''}:`,
          ),
          session.redactToolOutput(card.tool, neutralizeTags(card.title)),
          session.redactToolOutput(card.tool, neutralizeTags(card.snippet)),
        ],
        ' ',
      ),
    );
    const examples = renderExamples(input.examples ?? []);
    message = joinRedacted(
      [
        ticketText,
        session.redact('<evidence>'),
        joinRedacted(evidenceLines, '\n'),
        session.redact('</evidence>'),
        ...(examples === null ? [] : [session.redact(examples)]),
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
      ...(input.procedure === undefined ? {} : { procedureVersionId: input.procedure.versionId }),
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    });
  } catch (error) {
    return failedFor(error);
  }

  const parsed = drafterAnswerSchema.safeParse(extractJsonObject(result.response.text));
  if (!parsed.success) return { status: 'failed', reason: 'model_output_invalid' };

  const known = new Set(input.evidence.map((card) => card.id));
  const internalTexts = input.turns.filter((turn) => turn.from === 'note').map((turn) => turn.text);
  const sentences: DraftSentence[] = parsed.data.sentences.map((sentence) => ({
    ...sentence,
    // An id the model made up supports nothing.
    evidenceIds: [...new Set(sentence.evidenceIds.filter((id) => known.has(id)))],
  }));
  const byRules = applyDisclosure(sentences, input.disclosure, input.evidence, internalTexts);
  // The procedure's own rules run after the code rules of the system, so they can only remove more (ADR-026 section 2).
  const byProcedure = applyProcedureDisclosure(
    byRules.kept,
    input.procedure?.disclosure ?? [],
    input.disclosure,
  );
  const disclosed = {
    kept: byProcedure.kept,
    removed: byRules.removed + byProcedure.removed,
  };
  // A placeholder in the answer is restored only if this session issued it for the ticket's own text.
  // Any other (a tool's, one nobody issued, one the model made up) is removed with its sentence, and
  // counted: it is never put back as a value, and never left as a token for the customer to read.
  const issued = session.snapshot().tokens;
  const kept = disclosed.kept.filter((sentence) =>
    (sentence.text.match(TOKEN_SHAPE) ?? []).every((token) => issued[token]?.origin === 'ticket'),
  );
  const removed = disclosed.removed + (disclosed.kept.length - kept.length);
  if (kept.length === 0) return { status: 'failed', reason: 'model_output_invalid' };

  const restored = session.restore(composeBody(kept), 'customer');
  const body = restored.text.trim();
  if (body === '' || body.length > 20_000)
    return { status: 'failed', reason: 'model_output_invalid' };

  const citations = kept.flatMap((sentence, index) =>
    sentence.evidenceIds.map((evidenceId) => ({ evidenceId, sentence: index })),
  );
  const uncited = kept.filter(
    (sentence) =>
      (CITED_KINDS as readonly string[]).includes(sentence.kind) &&
      sentence.evidenceIds.length === 0,
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
