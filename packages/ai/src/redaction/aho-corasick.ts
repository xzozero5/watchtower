/**
 * Aho-Corasick multi-pattern matcher over UTF-16 code units (R-4). Build is linear in the total
 * pattern length and a scan is linear in the text plus the number of matches it looks at, however
 * many patterns there are. No dependency.
 *
 * A scan does not materialise every match (SR106-N2). It keeps a sliding window of candidates no
 * wider than the longest pattern and selects leftmost-longest, non-overlapping matches while it
 * goes, so memory is bounded by `longest pattern ^ 2` whatever the text and the dictionary are.
 * Work is bounded by a ceiling on the matches looked at; past it the scan throws
 * `MatchLimitError` instead of running on (fail closed: the caller must not send the text on).
 */
export interface AhoMatch {
  /** Index of the first unit of the match. */
  start: number;
  /** Index after the last unit of the match. */
  end: number;
  /** Index of the pattern in the array passed to `buildMatcher`. */
  pattern: number;
}

/** A scan looked at more matches than the ceiling allows. */
export class MatchLimitError extends Error {
  override readonly name = 'MatchLimitError';
}

/** Default ceiling on matches looked at in one scan (before selection). */
export const DEFAULT_MAX_MATCHES = 2_000_000;

export interface ScanOptions {
  /** Drops a candidate (for example one inside a word). Called with the candidate's range. */
  accept?: (start: number, end: number, pattern: number) => boolean;
  /** Ceiling on candidates looked at. Default `DEFAULT_MAX_MATCHES`. */
  maxMatches?: number;
}

export interface Matcher {
  /**
   * Leftmost-longest, non-overlapping matches in order of position. Throws `MatchLimitError` when
   * the text makes the scan look at more than `maxMatches` candidates.
   */
  scan(text: string, options?: ScanOptions): AhoMatch[];
}

const STRIDE = 0x10000;

export function buildMatcher(patterns: readonly string[]): Matcher {
  // Edges live in one Map keyed by node * 65536 + code unit: far fewer objects than a Map per node.
  const edges = new Map<number, number>();
  const nodeDepth: number[] = [0];
  const terminal: number[] = [-1]; // pattern index ending exactly at this node, or -1

  patterns.forEach((pattern, patternIndex) => {
    if (pattern.length === 0) return;
    let node = 0;
    for (let index = 0; index < pattern.length; index += 1) {
      const key = node * STRIDE + pattern.charCodeAt(index);
      let next = edges.get(key);
      if (next === undefined) {
        next = nodeDepth.length;
        nodeDepth.push((nodeDepth[node] ?? 0) + 1);
        terminal.push(-1);
        edges.set(key, next);
      }
      node = next;
    }
    terminal[node] = patternIndex;
  });

  const fail = new Int32Array(nodeDepth.length);
  // Nearest node on the failure chain that ends a pattern; lets a scan list every suffix match.
  const output = new Int32Array(nodeDepth.length).fill(-1);

  // Breadth-first over the trie: children grouped by parent so we do not scan the whole map.
  const children: number[][] = Array.from({ length: nodeDepth.length }, () => []);
  for (const [key, child] of edges) children[Math.floor(key / STRIDE)]?.push(child);
  const codeOf = new Int32Array(nodeDepth.length);
  for (const [key, child] of edges) codeOf[child] = key % STRIDE;

  const queue: number[] = [];
  for (const child of children[0] ?? []) {
    fail[child] = 0;
    queue.push(child);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head] ?? 0;
    for (const child of children[node] ?? []) {
      const code = codeOf[child] ?? 0;
      let state = fail[node] ?? 0;
      while (state !== 0 && !edges.has(state * STRIDE + code)) state = fail[state] ?? 0;
      const target = edges.get(state * STRIDE + code);
      fail[child] = target !== undefined && target !== child ? target : 0;
      const failNode = fail[child] ?? 0;
      output[child] = (terminal[failNode] ?? -1) >= 0 ? failNode : (output[failNode] ?? -1);
      queue.push(child);
    }
  }

  const longest = Math.max(
    1,
    nodeDepth.reduce((max, depth) => Math.max(max, depth), 0),
  );

  return {
    scan(text, options = {}) {
      const accept = options.accept;
      const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
      const selected: AhoMatch[] = [];
      let pending: AhoMatch[] = [];
      let coveredUntil = 0;
      let looked = 0;

      // Decides every pending candidate that starts before `limit`. No later match can start
      // there, so the ones with a smaller start have all been seen: take them leftmost first and
      // longest first, skipping any that overlaps what is already taken.
      const decide = (limit: number): void => {
        const ready: AhoMatch[] = [];
        const keep: AhoMatch[] = [];
        for (const match of pending) (match.start < limit ? ready : keep).push(match);
        pending = keep;
        ready.sort((a, b) => a.start - b.start || b.end - a.end);
        for (const match of ready) {
          if (match.start < coveredUntil) continue;
          selected.push(match);
          coveredUntil = match.end;
        }
      };

      let node = 0;
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        while (node !== 0 && !edges.has(node * STRIDE + code)) node = fail[node] ?? 0;
        node = edges.get(node * STRIDE + code) ?? 0;
        let hit = (terminal[node] ?? -1) >= 0 ? node : (output[node] ?? -1);
        while (hit > 0) {
          looked += 1;
          if (looked > maxMatches) {
            throw new MatchLimitError(
              `The text produced more than ${String(maxMatches)} dictionary matches`,
            );
          }
          const start = index + 1 - (nodeDepth[hit] ?? 0);
          const pattern = terminal[hit] ?? 0;
          if (accept === undefined || accept(start, index + 1, pattern)) {
            pending.push({ start, end: index + 1, pattern });
          }
          hit = output[hit] ?? -1;
        }
        // Once per window, so the cost of deciding is amortised over `longest` positions.
        if ((index + 1) % longest === 0) decide(index + 2 - longest);
      }
      decide(Infinity);
      return selected;
    },
  };
}
