import { digitsOnly, isLuhnValid, isValidThaiNationalId } from './validators.js';

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

/** A half-open range `[start, end)` in the original text. */
export interface Span {
  start: number;
  end: number;
  kind: RedactionKind;
  /** Higher wins when two spans overlap. */
  priority: number;
}

/** Matches the placeholder tokens the redactor itself writes, e.g. `[EMAIL_1]`. */
export const TOKEN_PATTERN = new RegExp(`\\[(?:${REDACTION_KINDS.join('|')})_\\d+\\]`, 'g');

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

function* matches(pattern: RegExp, text: string): Generator<RegExpExecArray> {
  const regex = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  let match = regex.exec(text);
  while (match !== null) {
    if (match[0].length === 0) {
      regex.lastIndex += 1;
    } else {
      yield match;
    }
    match = regex.exec(text);
  }
}

/** Token-shaped text already in the input. It is escaped so a restore never expands it. */
export function detectLiteralTokens(text: string): Span[] {
  return [...matches(TOKEN_PATTERN, text)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    kind: 'LITERAL',
    priority: PRIORITY.LITERAL,
  }));
}

const EMAIL =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g;

export function detectEmails(scan: string): Span[] {
  return [...matches(EMAIL, scan)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    kind: 'EMAIL',
    priority: PRIORITY.EMAIL,
  }));
}

// 13 digits as 1-2345-67890-12-3, with spaces, or run together. The first digit is 1-8.
const THAI_ID = /(?<![0-9])[1-8](?:[- ]?\d{4})(?:[- ]?\d{5})(?:[- ]?\d{2})(?:[- ]?\d)(?![0-9])/g;

export function detectThaiNationalIds(scan: string): Span[] {
  const spans: Span[] = [];
  for (const match of matches(THAI_ID, scan)) {
    if (!isValidThaiNationalId(match[0])) continue;
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      kind: 'THAI_ID',
      priority: PRIORITY.THAI_ID,
    });
  }
  return spans;
}

const CARD_CANDIDATE = /(?<![0-9])\d+(?:[ -]\d+){0,7}(?![0-9])/g;

/**
 * 13-19 digits that pass Luhn, written as one run or as groups (4-4-4-4, 4-6-5, ...). Windows of
 * several groups must look like a card (every group but the last has 4 or 6 digits), which keeps
 * ordinary lists of numbers from being read as cards.
 */
export function detectCardNumbers(scan: string): Span[] {
  const spans: Span[] = [];
  for (const candidate of matches(CARD_CANDIDATE, scan)) {
    const groups = [...matches(/\d+/g, candidate[0])].map((group) => ({
      start: candidate.index + group.index,
      end: candidate.index + group.index + group[0].length,
      length: group[0].length,
    }));
    let from = 0;
    while (from < groups.length) {
      let found = false;
      for (let to = groups.length - 1; to >= from; to -= 1) {
        const window = groups.slice(from, to + 1);
        const first = window[0];
        const last = window[window.length - 1];
        if (first === undefined || last === undefined) continue;
        const total = window.reduce((sum, group) => sum + group.length, 0);
        if (total < 13 || total > 19) continue;
        if (window.length > 1) {
          const body = window.slice(0, -1);
          if (!body.every((group) => group.length === 4 || group.length === 6)) continue;
          if (last.length < 3 || last.length > 6) continue;
        }
        const text = scan.slice(first.start, last.end);
        if (!isLuhnValid(text)) continue;
        spans.push({
          start: first.start,
          end: last.end,
          kind: 'CARD',
          priority: PRIORITY.CARD,
        });
        from = to + 1;
        found = true;
        break;
      }
      if (!found) from += 1;
    }
  }
  return spans;
}

// Thai mobile 0[689]x, Bangkok landline 02, provincial landline 0[3-7]x, +66 / 0066, and a
// generic international form. The lookbehind is ASCII-only on purpose: Thai text is written
// without spaces, so "โทร0812345678ครับ" must still match.
const PHONE_PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9+])0[689]\d[- ]?\d{3}[- ]?\d{4}(?![0-9])/g,
  /(?<![A-Za-z0-9+])02[- ]?\d{3}[- ]?\d{4}(?![0-9])/g,
  /(?<![A-Za-z0-9+])0[3-57]\d[- ]?\d{3}[- ]?\d{3}(?![0-9])/g,
  /(?<![A-Za-z0-9+])(?:\+|00)66[- .]?(?:\(0\)[- .]?)?[2-9]\d?(?:[- .]?\d){7}(?![0-9])/g,
  /(?<![A-Za-z0-9+])\+[1-9]\d{0,2}[- .]?(?:\(0\)[- .]?)?\d(?:[- .]?\d){6,11}(?![0-9])/g,
];

