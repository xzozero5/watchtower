import {
  INSIGHT_ELEMENTS,
  insightFactSchema,
  numbersSubsetOfFacts,
  type AiInsightReason,
  type InsightElementKey,
  type InsightFact,
  type InsightLocale,
  type InsightRule,
  type InsightStoredEvidence,
} from '@watchtower/shared';
import { z } from 'zod';

import type { AuditedResult } from '../audited.js';
import { renderPrompt } from '../prompts.js';
import { clipRedacted, joinRedacted, type RedactedText } from '../redaction/redacted-text.js';
import type { RedactionSession, Redactor } from '../redaction/redactor.js';
import { stripLinks } from './assistant.js';
import { askGuard, extractJsonObject, failureFor, skippedFor, type AgentDeps } from './common.js';
import { neutralizeTags } from './leak-check.js';
import {
  distinctPersonTokens,
  implicitRankingDrops,
  personToneCheck,
  type PersonClaimValue,
} from './person-tone.js';

export const ELEMENT_INSIGHT_PROMPT_ID = 'element_insight';
export const INSIGHT_NARRATOR_AGENT = 'insight_narrator';

/** ADR-029 section 9.4 `insights.max_batch_elements`. */
export const MAX_INSIGHT_BATCH = 4;
/** ADR-029 section 9.2: at most three claims per element and language. */
export const MAX_INSIGHT_CLAIMS = 3;
const MAX_FACTS_PER_ELEMENT = 60;
const MAX_FACT_LINE = 400;

/** The batch breaks a rule the worker must keep (mixed viewer groups, too many elements). A bug of the caller, not of the model. */
export class InsightBatchError extends Error {
  override readonly name = 'InsightBatchError';
}

export interface InsightNarrationElement {
  readonly key: InsightElementKey;
  /**
   * Who sees this element: the `scope_key` of ADR-029 section 9.3 (`instance`, `org:<id>`, `user:<id>`). All
   * elements of a batch must have the same one, and the same `rule` in the registry.
   */
  readonly scopeKey: string;
  readonly facts: readonly InsightFact[];
}

export interface InsightNarrationBatch {
  /** 1 to 4 elements of the same viewer group. */
  readonly elements: readonly InsightNarrationElement[];
  /** The languages somebody is watching in; both go in one call. */
  readonly locales: readonly InsightLocale[];
  /**
   * Names the redactor must know (staff of the instance, in the dictionary: N4). Required whenever a fact is
   * about a user, because a person's name is in its `display`.
   */
  readonly names?: readonly string[] | undefined;
  /** Redaction scope, for example `insight:<scope key>`. */
  readonly scope: string;
  readonly abortSignal?: AbortSignal | undefined;
}

export const INSIGHT_REJECT_REASONS = [
  'schema',
  'unknown_element',
  'locale_not_requested',
  'too_many',
  'uncited',
  'locale_mismatch',
  'number_not_in_facts',
  'person_tone',
] as const;
export type InsightRejectReason = (typeof INSIGHT_REJECT_REASONS)[number];

export interface RejectedInsightClaim {
  readonly elementKey: string;
  readonly locale?: InsightLocale | undefined;
  readonly reason: InsightRejectReason;
  /** For `person_tone`: which rule (`ranking`, `judgement`, `advice`, `comparison`, `multi_person`, `implicit_ranking`). */
  readonly detail?: string | undefined;
}

export interface NarratedInsightClaim {
  /** Redacted text with the placeholders the model was given (stored as it is, section 9.7). Links are removed. */
  readonly text: string;
  /** Fact ids of this element that the claim cites. At least one. */
  readonly factIds: readonly string[];
  /** The refs of the cited facts, as the worker stores them (a fact without a ref has none to give). */
  readonly evidence: readonly InsightStoredEvidence[];
}

export type InsightAcceptedClaims = Partial<
  Record<InsightElementKey, Partial<Record<InsightLocale, NarratedInsightClaim[]>>>
>;

export type InsightNarrationOutcome =
  | {
      readonly status: 'ok';
      readonly accepted: InsightAcceptedClaims;
      readonly rejected: readonly RejectedInsightClaim[];
      readonly runId: string | null;
      readonly mock: boolean;
      /** The session the text was redacted in, so the worker can bind a placeholder to the user ref it stands for. */
      readonly redaction: RedactionSession;
    }
  | { readonly status: 'skipped'; readonly reason: AiInsightReason }
  | { readonly status: 'failed'; readonly reason: AiInsightReason };

// --- output schema -----------------------------------------------------------------------------------------

