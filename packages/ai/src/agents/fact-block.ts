import type { ClaimEvidence, ClaimEvidenceKind } from '@watchtower/shared';

import { clipRedacted, joinRedacted } from '../redaction/redacted-text.js';
import type { Redactor } from '../redaction/redactor.js';
import { neutralizeTags } from './leak-check.js';
import type { FactTrust } from './untrusted.js';

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
  readonly ref?: { readonly kind: ClaimEvidenceKind; readonly id: string } | undefined;
  readonly trust?: FactTrust | undefined;
}

export const MAX_FACT_CHARS = 1200;

/**
 * The fact lines the model reads, each redacted (N4) and cut after redaction, between `<facts>` tags. The ids
 * are positions (`f1`, `f2`...): the model cites by id and never writes a link.
 */
export function factBlock(
  session: ReturnType<Redactor['session']>,
  facts: readonly CitableFact[],
  prefix = 'f',
) {
  const lines = facts.map((fact, index) => {
    // Remove only host-owned wrapper tags before neutralizing nested data. Rebuild the wrapper
    // AFTER redaction and clipping: it must never be cut or neutralized with its contents.
    const untrusted = fact.trust !== 'system';
    let body = fact.text;
    const open = body.indexOf('<untrusted_content>');
    const close = body.lastIndexOf('</untrusted_content>');
    if (untrusted && open >= 0 && close > open) {
      body =
        body.slice(0, open) +
        body.slice(open + '<untrusted_content>'.length, close) +
        body.slice(close + '</untrusted_content>'.length);
    }
    const safe = clipRedacted(
      session.redactToolOutput(
        'summary',
        neutralizeTags(body).replaceAll(
          /<(\/?\s*(?:facts|tool_results|context|history|request|tools)\b)/gi,
          '‹$1',
        ),
      ),
      MAX_FACT_CHARS - 100,
    );
    return joinRedacted(
      [
        session.redact(
          `[${prefix}${String(index + 1)}] ${fact.kind}${fact.mock === true ? ' (mock data)' : ''}: ${untrusted ? '<untrusted_content>' : ''}`,
        ),
        safe,
        session.redact(untrusted ? '</untrusted_content>' : ''),
      ],
      ' ',
    );
  });
  return joinRedacted(
    [
      session.redact(prefix === 'e' ? '<tool_results>' : '<facts>'),
      ...lines,
      session.redact(prefix === 'e' ? '</tool_results>' : '</facts>'),
    ],
    '\n',
  );
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
      ...(fact.ref === undefined ? {} : { ref: fact.ref }),
    });
  }
  return evidence;
}
