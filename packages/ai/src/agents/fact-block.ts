import type { ClaimEvidence, ClaimEvidenceKind } from '@watchtower/shared';

import { clipRedacted, joinRedacted } from '../redaction/redacted-text.js';
import type { Redactor } from '../redaction/redactor.js';
import { neutralizeTags } from './leak-check.js';

/** What one fact needs to be shown to the model and cited by a person. */
export interface CitableFact {
  readonly kind: ClaimEvidenceKind;
  /** What the model reads. */
  readonly text: string;
  /** What the chip says. */
  readonly label: string;
  /** A page of the app, or absent when the source has none. */
  readonly href?: string | undefined;
  readonly mock?: boolean | undefined;
}

export const MAX_FACT_CHARS = 400;

/**
 * The fact lines the model reads, each redacted (N4) and cut after redaction, between `<facts>` tags. The ids
 * are positions (`f1`, `f2`...): the model cites by id and never writes a link.
 */
export function factBlock(session: ReturnType<Redactor['session']>, facts: readonly CitableFact[]) {
  const lines = facts
    .map((fact, index) =>
      session.redactToolOutput(
        'summary',
        `[f${String(index + 1)}] ${fact.kind}${fact.mock === true ? ' (mock data)' : ''}: ${neutralizeTags(
          fact.text,
        ).replaceAll(/<(\/?\s*facts\b)/gi, '‹$1')}`,
      ),
    )
    // Cut after redacting: a cut address or number is no longer recognized (N4).
    .map((line) => clipRedacted(line, MAX_FACT_CHARS + 40));
  return joinRedacted([session.redact('<facts>'), ...lines, session.redact('</facts>')], '\n');
}

/** The chips of the facts a sentence cites by id. An id that is not a fact is ignored. */
export function evidenceFor(
  facts: readonly CitableFact[],
  ids: readonly string[],
): ClaimEvidence[] {
  const evidence: ClaimEvidence[] = [];
  for (const id of new Set(ids)) {
    const index = /^f(\d{1,3})$/.exec(id)?.[1];
    const fact = index === undefined ? undefined : facts[Number(index) - 1];
    if (fact === undefined) continue;
    evidence.push({
      kind: fact.kind,
      label: fact.label,
      ...(fact.href === undefined ? {} : { href: fact.href }),
      ...(fact.mock === true ? { mock: true } : {}),
    });
  }
  return evidence;
}
