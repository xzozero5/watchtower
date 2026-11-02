/**
 * Detectors run on the normalised view (`normalize.ts`), so every offset here is an offset into
 * `view.text`; the redactor maps spans back to the original string.
 *
 * Performance rule (R-3): nothing here may backtrack over unbounded input. Numbers are found by a
 * single left-to-right scan that groups digit runs into clusters and tests bounded windows of
 * groups; emails are found by walking out from each `@` with hard length caps; names use
 * Aho-Corasick (plus the cue detector near the end: literal cues, bounded reads); the few regular expressions left are anchored literals or have bounded repeats.
 */
import { buildMatcher, MatchLimitError } from './aho-corasick.js';
import { foldForMatching, type NormalizedView } from './normalize.js';
import { isLuhnValid, isValidThaiNationalId } from './validators.js';

export const REDACTION_KINDS = [
  'THAI_ID',
  'CARD',
  'EMAIL',
  'PHONE',
  'BANK',
  'NAME',
  'LITERAL',
] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

/** A half-open range `[start, end)` in `view.text`. */
export interface Span {
  start: number;
  end: number;
  kind: RedactionKind;
  /** Higher wins when two spans overlap. */
  priority: number;
}

/** Matches the placeholder tokens the redactor itself writes, e.g. `[EMAIL_1]`. */
export const TOKEN_PATTERN = new RegExp(`\\[(?:${REDACTION_KINDS.join('|')})_[0-9]{1,9}\\]`, 'g');

const PRIORITY = {
  LITERAL: 200,
  THAI_ID: 100,
  CARD: 90,
  EMAIL: 80,
  BANK_CONTEXT: 70,
  PHONE: 60,
  BANK_FORMATTED: 50,
  NAME: 40,
} as const;

const span = (start: number, end: number, kind: RedactionKind, priority: number): Span => ({
  start,
  end,
  kind,
  priority,
});

/** Token-shaped text already in the input. It is escaped so a restore never expands it. */
export function detectTokenShapes(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    spans.push(span(match.index, match.index + match[0].length, 'LITERAL', PRIORITY.LITERAL));
  }
  return spans;
}

// ---------------------------------------------------------------------------------------------
// Email: walk out from each '@'
// ---------------------------------------------------------------------------------------------

const MAX_LOCAL = 64;
const MAX_DOMAIN = 255;
const ASCII_LOCAL = /[A-Za-z0-9._%+-]/;
const UNICODE_LOCAL = /[\p{L}\p{M}\p{N}._%+-]/u;
const ASCII_ALNUM = /[A-Za-z0-9]/;
const DOMAIN_LABEL_CHAR = /[\p{L}\p{M}\p{N}-]/u;
const THAI = /\p{Script=Thai}/u;
// The only top-level domain written in Thai script (.ไทย).
const THAI_TLD = 'ไทย';

interface Label {
  start: number;
  end: number;
}

/**
 * Where the domain ends, given its labels as scanned (Thai letters allowed). Thai is written
 * without spaces, so "example.comครับ" must stop at the end of "com": the last label counts only
 * up to its first Thai letter. A Thai label is a real domain part only before the Thai TLD
 * (".ไทย") or before a dot ("ร้านค้า.com"); a trailing Thai word that is not the TLD is dropped.
 * Returns the end offset and the number of labels kept.
 */
function domainEnd(text: string, labels: readonly Label[]): { end: number; count: number } {
  for (let count = labels.length; count > 0; count -= 1) {
    const label = labels[count - 1];
    if (label === undefined) break;
    const word = text.slice(label.start, label.end);
    if (word.startsWith(THAI_TLD)) return { end: label.start + THAI_TLD.length, count };
    let prefix = 0;
    while (prefix < word.length && !THAI.test(word.charAt(prefix))) prefix += 1;
    if (prefix === word.length) return { end: label.end, count };
    if (prefix >= 2) return { end: label.start + prefix, count };
    // A label that opens with Thai letters and is not the TLD: not part of the domain.
  }
  return { end: 0, count: 0 };
}

/** Where an `@` is written: the character itself, or its URL-encoded form `%40` (a query string, a mailto link). */
function atMarkers(text: string): { at: number; length: number }[] {
  const markers: { at: number; length: number }[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === '@') markers.push({ at: index, length: 1 });
    else if (char === '%' && text.startsWith('40', index + 1)) {
      markers.push({ at: index, length: 3 });
      index += 2;
    }
  }
  return markers;
}

