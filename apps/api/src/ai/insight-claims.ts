import {
  claimHrefSchema,
  makeClaim,
  type AiEvidence,
  type AiReport,
  type Claim,
  type ClaimEvidence,
  type ClaimEvidenceKind,
} from '@watchtower/shared';

import { ticketHref } from '../assistant/assistant-hrefs.js';

const KIND: Readonly<Record<AiEvidence['kind'], ClaimEvidenceKind>> = {
  kb: 'kb',
  ticket: 'ticket',
  log: 'log',
  data: 'data',
  repo: 'repo',
};

/** The ticket a stored evidence link names: `/?ticket=OPS-1` (now) or `/tickets/OPS-1` (older rows). */
export function ticketKeyOfHref(href: string | undefined): string | null {
  if (href === undefined) return null;
  const query = /^\/\?ticket=([A-Za-z][A-Za-z0-9]{1,9}-\d{1,15})$/.exec(href)?.[1];
  const legacy = /^\/tickets\/([A-Za-z][A-Za-z0-9]{1,9}-\d{1,15})$/.exec(href)?.[1];
  return query ?? legacy ?? null;
}

/**
 * The findings of an investigation report in the one claim shape (T-135, N5). A finding is only as
 * good as the cards it cites: each card becomes a chip, a finding that cites no card (or only ids
 * that are not on the ticket) is `uncited`. A link survives only if the viewer may open it: a ticket
 * link when `openableTickets` holds its key (the caller looked each one up with the viewer's own
 * access), an `https` link as it is, anything else (the knowledge base has no page yet) is dropped
 * and the chip says there is no link.
 */
export function claimsOfReport(
  report: AiReport,
  evidence: readonly AiEvidence[],
  openableTickets: ReadonlySet<string>,
): Claim[] {
  const byId = new Map(evidence.map((card) => [card.id, card]));
  return report.findings.map((finding) => {
    const chips: ClaimEvidence[] = [];
    for (const id of new Set(finding.evidenceIds)) {
      const card = byId.get(id);
      if (card === undefined) continue;
      const key = ticketKeyOfHref(card.href);
      const href =
        key !== null
          ? openableTickets.has(key)
            ? ticketHref(key)
            : undefined
          : card.href !== undefined && /^https:\/\//.test(card.href)
            ? card.href
            : undefined;
      chips.push({
        kind: KIND[card.kind],
        label: card.title.slice(0, 200) || card.id,
        ...(href !== undefined && claimHrefSchema.safeParse(href).success ? { href } : {}),
        ...(card.mock === true ? { mock: true } : {}),
      });
    }
    return makeClaim(finding.text.slice(0, 600), chips);
  });
}
