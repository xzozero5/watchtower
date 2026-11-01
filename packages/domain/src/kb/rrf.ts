/**
 * Reciprocal Rank Fusion (Cormack, Clarke and Buettcher, 2009): the score of an item is the sum,
 * over the ranked lists it appears in, of `1 / (k + rank)`. It needs no calibration between a
 * trigram score and a cosine distance, which is why it fuses keyword and vector search. `k = 60`
 * is the constant from the paper `[VERIFY]` and is what most implementations use.
 */
export const RRF_K = 60;

export interface RankedList {
  /** Name of the list, kept in `ranks` of the result (for example `keyword`, `vector`). */
  readonly name: string;
  /** Best first. A repeated id counts at its first position only. */
  readonly ids: readonly string[];
}

export interface FusedItem {
  readonly id: string;
  readonly score: number;
  /** 1-based rank of the item in each list it appears in. */
  readonly ranks: Readonly<Record<string, number>>;
}

/** Fuses ranked lists, best first. Ties go to the item with the better single rank, then to the id. */
export function reciprocalRankFusion(lists: readonly RankedList[], k = RRF_K): FusedItem[] {
  const table = new Map<string, { score: number; ranks: Record<string, number> }>();
  for (const list of lists) {
    const seen = new Set<string>();
    let rank = 0;
    for (const id of list.ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      rank += 1;
      const entry = table.get(id) ?? { score: 0, ranks: {} };
      entry.score += 1 / (k + rank);
      entry.ranks[list.name] = rank;
      table.set(id, entry);
    }
  }
  const best = (ranks: Record<string, number>): number => Math.min(...Object.values(ranks));
  return [...table.entries()]
    .map(([id, entry]) => ({ id, score: entry.score, ranks: entry.ranks }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        best(a.ranks) - best(b.ranks) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}
