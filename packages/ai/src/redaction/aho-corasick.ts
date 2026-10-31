/**
 * Aho-Corasick multi-pattern matcher over UTF-16 code units (R-4). Build is linear in the total
 * pattern length and a scan is linear in the text plus the number of matches, however many
 * patterns there are. No dependency.
 */
export interface AhoMatch {
  /** Index of the first unit of the match. */
  start: number;
  /** Index after the last unit of the match. */
  end: number;
  /** Index of the pattern in the array passed to `buildMatcher`. */
  pattern: number;
}

export interface Matcher {
  /** All matches that end at each position, longest first, in order of end position. */
  scan(text: string): AhoMatch[];
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

  return {
    scan(text) {
      const found: AhoMatch[] = [];
      let node = 0;
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        while (node !== 0 && !edges.has(node * STRIDE + code)) node = fail[node] ?? 0;
        node = edges.get(node * STRIDE + code) ?? 0;
        let hit = (terminal[node] ?? -1) >= 0 ? node : (output[node] ?? -1);
        while (hit > 0) {
          found.push({
            start: index + 1 - (nodeDepth[hit] ?? 0),
            end: index + 1,
            pattern: terminal[hit] ?? 0,
          });
          hit = output[hit] ?? -1;
        }
      }
      return found;
    },
  };
}