export function detectEmails(text: string): Span[] {
  const spans: Span[] = [];
  let lastEnd = 0;
  for (const marker of atMarkers(text)) {
    const at = marker.at;
    // Local part: a run of ASCII local characters, or (when the character next to '@' is not
    // ASCII) a run of Unicode ones. Thai is written without spaces, so mixing would swallow
    // the Thai words in front of an ASCII address.
    const nextTo = text.charAt(at - 1);
    const unicodeLocal = nextTo !== '' && !ASCII_LOCAL.test(nextTo) && UNICODE_LOCAL.test(nextTo);
    const allowed = unicodeLocal ? UNICODE_LOCAL : ASCII_LOCAL;
    let start = at;
    while (start > lastEnd && at - start < MAX_LOCAL && allowed.test(text.charAt(start - 1))) {
      start -= 1;
    }
    if (unicodeLocal) {
      while (start < at && ASCII_ALNUM.test(text.charAt(start))) start += 1;
    }

    // Domain: labels of letters/digits/hyphens separated by single dots, at least two labels.
    const domainStart = at + marker.length;
    const labels: Label[] = [];
    let cursor = domainStart;
    while (cursor - domainStart < MAX_DOMAIN) {
      const labelStart = cursor;
      while (cursor < text.length && DOMAIN_LABEL_CHAR.test(text.charAt(cursor))) cursor += 1;
      if (cursor === labelStart) break;
      labels.push({ start: labelStart, end: cursor });
      if (text.charAt(cursor) === '.' && cursor + 1 < text.length) cursor += 1;
      else break;
    }
    const { end, count } = domainEnd(text, labels);
    if (start < at && count >= 2) {
      spans.push(span(start, end, 'EMAIL', PRIORITY.EMAIL));
      lastEnd = end;
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------------------------
// Numbers: digit clusters
// ---------------------------------------------------------------------------------------------

const SEPARATORS = new Set([
  ' ',
  '\t',
  '\n',
  '\r',
  '.',
  '-',
  '‐',
  '‑',
  '‒',
  '–',
  '—',
  '―',
  '−',
  '/',
  '_',
  ',',
  '、',
  '(',
  ')',
]);
const MAX_SEPARATOR_RUN = 3;
// 13: a Thai national ID typed one digit at a time ("1-2-3-...") is 13 groups.
const MAX_WINDOW_GROUPS = 13;
const MAX_WINDOW_DIGITS = 19;

interface Group {
  start: number;
  end: number;
}

interface Cluster {
  groups: Group[];
  /** `separators[i]` sits between `groups[i]` and `groups[i + 1]`. */
  separators: string[];
  plus: boolean;
  openParen: boolean;
}

const isDigitCode = (code: number): boolean => code >= 48 && code <= 57;

/** Digit runs joined by short separator runs ("081-234-5678", "(02) 123 4567", "+66 (0) 81 ..."). */
function findClusters(text: string): Cluster[] {
  const clusters: Cluster[] = [];
  const length = text.length;
  let index = 0;
  while (index < length) {
    if (!isDigitCode(text.charCodeAt(index))) {
      index += 1;
      continue;
    }
    const first = index;
    const groups: Group[] = [];
    const separators: string[] = [];
    let groupStart = index;
    for (;;) {
      let groupEnd = groupStart;
      while (groupEnd < length && isDigitCode(text.charCodeAt(groupEnd))) groupEnd += 1;
      groups.push({ start: groupStart, end: groupEnd });
      let next = groupEnd;
      while (
        next < length &&
        next - groupEnd < MAX_SEPARATOR_RUN &&
        SEPARATORS.has(text.charAt(next))
      ) {
        next += 1;
      }
      const run = next - groupEnd;
      if (
        run >= 1 &&
        run <= MAX_SEPARATOR_RUN &&
        next < length &&
        isDigitCode(text.charCodeAt(next))
      ) {
        separators.push(text.slice(groupEnd, next));
        groupStart = next;
      } else {
        index = groupEnd;
        break;
      }
    }
    const before = first > 0 ? text.charAt(first - 1) : '';
    clusters.push({
      groups,
      separators,
      plus: before === '+',
      openParen: before === '(' && separators.some((separator) => separator.includes(')')),
    });
  }
  return clusters;
}

/**
 * Separator kind with spaces ignored: "  " and " " both count as a space. A separator with a
 * parenthesis (") ", " (") is neutral, because "(02) 123-4567" mixes both styles on purpose.
 */
function separatorKind(separator: string): string | null {
  const rest = separator.replace(/[ \t\r\n()]/g, '');
  if (/[()]/.test(separator)) return rest === '' ? null : rest;
  return rest === '' ? ' ' : rest;
}

function consistentSeparators(cluster: Cluster, from: number, to: number): boolean {
  let kind: string | null | undefined;
  for (let index = from; index < to; index += 1) {
    const current = separatorKind(cluster.separators[index] ?? ' ');
    if (current === null) continue;
    kind ??= current;
    if (current !== kind) return false;
  }
  return true;
}

const MOBILE = /^0[689][0-9]{8}$/;
const BANGKOK = /^02[0-9]{7}$/;
const PROVINCIAL = /^0[3-57][0-9]{7}$/;
const INTERNATIONAL_00 = /^0066[2-9][0-9]{8,9}$/;
// Any run of 10 to 15 digits is treated as a phone number (T-137 review): a number can be written
// with a country code and no "+" (66812345678, 14155552671, 447911123456), glued to a word or a field
// name (msisdn_66812345678, phone=0812345678), or percent-encoded (%2B66812345678, read by the view).
// Guessing the shapes one at a time lets the next one through. A long numeric id that is not a phone
// is redacted too: N4 prefers a false positive. Only shapes known to be something else are left alone.
const PHONE_MIN_DIGITS = 10;
const PHONE_MAX_DIGITS = 15;

const SAFE_SHAPES: readonly RegExp[] = [
  // A uuid.
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu,
  // A trace, span, request or commit id: 16 or more hex characters in one token.
  /(?<![0-9A-Za-z])[0-9a-f]{16,}(?![0-9A-Za-z])/giu,
  // An ISO 8601 timestamp, with fractions and a zone.
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/gu,
];
// There is no exception for a ticket key. A key's number has fewer than 10 digits, so it can never
// be a run this rule looks at; an exception that matched `TEL-66812345678` or `TEL-415-555-2671`
// would only be a way to write a phone number past the redactor (T-137 re-review).

/** Length of the run of ASCII digits at the start of `value`, or at its end with `fromEnd`. */
function digitRun(value: string, fromEnd: boolean): number {
  let count = 0;
  while (count < value.length) {
    const code = value.charCodeAt(fromEnd ? value.length - 1 - count : count);
    if (code < 48 || code > 57) break;
    count += 1;
  }
  return count;
}

/**
 * The ranges of the text that are an id or a timestamp, not a phone number: sorted and joined into
 * disjoint intervals, so a lookup is a binary search and a text with many candidates and many ids
 * stays linear (R-4).
 */
function safeSpans(text: string): [number, number][] {
  const found: [number, number][] = [];
  for (const shape of SAFE_SHAPES) {
    for (const match of text.matchAll(shape)) {
      // A long hex id that opens or ends with 10 or more digits is a number with letters glued on
      // ("4155552671abcdef"), not an id. Counted with loops, not a pattern that restarts at every digit.
      if (
        !match[0].includes('-') &&
        (digitRun(match[0], false) >= PHONE_MIN_DIGITS ||
          digitRun(match[0], true) >= PHONE_MIN_DIGITS)
      ) {
        continue;
      }
      found.push([match.index, match.index + match[0].length]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [from, to] of found) {
    const last = merged[merged.length - 1];
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/** Is `[start, end)` inside one of the sorted, disjoint `safe` intervals? Binary search. */
function insideSafeSpan(safe: readonly [number, number][], start: number, end: number): boolean {
  let low = 0;
  let high = safe.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const interval = safe[middle];
    if (interval === undefined) return false;
    if (interval[1] <= start) low = middle + 1;
    else if (interval[0] > start) high = middle - 1;
    else return end <= interval[1];
  }
  return false;
}

// Digit-group shapes a person might type a phone number in. Used only when the separators are
// mixed ("081-234 5678"): a date followed by a count ("08/10/2026 12") has the same digits as a
// mobile number but not the same grouping.
const MIXED_SEPARATOR_PHONE_SHAPES = new Set([
  '3-3-4',
  '2-4-4',
  '3-4-3',
  '3-7',
  '2-8',
  '4-6',
  '2-3-4',
  '2-7',
  '3-3-3',
  '3-6',
]);

/**
 * A Thai national ID is written 1-4-5-2-1, but people also write it as 4-4-4-1, 5-5-3, or in two
 * halves, or even digit by digit. The shape is only a bound here (at most 13 groups); the check
 * digit and the first digit are what make a 13-digit window an ID.
 */
const MAX_ID_GROUPS = 13;

function isThaiIdShape(lengths: readonly number[]): boolean {
  return lengths.length <= MAX_ID_GROUPS;
}

function isCardShape(lengths: readonly number[]): boolean {
  if (lengths.length === 1) return true;
  const last = lengths[lengths.length - 1] ?? 0;
  if (last < 3 || last > 6) return false;
  return lengths.slice(0, -1).every((length) => length === 4 || length === 6);
}

function isBankFormattedShape(lengths: readonly number[]): boolean {
  const shape = lengths.join('-');
  return shape === '3-1-5-1' || shape === '3-6-1';
}

function detectInCluster(
  text: string,
  cluster: Cluster,
  spans: Span[],
  safe: readonly [number, number][],
): void {
  const { groups } = cluster;
  for (let from = 0; from < groups.length; from += 1) {
    const firstGroup = groups[from];
    if (firstGroup === undefined) continue;
    let digits = '';
    const lengths: number[] = [];
    const lastGroup = Math.min(groups.length, from + MAX_WINDOW_GROUPS);
    for (let to = from; to < lastGroup; to += 1) {
      const group = groups[to];
      if (group === undefined) break;
      const size = group.end - group.start;
      if (digits.length + size > MAX_WINDOW_DIGITS) break;
      digits += text.slice(group.start, group.end);
      lengths.push(size);

      const total = digits.length;
      const start = firstGroup.start;
      const phoneStart = from === 0 && (cluster.plus || cluster.openParen) ? start - 1 : start;
      const end = group.end;

      if (total === 13 && isThaiIdShape(lengths) && isValidThaiNationalId(digits)) {
        spans.push(span(start, end, 'THAI_ID', PRIORITY.THAI_ID));
      }
      if (total >= 13 && isCardShape(lengths) && isLuhnValid(digits)) {
        spans.push(span(start, end, 'CARD', PRIORITY.CARD));
      }

      if (from === 0 && cluster.plus) {
        if (total >= 8 && total <= 15) spans.push(span(phoneStart, end, 'PHONE', PRIORITY.PHONE));
      } else if (
        lengths.length <= 4 &&
        lengths.every((length) => length >= 2) &&
        (consistentSeparators(cluster, from, to) ||
          MIXED_SEPARATOR_PHONE_SHAPES.has(lengths.join('-'))) &&
        (MOBILE.test(digits) ||
          BANGKOK.test(digits) ||
          PROVINCIAL.test(digits) ||
          INTERNATIONAL_00.test(digits))
      ) {
        spans.push(span(phoneStart, end, 'PHONE', PRIORITY.PHONE));
      } else if (
        total >= PHONE_MIN_DIGITS &&
        total <= PHONE_MAX_DIGITS &&
        lengths.length <= 5 &&
        // Spaced or dashed: groups of two digits or more with one of three or more, so "12 34 56 78 90"
        // (a list of small numbers) is not a phone but "415 555 2671" and "66 81 234 5678" are.
        (lengths.length === 1 ||
          (lengths.slice(lengths[0] === 1 ? 1 : 0).every((length) => length >= 2) &&
            Math.max(...lengths) >= 3)) &&
        consistentSeparators(cluster, from, to) &&
        !insideSafeSpan(safe, start, end)
      ) {
        spans.push(span(phoneStart, end, 'PHONE', PRIORITY.PHONE));
      }

      if (
        total === 10 &&
        isBankFormattedShape(lengths) &&
        consistentSeparators(cluster, from, to)
      ) {
        spans.push(span(start, end, 'BANK', PRIORITY.BANK_FORMATTED));
      }
    }
  }
}

const BANK_KEYWORD =
  /(?:เลขที่บัญชี|เลขบัญชี|บัญชี|(?<![a-z])(?:account|acct|acc)(?![a-z])(?:\s{0,2}(?:no|number|num|#))?|a\/c)\.?/giu;
const MAX_KEYWORD_GAP = 25;

function detectBankAfterKeyword(text: string, clusters: readonly Cluster[], spans: Span[]): void {
  if (clusters.length === 0) return;
  for (const keyword of text.matchAll(BANK_KEYWORD)) {
    let position = keyword.index + keyword[0].length;
    const limit = Math.min(text.length, position + MAX_KEYWORD_GAP);
    while (
      position < limit &&
      !isDigitCode(text.charCodeAt(position)) &&
      text.charAt(position) !== '\n'
    ) {
      position += 1;
    }
    if (position >= text.length || !isDigitCode(text.charCodeAt(position))) continue;

    // Clusters are sorted by position; find the one that starts here.
    let low = 0;
    let high = clusters.length - 1;
    let cluster: Cluster | undefined;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const candidate = clusters[middle];
      const candidateStart = candidate?.groups[0]?.start ?? 0;
      if (candidateStart === position && candidate !== undefined) {
        cluster = candidate;
        break;
      }
      if (candidateStart < position) low = middle + 1;
      else high = middle - 1;
    }
    if (cluster === undefined) continue;

    let total = 0;
    let lastIndex = -1;
    for (let index = 0; index < cluster.groups.length; index += 1) {
      const group = cluster.groups[index];
      if (group === undefined) break;
      total += group.end - group.start;
      if (total > 15 || !consistentSeparators(cluster, 0, index)) break;
      if (total >= 9) lastIndex = index;
    }
    const firstGroup = cluster.groups[0];
    const lastGroup = lastIndex >= 0 ? cluster.groups[lastIndex] : undefined;
    if (firstGroup !== undefined && lastGroup !== undefined) {
      spans.push(span(firstGroup.start, lastGroup.end, 'BANK', PRIORITY.BANK_CONTEXT));
    }
  }
}

/** Thai ID, card, phone and bank account numbers. One pass over the text, no backtracking. */
export function detectNumbers(text: string): Span[] {
  const spans: Span[] = [];
  const clusters = findClusters(text);
  const safe = safeSpans(text);
  for (const cluster of clusters) detectInCluster(text, cluster, spans, safe);
  detectBankAfterKeyword(text, clusters, spans);
  return spans;
}

// ---------------------------------------------------------------------------------------------
// Names from the dictionary
// ---------------------------------------------------------------------------------------------

export interface NameMatcherOptions {
  names: Iterable<string>;
  /** Names shorter than this (in code points) are ignored. */
  minLength: number;
  /** Also match each whitespace-separated part of a name ("Somchai", "Jaidee"). */
  matchParts: boolean;
}

export class DictionaryTooLargeError extends Error {
  override readonly name = 'DictionaryTooLargeError';
}

/** Upper bound on distinct entries. Pass a scoped dictionary (org contacts, ticket participants). */
export const MAX_DICTIONARY_ENTRIES = 50_000;
/**
 * Display names come from the people who write to us, so each one is bounded (SR106-N2): longer
 * names keep their first `MAX_NAME_CHARS` characters, and only the first `MAX_NAME_PARTS` words of
 * a name are matched on their own. Together with `MAX_DICTIONARY_CHARS` this caps the trie, and
 * with it the memory the dictionary can cost, whatever names are passed in.
 */
export const MAX_NAME_CHARS = 128;
export const MAX_NAME_PARTS = 8;
/** Total characters over all distinct patterns. */
export const MAX_DICTIONARY_CHARS = 1_500_000;
/** Ceiling on dictionary matches one input may produce before the scan gives up. */
export const MAX_NAME_MATCHES = 2_000_000;

/**
 * The input holds so many dictionary hits that scanning it is not worth finishing. Fail closed:
 * the redactor throws this rather than return text it did not fully check, and the caller must
 * not send the input to a model.
 */
export class NameMatchLimitError extends Error {
  override readonly name = 'NameMatchLimitError';
}

// Longer than any name is allowed to be, so slicing never drops a part that would be matched.
const MAX_RAW_NAME_UNITS = MAX_NAME_CHARS * MAX_NAME_PARTS;

/**
 * Builds a detector for names the system already knows. Matching is on the case-folded,
 * normalised view, so "JOSE" and an NFD "José" both match "José". Latin names must sit on
 * word boundaries; Thai names match as substrings because Thai has no spaces between words, so a
 * short Thai name can over-redact inside a longer word (the safe direction). Where names overlap
 * the leftmost, longest one wins ("Ann Leeson" over "Ann Lee").
 */
export function createNameDetector(options: NameMatcherOptions): (view: NormalizedView) => Span[] {
  const candidates = new Set<string>();
  let totalChars = 0;
  const add = (value: string): void => {
    let folded = foldForMatching(value.trim().replace(/\s+/g, ' '));
    if (folded.length > MAX_NAME_CHARS) {
      const points = Array.from(folded);
      if (points.length > MAX_NAME_CHARS) folded = points.slice(0, MAX_NAME_CHARS).join('');
    }
    if (Array.from(folded).length < options.minLength || candidates.has(folded)) return;
    candidates.add(folded);
    totalChars += folded.length;
    if (totalChars > MAX_DICTIONARY_CHARS) {
      throw new DictionaryTooLargeError(
        `Name dictionary exceeds ${String(MAX_DICTIONARY_CHARS)} characters; pass a scoped dictionary`,
      );
    }
  };
  for (const raw of options.names) {
    const bounded = raw.length > MAX_RAW_NAME_UNITS ? raw.slice(0, MAX_RAW_NAME_UNITS) : raw;
    add(bounded);
    if (options.matchParts) {
      let parts = 0;
      for (const part of bounded.matchAll(/\S+/g)) {
        if (parts >= MAX_NAME_PARTS) break;
        parts += 1;
        add(part[0]);
      }
    }
    if (candidates.size > MAX_DICTIONARY_ENTRIES) {
      throw new DictionaryTooLargeError(
        `Name dictionary exceeds ${String(MAX_DICTIONARY_ENTRIES)} entries; pass a scoped dictionary`,
      );
    }
  }
  if (candidates.size === 0) return () => [];

  const patterns = [...candidates];
  const matcher = buildMatcher(patterns);

  return (view) => {
    const text = view.folded;
    // A Latin name must not start or end inside a word ("Ann" in "Joanne"); this is the same
    // test as before, on the text instead of the pattern, because they agree at a match.
    const accept = (start: number, end: number): boolean =>
      !(ASCII_ALNUM.test(text.charAt(start)) && ASCII_ALNUM.test(text.charAt(start - 1))) &&
      !(ASCII_ALNUM.test(text.charAt(end - 1)) && ASCII_ALNUM.test(text.charAt(end)));
    try {
      return matcher
        .scan(text, { accept, maxMatches: MAX_NAME_MATCHES })
        .map((match) => span(match.start, match.end, 'NAME', PRIORITY.NAME));
    } catch (error) {
      if (error instanceof MatchLimitError) throw new NameMatchLimitError(error.message);
      throw error;
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Names introduced by a cue (QA-30): "my name is Somchai Jaidee", "Regards,\nSomchai", "คุณสมชาย"
// ---------------------------------------------------------------------------------------------

/**
 * The dictionary only knows people the system already has. A name written in free text by someone
 * it does not know ("my name is Somchai Jaidee") would reach the model raw, so a name that follows
 * a cue is redacted too. There is no NER (ADR-008): a name with no cue and not in the dictionary
 * is still not found. This detector over-redacts on purpose (N4 prefers a false positive).
 *
 * Work is bounded (SR106-N2): the cues are found by one regular expression made of literals with
 * bounded repeats (linear, no nested quantifier); each cue reads at most `MAX_CUE_TOKENS` tokens of
 * at most `MAX_LATIN_TOKEN` / `MAX_THAI_TOKEN` characters across short separator runs, by index
 * arithmetic; and a text with more than `MAX_CUE_MATCHES` cues is refused (`NameMatchLimitError`,
 * fail closed) like a text with too many dictionary hits.
 */
export const MAX_CUE_TOKENS = 3;
export const MAX_LATIN_TOKEN = 30;
/** The first Thai token is a run with no spaces (given name and family name can be glued together). */
export const MAX_THAI_TOKEN = 24;
/** Later, space-separated Thai tokens are held to the length of a single name. */
const MAX_THAI_LATER_TOKEN = 15;
const MAX_CUE_GAP = 3;
/** A sign-off may be followed by a blank line ("

"). */
const MAX_SIGNOFF_GAP = 6;
export const MAX_CUE_MATCHES = 50_000;

// Cues are matched on `view.folded` (lower case). One capture group per kind of cue:
// 1 honorific, 2 "my name is" / "this is" / "dear", 3 sign-off (needs its comma), 4 Thai label, 5 Thai honorific.
const CUE_PATTERN = new RegExp(
  [
    String.raw`(?<![\p{L}\p{N}])(mr|mrs|ms)\.?(?=[ \t])`,
    String.raw`(?<![\p{L}\p{N}])(my[ \t]{1,2}name(?:[ \t]{1,2}is|['’]s)|this[ \t]{1,2}is|dear)(?=[ \t])`,
    String.raw`(?<![\p{L}\p{N}])((?:(?:best|kind|warm)[ \t]{1,2})?regards|thanks|thank[ \t]{1,2}you|(?:yours[ \t]{1,2})?sincerely)[ \t]{0,2},`,
    String.raw`(ชื่อ)`,
    String.raw`(นางสาว|นาง|นาย|คุณ)`,
  ].join('|'),
  'gu',
);

const THAI_LETTER = /[ก-ฺเ-๎]/u;
const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;
const NAME_LETTER = /[\p{L}\p{M}]/u;

/** Capitalised words that follow a cue without being a name ("Dear Team", "This is Important"). */
const NOT_A_NAME = new Set(
  (
    'the a an team support all sir sirs madam everyone everybody customer customers service services ' +
    'desk helpdesk admin admins sales ops tech technical billing urgent important not my our your we ' +
    'you it i in on at to for from of and or but if so just still also now please hello hi thanks ' +
    'thank regards best kind sincerely mr mrs ms dr miss there here what how why when who ticket ' +
    'issue problem error bug email mail account system application app api server colleagues ' +
    'client clients user users'
  ).split(' '),
);

/**
 * Thai words that begin with a Thai cue and are not a person ("คุณภาพ" = quality). Thai has no
 * spaces, so "คุณ" glued to more Thai letters is ambiguous: it is a name ("คุณสมชาย") unless the
 * letters form one of these words. The list is short and cannot be complete: a word that is not
 * on it is redacted as if it were a name (over-redaction, the safe direction).
 */
const THAI_NOT_A_NAME_AFTER_CUE: Readonly<Record<string, readonly string[]>> = {
  คุณ: ['ภาพ', 'สมบัติ', 'ลักษณะ', 'ลักษณ์', 'ค่า', 'ประโยชน์', 'ธรรม', 'วุฒิ'],
  นาย: ['หน้า', 'จ้าง', 'ทะเบียน', 'กรัฐมนตรี', 'กเทศมนตรี', 'ช่าง', 'แบบ', 'อำเภอ', 'ทุน'],
  นาง: ['แบบ', 'ฟ้า', 'พยาบาล', 'รำ', 'เอก', 'งาม'],
  นางสาว: [],
  ชื่อ: [
    'เสียง',
    'เรื่อง',
    'ผู้ใช้',
    'บัญชี',
    'บริษัท',
    'ไฟล์',
    'โดเมน',
    'องค์กร',
    'ระบบ',
    'ลูกค้า',
    'สินค้า',
    'โปรเจกต์',
    'เซิร์ฟเวอร์',
    'แอป',
    'หัวข้อ',
    'ตาราง',
    'คอลัมน์',
  ],
};
/** Thai words that end in a cue and are not it ("ขอบคุณ" = thank you). */
const THAI_NOT_A_CUE_BEFORE: Readonly<Record<string, readonly string[]>> = {
  คุณ: ['ขอบ'],
};

/**
 * Common function words that end a Thai name run ("คุณสมชายแจ้งว่า" = "Khun Somchai said that").
 * Thai has no spaces, so without this the run would swallow the rest of the sentence. Trade-off:
 * a name that itself contains one of these is cut there and the rest of it is left in the text.
 * The list is short on purpose and leaves out strings common inside names ("นะ" in ธนะ, "ว่า" in สว่าง).
 */
const THAI_RUN_STOPS: readonly string[] = [
  'ครับ',
  'ค่ะ',
  'คะ',
  'แจ้ง',
  'ช่วย',
  'โทร',
  'อีเมล',
  'เบอร์',
  'ติดต่อ',
  'และ',
  'กับ',
  'จาก',
  'ได้',
  'ที่',
  'ของ',
  'เป็น',
  'ไม่',
  'แล้ว',
  'ต้องการ',
  'อยาก',
];

/** The part of a Thai run before the first stop word; empty when the run starts with one. */
function cutThaiRun(run: string): string {
  let cut = run.length;
  for (const stop of THAI_RUN_STOPS) {
    const at = run.indexOf(stop);
    if (at !== -1 && at < cut) cut = at;
  }
  return run.slice(0, cut);
}

function isHorizontalSpace(char: string): boolean {
  return char === ' ' || char === '\t';
}

/** One name-like token at `from`: a Thai run, or a capitalised Latin word. */
function readNameToken(
  text: string,
  from: number,
  mode: { allowAllCaps: boolean; maxThai: number },
): { end: number; word: string } | undefined {
  const first = text.charAt(from);
  if (first === '') return undefined;
  if (THAI_LETTER.test(first)) {
    let end = from;
    while (end < text.length && end - from < mode.maxThai && THAI_LETTER.test(text.charAt(end))) {
      end += 1;
    }
    const word = cutThaiRun(text.slice(from, end));
    return word === '' ? undefined : { end: from + word.length, word };
  }
  if (!UPPER.test(first)) return undefined;
  let end = from + 1;
  let lower = 0;
  while (end < text.length && end - from < MAX_LATIN_TOKEN) {
    const char = text.charAt(end);
    if (NAME_LETTER.test(char)) {
      if (LOWER.test(char)) lower += 1;
    } else if (
      (char === "'" || char === '’' || char === '-') &&
      NAME_LETTER.test(text.charAt(end + 1))
    ) {
      // O'Brien, Anne-Marie: the joiner stays inside the token.
    } else break;
    end += 1;
  }
  if (end - from < 2) return undefined;
  if (lower === 0 && !mode.allowAllCaps) return undefined;
  return { end, word: text.slice(from, end) };
}

/**
 * Reads up to `MAX_CUE_TOKENS` name tokens after a cue, one span per token (so a token shares its
 * placeholder with the same word found by the dictionary).
 */
function readNameAfterCue(
  text: string,
  from: number,
  options: { newlineOk: boolean; allowAllCaps: boolean; attachedOk: boolean },
  spans: Span[],
): void {
  let position = from;
  // Separator between the cue and the name: spaces, a colon, and for a sign-off a line break.
  let gap = 0;
  const maxGap = options.newlineOk ? MAX_SIGNOFF_GAP : MAX_CUE_GAP;
  while (position < text.length && gap < maxGap) {
    const char = text.charAt(position);
    const skippable =
      isHorizontalSpace(char) ||
      char === ':' ||
      char === '：' ||
      (options.newlineOk && (char === '\n' || char === '\r'));
    if (!skippable) break;
    position += 1;
    gap += 1;
  }
  if (gap === 0 && !options.attachedOk) return;
  for (let taken = 0; taken < MAX_CUE_TOKENS; taken += 1) {
    const token = readNameToken(text, position, {
      allowAllCaps: options.allowAllCaps,
      maxThai: taken === 0 ? MAX_THAI_TOKEN : MAX_THAI_LATER_TOKEN,
    });
    if (token === undefined || NOT_A_NAME.has(token.word.toLowerCase())) break;
    spans.push(span(position, token.end, 'NAME', PRIORITY.NAME));
    // The next token must follow after one or two spaces on the same line.
    let next = token.end;
    while (next < text.length && next - token.end < 2 && isHorizontalSpace(text.charAt(next))) {
      next += 1;
    }
    if (next === token.end) break;
    position = next;
  }
}

/**
 * Names after a cue: English ("my name is", "this is", Mr/Mrs/Ms, "Dear", a name after
 * "Regards," and the like) and Thai (ชื่อ, คุณ, นาย, นาง, นางสาว, ผมชื่อ, ดิฉันชื่อ).
 *
 * Accepted false positives (over-redaction): "This is Important" (a capitalised word after
 * "this is" that is not on the short stop list), a Thai word that opens with a Thai honorific and
 * is not on the deny list. Accepted false negatives: a name no cue introduces ("Hi Somchai",
 * "I am Somchai") and a name after the third token.
 */
export function detectNameCues(view: NormalizedView): Span[] {
  const spans: Span[] = [];
  const { text, folded } = view;
  let matches = 0;
  for (const match of folded.matchAll(CUE_PATTERN)) {
    matches += 1;
    if (matches > MAX_CUE_MATCHES) {
      throw new NameMatchLimitError(`More than ${String(MAX_CUE_MATCHES)} name cues in one text`);
    }
    const start = match.index;
    const end = start + match[0].length;
    if (match[1] !== undefined) {
      // Mr / Mrs / Ms written with a capital, and not the unit in "200 ms Latency".
      if (!UPPER.test(text.charAt(start))) continue;
      let back = start - 1;
      while (back >= 0 && isHorizontalSpace(text.charAt(back))) back -= 1;
      if (back >= 0 && /[0-9]/.test(text.charAt(back))) continue;
      readNameAfterCue(
        text,
        end,
        { newlineOk: false, allowAllCaps: true, attachedOk: false },
        spans,
      );
    } else if (match[2] !== undefined) {
      // "This is IMPORTANT" is not a name; "MY NAME IS SOMCHAI" is.
      const allowAllCaps = !folded.startsWith('this', start);
      readNameAfterCue(text, end, { newlineOk: false, allowAllCaps, attachedOk: false }, spans);
    } else if (match[3] !== undefined) {
      readNameAfterCue(
        text,
        end,
        { newlineOk: true, allowAllCaps: true, attachedOk: false },
        spans,
      );
    } else {
      const cue = match[4] ?? match[5] ?? '';
      const after = text.slice(end, end + 12);
      if ((THAI_NOT_A_NAME_AFTER_CUE[cue] ?? []).some((word) => after.startsWith(word))) continue;
      if ((THAI_NOT_A_CUE_BEFORE[cue] ?? []).some((word) => text.endsWith(word, start))) continue;
      let from = end;
      // "ชื่อ คือ สมชาย" (the name is ...)
      if (cue === 'ชื่อ') {
        let probe = from;
        while (probe < text.length && probe - from < 2 && isHorizontalSpace(text.charAt(probe))) {
          probe += 1;
        }
        if (text.startsWith('คือ', probe)) from = probe + 'คือ'.length;
      }
      readNameAfterCue(
        text,
        from,
        { newlineOk: false, allowAllCaps: true, attachedOk: true },
        spans,
      );
    }
  }
  return spans;
}

/**
 * Keeps non-overlapping spans. Higher priority wins, then the longer span, then the earlier one.
 * Linear in the covered text: a marker array replaces the pairwise overlap test.
 */
export function resolveOverlaps(spans: readonly Span[], length: number): Span[] {
  const ordered = [...spans].sort(
    (a, b) => b.priority - a.priority || b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  const taken = new Uint8Array(length + 1);
  const accepted: Span[] = [];
  for (const candidate of ordered) {
    let free = true;
    for (let index = candidate.start; index < candidate.end; index += 1) {
      if (taken[index] === 1) {
        free = false;
        break;
      }
    }
    if (!free) continue;
    taken.fill(1, candidate.start, candidate.end);
    accepted.push(candidate);
  }
  return accepted.sort((a, b) => a.start - b.start);
}
