/**
 * Detectors run on the normalised view (`normalize.ts`), so every offset here is an offset into
 * `view.text`; the redactor maps spans back to the original string.
 *
 * Performance rule (R-3): nothing here may backtrack over unbounded input. Numbers are found by a
 * single left-to-right scan that groups digit runs into clusters and tests bounded windows of
 * groups; emails are found by walking out from each `@` with hard length caps; names use
 * Aho-Corasick; the few regular expressions left are anchored literals or have bounded repeats.
 */
import { buildMatcher } from './aho-corasick.js';
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
// IDN labels may use any script except Thai, so "example.comครับ" stops at the Thai letters.
const DOMAIN_LABEL_CHAR = /[\p{L}\p{M}\p{N}-]/u;
const THAI = /\p{Script=Thai}/u;

function isDomainChar(char: string): boolean {
  return DOMAIN_LABEL_CHAR.test(char) && !THAI.test(char);
}

export function detectEmails(text: string): Span[] {
  const spans: Span[] = [];
  let at = text.indexOf('@');
  let lastEnd = 0;
  while (at !== -1) {
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
    let end = at + 1;
    let labels = 0;
    let cursor = at + 1;
    while (cursor - at <= MAX_DOMAIN) {
      const labelStart = cursor;
      while (cursor < text.length && isDomainChar(text.charAt(cursor))) cursor += 1;
      if (cursor === labelStart) break;
      labels += 1;
      end = cursor;
      if (text.charAt(cursor) === '.' && cursor + 1 < text.length) cursor += 1;
      else break;
    }
    if (start < at && labels >= 2) {
      spans.push(span(start, end, 'EMAIL', PRIORITY.EMAIL));
      lastEnd = end;
    }
    at = text.indexOf('@', at + 1);
  }
  return spans;
}

// ---------------------------------------------------------------------------------------------
// Numbers: digit clusters
// ---------------------------------------------------------------------------------------------

const SEPARATORS = new Set([' ', '\t', '.', '-', '‐', '‑', '‒', '–', '—', '―', '−', '/', '(', ')']);
const MAX_SEPARATOR_RUN = 3;
const MAX_WINDOW_GROUPS = 8;
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
  const rest = separator.replace(/[ \t()]/g, '');
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
const THAI_ID_BOUNDARIES = new Set([1, 5, 10, 12]);

function isThaiIdShape(lengths: readonly number[]): boolean {
  let position = 0;
  for (let index = 0; index < lengths.length - 1; index += 1) {
    position += lengths[index] ?? 0;
    if (!THAI_ID_BOUNDARIES.has(position)) return false;
  }
  return true;
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

function detectInCluster(text: string, cluster: Cluster, spans: Span[]): void {
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
        consistentSeparators(cluster, from, to) &&
        (MOBILE.test(digits) ||
          BANGKOK.test(digits) ||
          PROVINCIAL.test(digits) ||
          INTERNATIONAL_00.test(digits))
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
  for (const cluster of clusters) detectInCluster(text, cluster, spans);
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
 * Builds a detector for names the system already knows. Matching is on the case-folded,
 * normalised view, so "JOSE" and an NFD "José" both match "José". Latin names must sit on
 * word boundaries; Thai names match as substrings because Thai has no spaces between words, so a
 * short Thai name can over-redact inside a longer word (the safe direction).
 */
export function createNameDetector(options: NameMatcherOptions): (view: NormalizedView) => Span[] {
  const candidates = new Set<string>();
  const add = (value: string): void => {
    const folded = foldForMatching(value.trim().replace(/\s+/g, ' '));
    if (Array.from(folded).length >= options.minLength) candidates.add(folded);
  };
  for (const raw of options.names) {
    add(raw);
    if (options.matchParts) {
      for (const part of raw.split(/\s+/)) add(part);
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
    const spans: Span[] = [];
    for (const match of matcher.scan(view.folded)) {
      const pattern = patterns[match.pattern] ?? '';
      const first = pattern.charAt(0);
      const last = pattern.charAt(pattern.length - 1);
      if (ASCII_ALNUM.test(first) && ASCII_ALNUM.test(view.folded.charAt(match.start - 1)))
        continue;
      if (ASCII_ALNUM.test(last) && ASCII_ALNUM.test(view.folded.charAt(match.end))) continue;
      spans.push(span(match.start, match.end, 'NAME', PRIORITY.NAME));
    }
    return spans;
  };
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
