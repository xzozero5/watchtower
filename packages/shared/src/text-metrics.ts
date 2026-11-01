/**
 * Small text measures the AI features share (T-108): the language of a message and how far a
 * person's final text is from the AI draft. Pure functions, no I/O.
 */

const THAI = /[฀-๿]/;
const LETTER = /\p{L}/gu;

/** `th` when at least a third of the letters are Thai, otherwise `en`. Empty text is `en`. */
export function detectLanguage(text: string): 'th' | 'en' {
  const letters = text.match(LETTER) ?? [];
  if (letters.length === 0) return 'en';
  // Thai vowel and tone marks are not letters; count letters on both sides.
  const thai = letters.filter((letter) => THAI.test(letter)).length;
  return thai / letters.length >= 1 / 3 ? 'th' : 'en';
}

/**
 * Most words compared per text. A longer text is cut: the distance then ignores the tail. A draft
 * is at most a few thousand words, so this only bounds the work for an odd input (the table is
 * `MAX_EDIT_WORDS` squared at worst).
 */
export const MAX_EDIT_WORDS = 4000;

const segmenter = new Intl.Segmenter('th', { granularity: 'word' });

function words(text: string): string[] {
  const out: string[] = [];
  for (const part of segmenter.segment(text.normalize('NFC'))) {
    if (part.isWordLike === true) out.push(part.segment.toLowerCase());
    if (out.length >= MAX_EDIT_WORDS) break;
  }
  return out;
}

/**
 * Normalised edit distance between two texts, 0 (same words in the same order) to 1 (nothing in
 * common): the Levenshtein distance over words (Thai is split by the ICU dictionary), divided by the
 * longer text's word count. Case and punctuation are ignored, so fixing a comma is not an edit.
 * `[ASSUMED]` a word-level measure matches how a reviewer sees a change better than characters do.
 */
export function editDistance(draft: string, final: string): number {
  const a = words(draft);
  const b = words(final);
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0 || b.length === 0) return 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return Math.round(((previous[b.length] ?? 0) / Math.max(a.length, b.length)) * 10_000) / 10_000;
}
