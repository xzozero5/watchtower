import {
  distinctPersonTokens,
  matchesLocale,
  personToneCheck,
  type DraftResult,
  type InsightNarrationOutcome,
  type KbAuthorDraft,
  type ResolutionGrade,
  type TicketClassification,
} from '@watchtower/ai';
import { INSIGHT_ELEMENTS, numbersSubsetOfFacts } from '@watchtower/shared';

import type {
  ClassifierCase,
  DrafterCase,
  GraderCase,
  InsightCase,
  KbAuthorCase,
} from './case.js';

export interface Check {
  readonly name: string;
  readonly pass: boolean;
  /** What was found, when the check failed or the number matters. Never ticket text beyond a few words. */
  readonly detail?: string | undefined;
}

const PLACEHOLDER = /\[[A-Z][A-Z_]*_\d+\]/;
const has = (text: string, needle: string): boolean =>
  text.toLowerCase().includes(needle.toLowerCase());

export function checkClassifier(
  got: TicketClassification,
  expect: ClassifierCase['expect'],
): Check[] {
  const checks: Check[] = [
    {
      name: 'intent',
      pass: got.intentKey === expect.intentKey,
      detail: `expected ${String(expect.intentKey)}, got ${String(got.intentKey)}`,
    },
  ];
  if (expect.type !== undefined) {
    checks.push({
      name: 'type',
      pass: got.type === expect.type,
      detail: `expected ${expect.type}, got ${got.type}`,
    });
  }
  if (expect.minConfidence !== undefined) {
    checks.push({
      name: 'confidence',
      pass: got.confidence >= expect.minConfidence,
      detail: `${got.confidence.toFixed(2)} against ${expect.minConfidence.toFixed(2)}`,
    });
  }
  return checks;
}

export function checkDrafter(got: DraftResult, expect: DrafterCase['expect']): Check[] {
  const checks: Check[] = [
    // A placeholder that is not the customer's own, or a reply in the wrong language, is flagged by the agent.
    ...(expect.noReviewFlag
      ? [
          {
            name: 'no review flag',
            pass: !got.needsReview && !PLACEHOLDER.test(got.body),
            detail: got.needsReview ? 'the draft needs review' : undefined,
          },
        ]
      : []),
  ];
  if (expect.language !== undefined) {
    checks.push({
      name: 'language',
      pass: got.language === expect.language,
      detail: `expected ${expect.language}, got ${got.language}`,
    });
  }
  for (const needle of expect.mustContain ?? []) {
    checks.push({ name: `contains "${needle}"`, pass: has(got.body, needle) });
  }
  for (const needle of expect.mustNotContain ?? []) {
    checks.push({ name: `does not contain "${needle}"`, pass: !has(got.body, needle) });
  }
  if (expect.maxUncitedClaims !== undefined) {
    checks.push({
      name: 'uncited claims',
      pass: got.uncitedClaims <= expect.maxUncitedClaims,
      detail: `${String(got.uncitedClaims)} against at most ${String(expect.maxUncitedClaims)}`,
    });
  }
  return checks;
}

export function checkGrader(got: ResolutionGrade, expect: GraderCase['expect']): Check[] {
  const checks: Check[] = [];
  if (expect.resolutionClass !== undefined) {
    checks.push({
      name: 'resolution class',
      pass: got.resolutionClass === expect.resolutionClass,
      detail: `expected ${expect.resolutionClass}, got ${got.resolutionClass}`,
    });
  }
  if (expect.resolutionClassIn !== undefined) {
    checks.push({
      name: 'resolution class in set',
      pass: expect.resolutionClassIn.includes(got.resolutionClass),
      detail: `got ${got.resolutionClass}, allowed ${expect.resolutionClassIn.join('|')}`,
    });
  }
  if (expect.draftVerdictIn !== undefined) {
    checks.push({
      name: 'draft verdict',
      pass: expect.draftVerdictIn.includes(got.draftVerdict),
      detail: `got ${got.draftVerdict}, allowed ${expect.draftVerdictIn.join('|')}`,
    });
  }
  if (expect.minDraftQuality !== undefined) {
    checks.push({
      name: 'draft quality',
      pass: got.draftQuality !== null && got.draftQuality >= expect.minDraftQuality,
      detail: `${got.draftQuality === null ? 'none' : got.draftQuality.toFixed(2)} against at least ${expect.minDraftQuality.toFixed(2)}`,
    });
  }
  if (expect.maxViolations !== undefined) {
    checks.push({
      name: 'policy violations (max)',
      pass: got.violations.length <= expect.maxViolations,
      detail: `${String(got.violations.length)} against at most ${String(expect.maxViolations)}`,
    });
  }
  if (expect.minViolations !== undefined) {
    checks.push({
      name: 'policy violations (min)',
      pass: got.violations.length >= expect.minViolations,
      detail: `${String(got.violations.length)} against at least ${String(expect.minViolations)}`,
    });
  }
  if (expect.kbGap !== undefined) {
    checks.push({
      name: 'kb gap',
      pass: got.kbGap === expect.kbGap,
      detail: `expected ${String(expect.kbGap)}, got ${String(got.kbGap)}`,
    });
  }
  // A grade that cites nothing is not a grade (N5): every reason carries evidence.
  checks.push({
    name: 'reasons cite evidence',
    pass: got.reasons.every((reason) => !reason.uncited),
  });
  return checks;
}

