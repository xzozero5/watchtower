import {
  claimSchema,
  makeClaim,
  type Claim,
  type ClaimEvidence,
  type ClaimEvidenceKind,
  type DraftVerdict,
  type ResolutionClass,
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
import { stripLinks } from './assistant.js';
import { neutralizeTags } from './leak-check.js';
import type { TicketTurn } from './summarize.js';

export const GRADER_PROMPT_ID = 'grader';

export const GRADE_FACT_ROLES = [
  'customer',
  'staff_reply',
  'ai_draft',
  'csat',
  'note',
  'kb',
] as const;
export type GradeFactRole = (typeof GRADE_FACT_ROLES)[number];

/** One line of what the grader may read, and the chip a person sees for it (the same shape as a summary fact). */
export interface GradeFact {
  readonly role: GradeFactRole;
  readonly kind: ClaimEvidenceKind;
  readonly label: string;
  readonly href?: string | undefined;
  readonly text: string;
  /** A customer message that came after the last staff reply: the only turn that may confirm a fix. */
  readonly afterReply?: boolean | undefined;
}

/** What the system knows about the customer's answer to the survey, if there was one. */
export interface GradeCsat {
  readonly score: number | null;
  readonly resolved: boolean | null;
  readonly comment?: string | null | undefined;
}

export interface ResolutionGradeInput {
  readonly ticketId: string;
  readonly session?: RedactionSession;
  readonly intentKey: string | null;
  readonly locale: 'th' | 'en';
  readonly facts: readonly GradeFact[];
  /** There is an AI draft among the facts. Without one the verdict is `no_draft` whatever the model says. */
  readonly hasDraft: boolean;
  readonly csat: GradeCsat | null;
  /** A knowledge base article was cited by a draft a person used: then there is no gap to flag. */
  readonly kbCited: boolean;
  readonly abortSignal?: AbortSignal;
}

export interface GradedViolation {
  readonly code: (typeof VIOLATION_CODES)[number];
  readonly claim: Claim;
}

export interface ResolutionGrade {
  /** After the cap: what the facts support. */
  readonly resolutionClass: ResolutionClass;
  /** What the model said, kept to measure how often the cap had to step in. */
  readonly modelClass: ResolutionClass;
  readonly draftVerdict: DraftVerdict;
  /** 0..1, or null when there was no draft. */
  readonly draftQuality: number | null;
  readonly violations: readonly GradedViolation[];
  readonly kbGap: boolean;
  readonly reasons: readonly Claim[];
  readonly promptVersion: number;
  readonly mock: boolean;
}

const VIOLATION_CODES = ['disclosure', 'promise', 'unsupported_claim', 'tone', 'other'] as const;

const factIds = z.array(z.string().max(200)).max(20).default([]);
export const graderAnswerSchema = z.object({
  resolutionClass: z.enum(['verified', 'contained', 'assumed']),
  draftVerdict: z.enum(['matches', 'partial', 'differs', 'no_draft']),
  draftQuality: z.number().default(0),
  policyViolations: z
    .array(
      z.object({
        code: z.string().max(40).default('other'),
        text: z.string().trim().min(1).max(600),
        factIds,
      }),
    )
    .max(8)
    .default([]),
  kbGap: z.boolean().default(false),
  reasons: z
    .array(z.object({ text: z.string().trim().min(1).max(600), factIds }))
    .max(8)
    .default([]),
});

const RANK: Readonly<Record<ResolutionClass, number>> = { assumed: 0, contained: 1, verified: 2 };
const BY_RANK: readonly ResolutionClass[] = ['assumed', 'contained', 'verified'];

/**
 * The model proposes a class; the facts decide how high it may go (PRD 6.4: "verified" is the claim
 * the stage-3 gate counts, so a model's word alone is not enough):
 *  - no staff reply: `assumed`;
 *  - the customer said it did not work (CSAT "not resolved"): `assumed`;
 *  - `verified` needs the customer's own confirmation: a CSAT "resolved", or a cited customer message
 *    that came after the last staff reply. Otherwise at most `contained`.
 */
export function capResolutionClass(input: {
  readonly claimed: ResolutionClass;
  readonly hasStaffReply: boolean;
  readonly csat: GradeCsat | null;
  readonly citedFacts: readonly GradeFact[];
}): ResolutionClass {
  if (!input.hasStaffReply) return 'assumed';
  if (input.csat?.resolved === false) return 'assumed';
  const confirmed =
    input.csat?.resolved === true ||
    input.citedFacts.some((fact) => fact.role === 'customer' && fact.afterReply === true);
  const ceiling: ResolutionClass = confirmed ? 'verified' : 'contained';
  return BY_RANK[Math.min(RANK[input.claimed], RANK[ceiling])] ?? 'assumed';
}

const MAX_FACTS = 12;
const MAX_FACT_CHARS = 1200;

export interface BuildGradeFactsInput {
  /** Ticket key shown on the chips, for example `OPS-12`. */
  readonly ticketKey: string;
  readonly ticketHref?: string | undefined;
  readonly turns: readonly TicketTurn[];
  /** The text of the AI draft a person used or rejected, if any. */
  readonly draftText?: string | null | undefined;
  readonly csat: GradeCsat | null;
  readonly kbCited: boolean;
  /** The reply that was really sent, when the host knows it better than the last staff turn. */
  readonly sentReply?: string | null | undefined;
}

/**
 * Turns what the host read about a resolved ticket into the facts the grader cites. Pure, so the
 * worker and the eval replay build the same facts. Internal notes are left out: the grade is about
 * what the customer was told.
 */
export function buildGradeFacts(input: BuildGradeFactsInput): {
  facts: GradeFact[];
  hasStaffReply: boolean;
  hasDraft: boolean;
} {
  const facts: GradeFact[] = [];
  const href = input.ticketHref;
  const chip = (what: string) => ({
    kind: 'ticket' as const,
    label: `${input.ticketKey} · ${what}`,
    ...(href === undefined ? {} : { href }),
  });
  const turns = input.turns.filter((turn) => turn.from !== 'note');
  let lastStaff = -1;
  turns.forEach((turn, index) => {
    if (turn.from === 'staff') lastStaff = index;
  });
  const firstCustomer = turns.findIndex((turn) => turn.from === 'customer');
  const firstTurn = turns[firstCustomer];
  if (firstTurn !== undefined) {
    facts.push({
      role: 'customer',
      ...chip('first customer message'),
      text: firstTurn.text,
      afterReply: lastStaff !== -1 && firstCustomer > lastStaff,
    });
  }
  const lastCustomer = turns.map((turn) => turn.from).lastIndexOf('customer');
  const lastTurn = turns[lastCustomer];
  if (lastTurn !== undefined && lastCustomer !== firstCustomer) {
    facts.push({
      role: 'customer',
      ...chip(
        lastCustomer > lastStaff ? 'customer message after the reply' : 'last customer message',
      ),
      text: lastTurn.text,
      afterReply: lastStaff !== -1 && lastCustomer > lastStaff,
    });
  }
  const sent = input.sentReply ?? turns[lastStaff]?.text ?? null;
  const hasStaffReply = sent !== null && sent.trim() !== '';
  if (hasStaffReply) {
    facts.push({ role: 'staff_reply', ...chip('reply that was sent'), text: sent });
  }
  const hasDraft =
    input.draftText !== undefined && input.draftText !== null && input.draftText !== '';
  if (hasDraft) {
    facts.push({ role: 'ai_draft', ...chip('AI draft'), text: input.draftText });
  }
  if (input.csat !== null) {
    const resolved =
      input.csat.resolved === null ? 'not answered' : input.csat.resolved ? 'yes' : 'no';
    const comment =
      input.csat.comment === undefined || input.csat.comment === null || input.csat.comment === ''
        ? ''
        : ` Comment: ${input.csat.comment}`;
    facts.push({
      role: 'csat',
      ...chip('customer survey answer'),
      text: `Score: ${input.csat.score === null ? 'none' : `${String(input.csat.score)} of 5`}. Resolved: ${resolved}.${comment}`,
    });
  }
  facts.push({
    role: 'kb',
    kind: 'kb',
    label: 'Knowledge base citation',
    text: input.kbCited
      ? 'A knowledge base article was cited in the reply.'
      : 'No knowledge base article was cited in the reply.',
  });
  return { facts: facts.slice(0, MAX_FACTS), hasStaffReply, hasDraft };
}

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

function evidenceFor(
  ids: readonly string[],
  facts: readonly GradeFact[],
): { evidence: ClaimEvidence[]; cited: GradeFact[] } {
  const evidence: ClaimEvidence[] = [];
  const cited: GradeFact[] = [];
  for (const id of new Set(ids)) {
    const index = /^f(\d{1,3})$/.exec(id)?.[1];
    const fact = index === undefined ? undefined : facts[Number(index) - 1];
    if (fact === undefined) continue;
    cited.push(fact);
    evidence.push({
      kind: fact.kind,
      label: fact.label,
      ...(fact.href === undefined ? {} : { href: fact.href }),
    });
  }
  return { evidence, cited };
}

/**
 * Grader (PRD 6.2, 6.4, 6.6): after a ticket is resolved, says how it ended (`verified`, `contained`
 * or `assumed`), how close the AI draft was to the reply that was sent, whether the reply broke a
 * policy, and whether a knowledge base article was missing. Every sentence cites the facts it rests
 * on (the claim shape of T-135); a policy violation that cites nothing is kept but marked `uncited`.
 * It measures only: nothing here changes a ticket or reaches a customer (N3). The facts pass through
 * the redaction session before the model sees them (N4).
 */
export async function gradeResolution(
  deps: AgentDeps,
  input: ResolutionGradeInput,
): Promise<AgentOutcome<ResolutionGrade>> {
  const decision = await askGuard(deps.guard, {
    agent: 'grader',
    ticketId: input.ticketId,
    action: 'grade',
  });
  if (!decision.allowed) return { status: 'skipped', reason: decision.reason };

  const facts = input.facts.slice(0, MAX_FACTS);
  const prompt = deps.prompts.latest(GRADER_PROMPT_ID);
  const session = sessionFor(deps, input.ticketId, input.session);
  let system: RedactedText;
  let user: RedactedText;
  try {
    system = renderTrustedPrompt(
      prompt,
      { language: input.locale === 'th' ? 'Thai' : 'English' },
      session,
    );
    const lines = facts.map((fact, index) =>
      clipRedacted(
        session.redact(
          `[f${String(index + 1)}] ${fact.role}: ${neutralizeTags(fact.text).replaceAll(
            /<(\/?\s*facts\b)/gi,
            '‹$1',
          )}`,
        ),
        // Cut after redacting: a cut address or number is no longer recognized (N4).
        MAX_FACT_CHARS + 40,
      ),
    );
    user = joinRedacted([session.redact('<facts>'), ...lines, session.redact('</facts>')], '\n');
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
      maxOutputTokens: 900,
      temperature: 0,
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    });
  } catch (error) {
    return failedFor(error);
  }

  const parsed = graderAnswerSchema.safeParse(extractJsonObject(result.response.text));
  if (!parsed.success) return { status: 'failed', reason: 'model_output_invalid' };
  const answer = parsed.data;
  // A draft that exists must be compared; "no draft" for one that does not exist is the only honest answer.
  if (input.hasDraft && answer.draftVerdict === 'no_draft') {
    return { status: 'failed', reason: 'model_output_invalid' };
  }

  const text = (raw: string): string =>
    stripLinks(session.restore(raw, 'internal').text).slice(0, 600);
  const reasons: Claim[] = [];
  for (const item of answer.reasons) {
    const { evidence } = evidenceFor(item.factIds, facts);
    // A reason that cites nothing is not a reason: it would read as a finding without a way to check it.
    if (evidence.length === 0) continue;
    const claim = makeClaim(text(item.text), evidence);
    if (claimSchema.safeParse(claim).success) reasons.push(claim);
  }
  const violations: GradedViolation[] = [];
  for (const item of answer.policyViolations) {
    const { evidence } = evidenceFor(item.factIds, facts);
    const claim = makeClaim(text(item.text), evidence);
    if (!claimSchema.safeParse(claim).success) continue;
    const code = (VIOLATION_CODES as readonly string[]).includes(item.code)
      ? (item.code as (typeof VIOLATION_CODES)[number])
      : 'other';
    violations.push({ code, claim });
  }
  // The facts the model cited for its class count, so does the one that is the whole point of the cap.
  const classFacts = answer.reasons.flatMap((item) => evidenceFor(item.factIds, facts).cited);
  const hasStaffReply = facts.some((fact) => fact.role === 'staff_reply');
  const resolutionClass = capResolutionClass({
    claimed: answer.resolutionClass,
    hasStaffReply,
    csat: input.csat,
    citedFacts: classFacts,
  });

  return {
    status: 'ok',
    runId: result.runId,
    value: {
      resolutionClass,
      modelClass: answer.resolutionClass,
      draftVerdict: input.hasDraft ? answer.draftVerdict : 'no_draft',
      draftQuality: input.hasDraft ? clamp01(answer.draftQuality) : null,
      violations,
      kbGap: answer.kbGap && !input.kbCited && hasStaffReply,
      reasons: reasons.slice(0, 4),
      promptVersion: prompt.ref.version,
      mock: result.run.provider === 'mock',
    },
  };
}
