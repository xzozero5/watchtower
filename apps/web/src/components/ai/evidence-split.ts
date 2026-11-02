import type { AiEvidence } from '@watchtower/shared';

/**
 * Evidence scoring below this is folded behind "Show N weaker matches" `[ASSUMED]` 0.5: a knowledge
 * article about something else still comes back from a similarity search, with a low score.
 */
export const WEAK_EVIDENCE_THRESHOLD = 0.5;

/**
 * Splits evidence into the cards shown at once and the weaker ones that start folded. A card the
 * draft cites or a chip pointed at is never folded away, whatever its score. A stand-in AI's scores
 * mean nothing (`demo`), so nothing is folded then. The order is kept.
 */
export function splitEvidence(
  evidence: readonly AiEvidence[],
  options: { citedIds: readonly string[]; highlightId: string | null; demo: boolean },
): { strong: AiEvidence[]; weak: AiEvidence[] } {
  const strong: AiEvidence[] = [];
  const weak: AiEvidence[] = [];
  for (const entry of evidence) {
    const keep =
      options.demo ||
      entry.confidence >= WEAK_EVIDENCE_THRESHOLD ||
      options.citedIds.includes(entry.id) ||
      options.highlightId === entry.id;
    (keep ? strong : weak).push(entry);
  }
  return { strong, weak };
}