export function checkKbAuthor(got: KbAuthorDraft | null, expect: KbAuthorCase['expect']): Check[] {
  const checks: Check[] = [
    {
      name: 'drafted',
      pass: (got !== null) === expect.drafted,
      detail: `got ${got === null ? 'nothing' : 'an article'}`,
    },
  ];
  if (got === null) return checks;
  for (const needle of expect.titleContains ?? []) {
    checks.push({ name: `title contains "${needle}"`, pass: has(got.title, needle) });
  }
  for (const needle of expect.bodyMustNotContain ?? []) {
    checks.push({ name: `body does not contain "${needle}"`, pass: !has(got.bodyMd, needle) });
  }
  for (const tag of expect.tagsInclude ?? []) {
    checks.push({ name: `tag ${tag}`, pass: got.intentTags.includes(tag) });
  }
  checks.push({ name: 'no placeholder in the article', pass: !PLACEHOLDER.test(got.bodyMd) });
  return checks;
}

const CONTACT_DATA = /[^\s@]+@[^\s@]+\.[a-z]{2,}|(?:\+?\d[\s-]?){9,}/i;

/**
 * Checks on a narration (T-417, ADR-029 section 9.8). They re-read the accepted claims against the case's
 * own facts, so they do not depend on the agent's post-checks being right: the hallucinated-number count,
 * the uncited count and the person-tone count must each be 0 (the pass bar of the eval).
 */
export function checkInsight(
  got: Extract<InsightNarrationOutcome, { status: 'ok' }>,
  item: InsightCase,
): Check[] {
  const checks: Check[] = [];
  let numbers = 0;
  let uncited = 0;
  let wrongLanguage = 0;
  let contact = 0;
  let tone = 0;
  for (const element of item.input.elements) {
    const byId = new Map(element.facts.map((fact) => [fact.id, fact]));
    const people = INSIGHT_ELEMENTS[element.key].personRefs !== 'none';
    const entry = got.accepted[element.key] ?? {};
    for (const locale of ['th', 'en'] as const) {
      for (const claim of entry[locale] ?? []) {
        const cited = claim.factIds.flatMap((id) => byId.get(id) ?? []);
        if (cited.length === 0) uncited += 1;
        if (!numbersSubsetOfFacts(claim.text.replaceAll(/\[[A-Z_]+_\d+\]/g, ' '), cited).ok) {
          numbers += 1;
        }
        if (!matchesLocale(claim.text, locale)) wrongLanguage += 1;
        if (CONTACT_DATA.test(claim.text)) contact += 1;
        if (people) {
          const users = new Set(
            cited.flatMap((fact) => (fact.ref?.kind === 'user' ? [fact.ref.id] : [])),
          );
          const result = personToneCheck(claim.text, {
            personContext:
              INSIGHT_ELEMENTS[element.key].personRefs === 'self' ||
              users.size > 0 ||
              distinctPersonTokens(claim.text) > 0,
            citedUsers: users.size,
          });
          if (!result.ok) tone += 1;
        }
      }
    }
  }
  checks.push(
    { name: 'hallucinated numbers = 0', pass: numbers === 0, detail: `${String(numbers)} claims` },
    { name: 'uncited claims = 0', pass: uncited === 0, detail: `${String(uncited)} claims` },
    { name: 'language matches', pass: wrongLanguage === 0, detail: `${String(wrongLanguage)} claims` },
    { name: 'no contact data', pass: contact === 0, detail: `${String(contact)} claims` },
    { name: 'person tone = 0', pass: tone === 0, detail: `${String(tone)} claims` },
  );
  for (const [key, rule] of Object.entries(item.expect.elements)) {
    const entry = got.accepted[key as keyof typeof got.accepted] ?? {};
    for (const locale of item.input.locales) {
      const claims = entry[locale] ?? [];
      const joined = claims.map((claim) => claim.text).join(' ');
      if (rule.maxClaims !== undefined) {
        checks.push({
          name: `${key} ${locale}: at most ${String(rule.maxClaims)} claims`,
          pass: claims.length <= rule.maxClaims,
          detail: `${String(claims.length)} claims`,
        });
      }
      if (rule.minClaims !== undefined) {
        checks.push({
          name: `${key} ${locale}: at least ${String(rule.minClaims)} claims`,
          pass: claims.length >= rule.minClaims,
          detail: `${String(claims.length)} claims`,
        });
      }
      for (const needle of rule.mustMention ?? []) {
        checks.push({ name: `${key} ${locale}: mentions "${needle}"`, pass: has(joined, needle) });
      }
      for (const needle of rule.mustNotContain ?? []) {
        checks.push({
          name: `${key} ${locale}: does not contain "${needle}"`,
          pass: !has(joined, needle),
        });
      }
    }
  }
  if (item.expect.maxRejected !== undefined) {
    checks.push({
      name: 'rejected in code (max)',
      pass: got.rejected.length <= item.expect.maxRejected,
      detail: `${String(got.rejected.length)} against at most ${String(item.expect.maxRejected)}`,
    });
  }
  for (const reason of item.expect.mustRejectFor ?? []) {
    checks.push({
      name: `rejected for ${reason}`,
      pass: got.rejected.some((entry) => entry.reason === reason),
    });
  }
  return checks;
}
