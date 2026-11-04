import type {
  DraftResult,
  KbAuthorDraft,
  ResolutionGrade,
  TicketClassification,
} from '@watchtower/ai';

import type { ClassifierCase, DrafterCase, GraderCase, KbAuthorCase } from './case.js';

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