export function detectPhoneNumbers(scan: string): Span[] {
  const spans: Span[] = [];
  for (const pattern of PHONE_PATTERNS) {
    for (const match of matches(pattern, scan)) {
      const digits = digitsOnly(match[0]).length;
      if (digits < 9 || digits > 15) continue;
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        kind: 'PHONE',
        priority: PRIORITY.PHONE,
      });
    }
  }
  return spans;
}

// Thai bank account numbers are 10-12 digits, usually written 123-4-56789-0 or 123-456789-0
// [ASSUMED: no official source checked]. Run-together digits count only after a keyword.
const BANK_FORMATTED = [
  /(?<![0-9-])\d{3}-\d-\d{5}-\d(?![0-9-])/g,
  /(?<![0-9-])\d{3}-\d{6}-\d(?![0-9-])/g,
];
const BANK_CONTEXT =
  /(?:เลขที่บัญชี|เลขบัญชี|บัญชี|account(?:\s*(?:no|number|num|#))?|acct|a\/c)\.?[^\d\n]{0,25}?(?<![0-9])(\d(?:[- ]?\d){8,14})(?![0-9])/giu;

export function detectBankAccounts(scan: string): Span[] {
  const spans: Span[] = [];
  for (const pattern of BANK_FORMATTED) {
    for (const match of matches(pattern, scan)) {
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        kind: 'BANK',
        priority: PRIORITY.BANK_FORMATTED,
      });
    }
  }
  for (const match of matches(BANK_CONTEXT, scan)) {
    const digits = match[1];
    if (digits === undefined) continue;
    const start = match.index + match[0].length - digits.length;
    spans.push({
      start,
      end: start + digits.length,
      kind: 'BANK',
      priority: PRIORITY.BANK_CONTEXT,
    });
  }
  return spans;
}

export interface NameMatcherOptions {
  names: Iterable<string>;
  /** Names shorter than this (in code points) are ignored. */
  minLength: number;
  /** Also match each whitespace-separated part of a name ("Somchai", "Jaidee"). */
  matchParts: boolean;
}

const ASCII_ALNUM = /[A-Za-z0-9]/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Builds a detector for names from a dictionary (contacts the system already knows). Latin names
 * match on word boundaries; Thai names match as substrings because Thai has no spaces between
 * words, so a short Thai name can over-redact inside a longer word (the safe direction).
 */
export function createNameDetector(options: NameMatcherOptions): (text: string) => Span[] {
  const candidates = new Set<string>();
  for (const raw of options.names) {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (Array.from(name).length >= options.minLength) candidates.add(name);
    if (options.matchParts) {
      for (const part of name.split(' ')) {
        if (Array.from(part).length >= options.minLength) candidates.add(part);
      }
    }
  }
  if (candidates.size === 0) return () => [];

  const alternatives = [...candidates]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .map((name) => {
      const chars = Array.from(name);
      const first = chars[0] ?? '';
      const last = chars[chars.length - 1] ?? '';
      const before = ASCII_ALNUM.test(first) ? '(?<![A-Za-z0-9])' : '';
      const after = ASCII_ALNUM.test(last) ? '(?![A-Za-z0-9])' : '';
      return `${before}${escapeRegExp(name)}${after}`;
    });
  const pattern = new RegExp(alternatives.join('|'), 'giu');

  return (text) =>
    [...matches(pattern, text)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      kind: 'NAME',
      priority: PRIORITY.NAME,
    }));
}

/**
 * Keeps non-overlapping spans. Higher priority wins, then the longer span, then the earlier one.
 * The result is sorted by start.
 */
export function resolveOverlaps(spans: readonly Span[]): Span[] {
  const ordered = [...spans].sort(
    (a, b) => b.priority - a.priority || b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  const accepted: Span[] = [];
  for (const span of ordered) {
    if (accepted.some((other) => span.start < other.end && other.start < span.end)) continue;
    accepted.push(span);
  }
  return accepted.sort((a, b) => a.start - b.start);
}
