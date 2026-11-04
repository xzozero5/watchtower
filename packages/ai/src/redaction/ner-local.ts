import { createRequire } from 'node:module';

import { setDefaultNameFinder } from './redactor.js';

/**
 * Local name finder (T-153 prototype, `REDACTION_NER=local`). It finds a person's name that has no
 * cue ("Yesterday John Smith opened a ticket") and is not in the dictionary, which the cue detector
 * cannot. It runs inside the process: no network, no model download, nothing written to disk. The
 * engine is `compromise` (MIT, about 3 MB, rule and lexicon based, English only). It does NOT find
 * Thai names, and it is weaker on names that are not common in English text; it over-redacts a
 * capitalised word now and then. Both are the safe direction for N4. Measured in `evals/runner`
 * (`redaction` command); ADR-026 draft has the numbers and the plan for a stronger model.
 *
 * Work is bounded (SR106-N2): the text is cut into windows of at most `WINDOW` characters at a space
 * or line break, and only `MAX_WINDOWS` windows are read; past that the finder throws, so the
 * redactor fails closed instead of passing on text it did not check.
 */

/** A half-open range in the text given to the finder. */
export interface NameSpot {
  start: number;
  end: number;
}

/** Finds names in canonical text. May throw; the redactor then refuses the text (fail closed). */
export type NameFinder = (text: string) => readonly NameSpot[];

export class NerLimitError extends Error {
  override readonly name = 'NerLimitError';
}

const WINDOW = 20_000;
const MAX_WINDOWS = 60;

interface CompromiseJson {
  text: string;
  offset: { start: number; length: number };
}
interface CompromiseDoc {
  people(): { json(options: { offset: true; terms: false }): CompromiseJson[] };
}
type Compromise = (text: string) => CompromiseDoc;

let engine: Compromise | undefined;
function load(): Compromise {
  // Loaded on first use so that importing the package costs nothing when the flag is off.
  engine ??= createRequire(import.meta.url)('compromise') as Compromise;
  return engine;
}

/** Cut at the last space or line break before the limit, so a name is not split between windows. */
function windows(text: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let from = 0;
  while (from < text.length) {
    let to = Math.min(text.length, from + WINDOW);
    if (to < text.length) {
      const cut = Math.max(text.lastIndexOf(' ', to), text.lastIndexOf('\n', to));
      if (cut > from) to = cut;
    }
    out.push({ from, to });
    from = to;
  }
  return out;
}

const LETTER = /[\p{L}\p{M}'’-]/u;

export function createLocalNameFinder(): NameFinder {
  return (text) => {
    const cuts = windows(text);
    if (cuts.length > MAX_WINDOWS) {
      throw new NerLimitError(
        `Text is too long for the local name finder (${String(text.length)} characters)`,
      );
    }
    const nlp = load();
    const spots: NameSpot[] = [];
    for (const { from, to } of cuts) {
      const window = text.slice(from, to);
      for (const person of nlp(window).people().json({ offset: true, terms: false })) {
        let start = from + person.offset.start;
        let end = start + person.offset.length;
        // The engine keeps trailing punctuation ("Watanabe.", "Wei,"): keep only the letters.
        while (end > start && !LETTER.test(text[end - 1] ?? '')) end -= 1;
        while (start < end && !LETTER.test(text[start] ?? '')) start += 1;
        if (end > start) spots.push({ start, end });
      }
    }
    return spots;
  };
}

/** `REDACTION_NER`: `off` (default) or `local` (this finder). */
export const REDACTION_NER_MODES = ['off', 'local'] as const;
export type RedactionNerMode = (typeof REDACTION_NER_MODES)[number];

/** Sets the finder every redactor without its own uses. Call once at boot, from the config. */
export function applyRedactionNer(mode: RedactionNerMode): void {
  setDefaultNameFinder(mode === 'local' ? createLocalNameFinder() : null);
}