const claimSchema = z.object({
  text: z.string().trim().min(1).max(600),
  factIds: z.array(z.string().max(100)).max(20).default([]),
});
// The list is cut to three in code, so that a fourth claim is counted as a rejection and not as a broken answer.
const claimsSchema = z.array(claimSchema).max(12);
const elementAnswerSchema = z.object({ th: claimsSchema.optional(), en: claimsSchema.optional() });

// --- the batch ---------------------------------------------------------------------------------------------

function canonicalRule(rule: InsightRule | null): string {
  if (rule === null) return 'null';
  if ('all' in rule) return `all:${[...rule.all].sort().join(',')}`;
  return `anyOf:${[...rule.anyOf].sort().join(',')}`;
}

/**
 * ADR-029 section 9.4: one call serves one viewer group. Elements must be narrated ones (mode N, or
 * `home.my_work`, which is narrated per user), not aliases of another element, with the same `rule`, scope
 * and `scopeKey`; `home.my_work` only for one user. Throws `InsightBatchError` for anything else, so that a
 * bug in the grouping of the worker can never put two audiences' figures into one prompt.
 */
export function assertInsightBatch(batch: InsightNarrationBatch): void {
  const { elements } = batch;
  if (elements.length === 0) throw new InsightBatchError('a batch needs at least one element');
  if (elements.length > MAX_INSIGHT_BATCH) {
    throw new InsightBatchError(`a batch holds at most ${String(MAX_INSIGHT_BATCH)} elements`);
  }
  if (batch.locales.length === 0) throw new InsightBatchError('a batch needs at least one locale');
  const keys = new Set<string>();
  const first = elements[0];
  if (first === undefined) return;
  const firstDef = INSIGHT_ELEMENTS[first.key];
  for (const item of elements) {
    if (keys.has(item.key))
      throw new InsightBatchError(`element ${item.key} is in the batch twice`);
    keys.add(item.key);
    const def = INSIGHT_ELEMENTS[item.key];
    if (def.aliasOf !== undefined) {
      throw new InsightBatchError(`${item.key} is an alias of ${def.aliasOf}: narrate that one`);
    }
    if (def.mode !== 'N' && item.key !== 'home.my_work') {
      throw new InsightBatchError(`${item.key} is not narrated by a model (mode ${def.mode})`);
    }
    if (
      item.scopeKey !== first.scopeKey ||
      def.scope !== firstDef.scope ||
      canonicalRule(def.rule) !== canonicalRule(firstDef.rule)
    ) {
      throw new InsightBatchError('a batch must not mix viewer groups (rule and scope key)');
    }
    // `home.my_work` is narrated for one user: its scope key says whose (the rule check above is what lets
    // another element of the same user into the call).
    if (item.key === 'home.my_work' && !item.scopeKey.startsWith('user:')) {
      throw new InsightBatchError('home.my_work is narrated for one user');
    }
    if (item.facts.length > MAX_FACTS_PER_ELEMENT) {
      throw new InsightBatchError(
        `${item.key} has more than ${String(MAX_FACTS_PER_ELEMENT)} facts`,
      );
    }
    for (const fact of item.facts) {
      if (!insightFactSchema.safeParse(fact).success) {
        throw new InsightBatchError(`${item.key} has a fact that is not an InsightFact`);
      }
    }
    if (
      (batch.names === undefined || batch.names.length === 0) &&
      item.facts.some((fact) => fact.ref?.kind === 'user')
    ) {
      throw new InsightBatchError('facts about users need the names for the redactor (N4)');
    }
  }
}

// --- prompt input ------------------------------------------------------------------------------------------

/**
 * Staff typed the names in a fact (an intent, a queue). They are data: a closing tag or a new line must not
 * let them speak as the prompt (C-13). Covers the tags of `element_insight.v1` and those of the other prompts.
 */
export function neutralizeInsightText(text: string): string {
  return neutralizeTags(text)
    .replaceAll(
      /<(\/?\s*(?:elements?|facts?|insight|system|instructions?|assistant|user|data)\b)/gi,
      '‹$1',
    )
    .replaceAll(/[\r\n\u2028\u2029]+/g, ' ')
    .replaceAll(/\[(?=\s*[a-z][a-z0-9_]*\s*\])/g, '‹');
}

function factLine(
  session: RedactionSession,
  fact: InsightFact,
  locales: readonly InsightLocale[],
): RedactedText {
  // The id and the kind are ours (the id has a fixed shape in `insightFactSchema`); the value and the display
  // can hold a name staff typed, so only those are neutralized.
  const parts = [`[${fact.id}] ${fact.kind} ${neutralizeInsightText(String(fact.value))}`];
  for (const locale of locales) {
    parts.push(`${locale}: ${neutralizeInsightText(fact.display[locale])}`);
  }
  const line = parts.join(' | ');
  // Cut after redacting: a cut address is no longer recognized (N4).
  return clipRedacted(session.redactToolOutput('insight', line), MAX_FACT_LINE + 40);
}

