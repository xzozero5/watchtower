import type { Claim } from '@watchtower/shared';

export interface CitationRef {
  readonly kind: string;
  readonly id: string;
}

/** Counts references, not labels, URLs or repeated citations. No grading thresholds live here. */
export function assistantCitationMetrics(
  claims: readonly Claim[],
  expected: readonly CitationRef[],
) {
  const key = (ref: CitationRef): string => JSON.stringify([ref.kind, ref.id]);
  const required = new Set(expected.map(key));
  const cited = new Set(
    claims.flatMap((claim) =>
      claim.evidence.flatMap((item) => (item.ref === undefined ? [] : [key(item.ref)])),
    ),
  );
  const matched = [...required].filter((ref) => cited.has(ref)).length;
  return {
    requiredRefs: required.size,
    matchedRefs: matched,
    citationRecall: required.size === 0 ? null : matched / required.size,
    uncitedClaims: claims.filter((claim) => claim.evidence.length === 0).length,
  };
}
