/**
 * Detects, in code, text that came from content a customer must not read (SR108-3). The model's own
 * claim about what it cited is not trusted: a sentence with `evidenceIds: []` can still repeat a log
 * line. A sentence "leaks" when it shares a run of words, or an identifier-like token, with the
 * restricted text and not with the text the customer may read.
 *
 * `[ASSUMED]` This catches copying and light editing, not a paraphrase in other words: that is why the
 * drafter in restricted mode is also given only the customer-safe evidence, and a person approves.
 */

const segmenter = new Intl.Segmenter('th', { granularity: 'word' });
/** Words in a run. Four words are rare enough by chance and short enough to catch a copied clause. */
const RUN = 4;
/** Shortest token that holds a digit and counts as an identifier (a port, an id, a count). */
const MIN_ID_LENGTH = 4;

function words(text: string): string[] {
  const out: string[] = [];
  for (const part of segmenter.segment(text.normalize('NFC').toLowerCase())) {
    if (part.isWordLike === true) out.push(part.segment);
  }
  return out;
}

export interface Fingerprint {
  readonly runs: ReadonlySet<string>;
  readonly ids: ReadonlySet<string>;
}

function collect(texts: readonly string[]): { runs: Set<string>; ids: Set<string> } {
  const runs = new Set<string>();
  const ids = new Set<string>();
  for (const text of texts) {
    const list = words(text);
    for (let index = 0; index + RUN <= list.length; index += 1) {
      runs.add(list.slice(index, index + RUN).join(' '));
    }
    for (const word of list) {
      if (word.length >= MIN_ID_LENGTH && /\d/.test(word)) ids.add(word);
    }
  }
  return { runs, ids };
}

/** What the restricted texts contain that the allowed texts do not. */
export function fingerprintOf(restricted: readonly string[], allowed: readonly string[]): Fingerprint {
  const bad = collect(restricted);
  const good = collect(allowed);
  for (const run of good.runs) bad.runs.delete(run);
  for (const id of good.ids) bad.ids.delete(id);
  return bad;
}

export function leaks(fingerprint: Fingerprint, sentence: string): boolean {
  if (fingerprint.runs.size === 0 && fingerprint.ids.size === 0) return false;
  const list = words(sentence);
  for (let index = 0; index + RUN <= list.length; index += 1) {
    if (fingerprint.runs.has(list.slice(index, index + RUN).join(' '))) return true;
  }
  return list.some((word) => fingerprint.ids.has(word));
}

/**
 * Text between our own tags is data. A customer who writes the closing tag could end the block and
 * speak as the prompt, so the angle bracket of such a tag is replaced (SR108 P2).
 */
export function neutralizeTags(text: string): string {
  return text.replaceAll(/<(\/?\s*(?:ticket|evidence|report)\b)/gi, '‹$1');
}