function elementsBlock(session: RedactionSession, batch: InsightNarrationBatch): RedactedText {
  const lines: RedactedText[] = [session.redact('<elements>')];
  for (const item of batch.elements) {
    lines.push(session.redact(`<element key="${item.key}">`), session.redact('<facts>'));
    for (const fact of item.facts) lines.push(factLine(session, fact, batch.locales));
    lines.push(session.redact('</facts>'), session.redact('</element>'));
  }
  lines.push(session.redact('</elements>'));
  return joinRedacted(lines, '\n');
}

// --- post-checks -------------------------------------------------------------------------------------------

const THAI_LETTER = /[฀-๿]/g;
const LATIN_LETTER = /[A-Za-z]/g;
const PLACEHOLDER = /\[[A-Z_]+_\d{1,9}\]/g;

/** Script of the sentence against the language asked: Thai needs Thai letters, English needs (almost) none. */
export function matchesLocale(text: string, locale: InsightLocale): boolean {
  const bare = text.replaceAll(PLACEHOLDER, ' ');
  const thai = (bare.match(THAI_LETTER) ?? []).length;
  const latin = (bare.match(LATIN_LETTER) ?? []).length;
  if (thai + latin === 0) return false;
  const thaiShare = thai / (thai + latin);
  // Names and labels typed by staff may be in the other script: allow a minority.
  return locale === 'th' ? thaiShare >= 0.3 : thaiShare < 0.2;
}

function evidenceOf(facts: readonly InsightFact[]): InsightStoredEvidence[] {
  const evidence: InsightStoredEvidence[] = [];
  for (const fact of facts) {
    if (fact.ref === undefined) continue;
    evidence.push({ kind: fact.ref.kind, id: fact.ref.id, factId: fact.id });
  }
  return evidence;
}

function numericValueOf(fact: InsightFact): number | null {
  if (typeof fact.value === 'number') return fact.value;
  const parsed = Number(fact.value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface Candidate {
  readonly claim: NarratedInsightClaim;
  /** For the order check: whom it is about and the figure, when it is about exactly one person. */
  readonly personValue: PersonClaimValue | null;
}

function checkClaim(
  session: RedactionSession,
  item: InsightNarrationElement,
  locale: InsightLocale,
  raw: z.infer<typeof claimSchema>,
):
  | { readonly ok: true; readonly candidate: Candidate }
  | { readonly ok: false; readonly reason: InsightRejectReason; readonly detail?: string } {
  const byId = new Map(item.facts.map((fact) => [fact.id, fact]));
  // Only the ids issued in this call, for this element; a duplicate counts once.
  const cited = [...new Set(raw.factIds)]
    .map((id) => byId.get(id))
    .filter((fact): fact is InsightFact => fact !== undefined);
  if (cited.length === 0) return { ok: false, reason: 'uncited' };

  const text = stripLinks(raw.text).trim();
  if (text === '') return { ok: false, reason: 'uncited' };
  if (!matchesLocale(text, locale)) return { ok: false, reason: 'locale_mismatch' };
  if (!numbersSubsetOfFacts(text.replaceAll(PLACEHOLDER, ' '), cited).ok) {
    return { ok: false, reason: 'number_not_in_facts' };
  }

  let personValue: PersonClaimValue | null = null;
  const definition = INSIGHT_ELEMENTS[item.key];
  if (definition.personRefs !== 'none') {
    const users = [
      ...new Map(
        cited
          .filter((fact) => fact.ref?.kind === 'user')
          .map((fact) => [fact.ref?.id ?? '', fact] as const),
      ).values(),
    ];
    const tokens = distinctPersonTokens(text);
    const tone = personToneCheck(text, {
      personContext: definition.personRefs === 'self' || tokens > 0 || users.length > 0,
      citedUsers: users.length,
    });
    if (!tone.ok) return { ok: false, reason: 'person_tone', detail: tone.reason };
    const only = users.length === 1 && tokens <= 1 ? users[0] : undefined;
    const value = only === undefined ? null : numericValueOf(only);
    if (only?.ref !== undefined && value !== null) {
      personValue = { person: only.ref.id, value };
    }
  }

  return {
    ok: true,
    candidate: {
      claim: {
        // Model words coming back: placeholders stay, anything else that looks like personal data becomes one (N4).
        text: session.fromModel(text),
        factIds: cited.map((fact) => fact.id),
        evidence: evidenceOf(cited),
      },
      personValue,
    },
  };
}

// --- the agent ---------------------------------------------------------------------------------------------

/**
 * Narrates up to four elements of one viewer group in one call, in the languages somebody is watching
 * (ADR-029 sections 9.4, 9.5, 9.9). The model sees redacted facts and writes at most three claims per element
 * and language; in code, a claim is kept only if it cites a fact of its own element, uses only numbers its
 * facts give, is in the language asked, has no link, and (for an element with people) passes `personToneCheck`.
 * Nothing kept for an element is a normal result (silence is allowed), and every rejection is returned with its
 * reason for the `insight.narration_rejected{reason}` metric. No facts at all: no model call.
 */
export async function narrateElements(
  deps: AgentDeps & { redactorFor?(names: readonly string[]): Redactor },
  batch: InsightNarrationBatch,
): Promise<InsightNarrationOutcome> {
  assertInsightBatch(batch);
  const empty = batch.elements.every((item) => item.facts.length === 0);
  if (empty) {
    return {
      status: 'ok',
      accepted: {},
      rejected: [],
      runId: null,
      mock: false,
      redaction: deps.redactor.session({ scope: batch.scope }),
    };
  }

  const decision = await askGuard(deps.guard, {
    agent: INSIGHT_NARRATOR_AGENT,
    ticketId: null,
    action: 'insight_narration',
  });
  if (!decision.allowed) return { status: 'skipped', reason: decision.reason };

  const prompt = deps.prompts.latest(ELEMENT_INSIGHT_PROMPT_ID);
  const names = [...new Set(batch.names ?? [])];
  const session = (deps.redactorFor?.(names) ?? deps.redactor).session({ scope: batch.scope });
  let result: AuditedResult;
  try {
    const system = session.redact(
      renderPrompt(prompt.body, {
        locales: batch.locales
          .map((l) => (l === 'th' ? 'Thai (th)' : 'English (en)'))
          .join(' and '),
        maxClaims: String(MAX_INSIGHT_CLAIMS),
      }),
    );
    const user = elementsBlock(session, batch);
    result = await deps.llm.generate({
      agent: INSIGHT_NARRATOR_AGENT,
      prompt: prompt.ref,
      system,
      messages: [{ role: 'user', content: user }],
      redaction: session,
      ticketId: null,
      action: 'insight_narration',
      maxOutputTokens: 1200,
      temperature: 0,
      ...(batch.abortSignal === undefined ? {} : { abortSignal: batch.abortSignal }),
    });
  } catch (error) {
    const reason = skippedFor(error);
    if (reason !== null) return { status: 'skipped', reason };
    return failureFor(error);
  }

  const answer = extractJsonObject(result.response.text);
  const top = z.record(z.string(), z.unknown()).safeParse(answer);
  if (!top.success) return { status: 'failed', reason: 'model_output_invalid' };

  const accepted: InsightAcceptedClaims = {};
  const rejected: RejectedInsightClaim[] = [];
  const known = new Set<string>(batch.elements.map((item) => item.key));
  for (const key of Object.keys(top.data)) {
    if (!known.has(key)) rejected.push({ elementKey: key, reason: 'unknown_element' });
  }

  for (const item of batch.elements) {
    const parsed = elementAnswerSchema.safeParse(top.data[item.key] ?? {});
    if (!parsed.success) {
      rejected.push({ elementKey: item.key, reason: 'schema' });
      continue;
    }
    for (const locale of ['th', 'en'] as const) {
      const list = parsed.data[locale];
      if (list === undefined) continue;
      if (!batch.locales.includes(locale)) {
        rejected.push({ elementKey: item.key, locale, reason: 'locale_not_requested' });
        continue;
      }
      const kept: Candidate[] = [];
      for (const [index, raw] of list.entries()) {
        if (index >= MAX_INSIGHT_CLAIMS) {
          rejected.push({ elementKey: item.key, locale, reason: 'too_many' });
          continue;
        }
        const checked = checkClaim(session, item, locale, raw);
        if (checked.ok) kept.push(checked.candidate);
        else {
          rejected.push({
            elementKey: item.key,
            locale,
            reason: checked.reason,
            ...(checked.detail === undefined ? {} : { detail: checked.detail }),
          });
        }
      }
      // A ranking by the order of the claims, with no sentence that says it (section 9.9).
      const drops = new Set(implicitRankingDrops(kept.map((candidate) => candidate.personValue)));
      for (let n = 0; n < drops.size; n += 1) {
        rejected.push({
          elementKey: item.key,
          locale,
          reason: 'person_tone',
          detail: 'implicit_ranking',
        });
      }
      const claims = kept
        .filter((_, index) => !drops.has(index))
        .map((candidate) => candidate.claim);
      if (claims.length > 0) (accepted[item.key] ??= {})[locale] = claims;
    }
  }

  return {
    status: 'ok',
    accepted,
    rejected,
    runId: result.runId,
    mock: result.run.provider === 'mock',
    redaction: session,
  };
}
