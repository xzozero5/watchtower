/**
 * The normalised view the detectors scan (R-5). Detection runs on a canonical copy of the text so
 * that look-alike characters cannot hide PII, while replacement runs on the original string using
 * the index map, so `restore(redact(x)) === x` still holds byte for byte.
 *
 * The view applies, per grapheme-ish cluster (a base character plus its combining marks):
 *  - NFKC: full-width forms (＋ ＠ ０-９), NBSP and other spaces, compatibility digits and letters,
 *    and NFD sequences compose (so "José" matches "José");
 *  - drop `\p{Cf}` (zero-width space/joiners, soft hyphen, bidi marks), which can be used to split a
 *    number or an address without changing how it looks;
 *  - drop invisible characters that are not `\p{Cf}` but render as nothing and can be used to split
 *    a number or an address just the same (SR106-N5): the combining grapheme joiner U+034F,
 *    variation selectors U+FE00-FE0F and U+E0100-E01EF, Mongolian free variation selectors, the
 *    Hangul fillers U+115F U+1160 U+3164 U+FFA0, the Khmer inherent vowels U+17B4 U+17B5, and the
 *    Braille blank U+2800;
 *  - drop combining marks that follow a digit (a digit with a mark is not a digit anyone writes);
 *  - read the ideographic full stop U+3002 and U+FF61 as '.', the way IDNA does for domains;
 *  - map every `\p{Nd}` (Thai, Arabic-Indic, Devanagari, mathematical, ...) to ASCII 0-9.
 *
 * Not handled, by design (documented in ADR-008): homoglyphs from other scripts (Cyrillic 'а' for
 * Latin 'a', which NFKC does not fold) and digits spelled as words.
 */
export interface NormalizedView {
  /** Canonical text the detectors scan. */
  text: string;
  /** Same as `text` with case folded one unit at a time, so offsets are identical. */
  folded: string;
  /** For each unit of `text`, where its source starts in the original string. */
  starts: Int32Array;
  /** For each unit of `text`, where its source ends (exclusive) in the original string. */
  ends: Int32Array;
}

const MARK = /^\p{M}$/u;
const DECIMAL_DIGIT = /^\p{Nd}$/u;
const FORMAT = /^\p{Cf}$/u;
// Inclusive code point ranges of characters that render as nothing but are not \p{Cf}.
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x034f, 0x034f], // combining grapheme joiner
  [0x115f, 0x1160], // Hangul choseong / jungseong filler
  [0x17b4, 0x17b5], // Khmer inherent vowels
  [0x180b, 0x180d], // Mongolian free variation selectors
  [0x180f, 0x180f],
  [0x2800, 0x2800], // Braille blank
  [0x3164, 0x3164], // Hangul filler
  [0xfe00, 0xfe0f], // variation selectors
  [0xffa0, 0xffa0], // halfwidth Hangul filler
  [0xe0100, 0xe01ef], // variation selectors supplement
];

function isInvisible(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return INVISIBLE_RANGES.some(([from, to]) => code >= from && code <= to);
}
const digitCache = new Map<number, string>();

/** ASCII digit for a Unicode decimal digit. Nd characters come in aligned runs of ten. */
function asciiDigit(char: string): string {
  const cp = char.codePointAt(0) ?? 0;
  const cached = digitCache.get(cp);
  if (cached !== undefined) return cached;
  let base = cp;
  while (base > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(base - 1))) base -= 1;
  const value = String((cp - base) % 10);
  digitCache.set(cp, value);
  return value;
}

/** Growable output buffers; typed arrays keep a 1 MB input to a few allocations. */
class ViewBuilder {
  private units: Uint16Array;
  private lower: Uint16Array;
  private from: Int32Array;
  private to: Int32Array;
  size = 0;

  constructor(capacity: number) {
    const initial = Math.max(16, capacity + 16);
    this.units = new Uint16Array(initial);
    this.lower = new Uint16Array(initial);
    this.from = new Int32Array(initial);
    this.to = new Int32Array(initial);
  }

  private grow(): void {
    const capacity = this.units.length * 2;
    const copy = <T extends Uint16Array | Int32Array>(source: T, make: (n: number) => T): T => {
      const next = make(capacity);
      next.set(source);
      return next;
    };
    this.units = copy(this.units, (n) => new Uint16Array(n));
    this.lower = copy(this.lower, (n) => new Uint16Array(n));
    this.from = copy(this.from, (n) => new Int32Array(n));
    this.to = copy(this.to, (n) => new Int32Array(n));
  }

  push(code: number, from: number, to: number): void {
    if (this.size === this.units.length) this.grow();
    const index = this.size;
    this.units[index] = code;
    // ASCII upper case folds by arithmetic; everything else goes through toLowerCase when it
    // keeps a single unit.
    let folded = code;
    if (code >= 65 && code <= 90) folded = code + 32;
    else if (code >= 0x80) {
      const lowered = String.fromCharCode(code).toLowerCase();
      if (lowered.length === 1) folded = lowered.charCodeAt(0);
    }
    this.lower[index] = folded;
    this.from[index] = from;
    this.to[index] = to;
    this.size += 1;
  }

  build(): NormalizedView {
    const decode = (array: Uint16Array): string =>
      Buffer.from(array.buffer, array.byteOffset, this.size * 2).toString('utf16le');
    return {
      text: decode(this.units),
      folded: decode(this.lower),
      starts: this.from.slice(0, this.size),
      ends: this.to.slice(0, this.size),
    };
  }
}

export function buildView(original: string): NormalizedView {
  const length = original.length;
  const builder = new ViewBuilder(length);

  const pushNormalized = (cluster: string, from: number, to: number): void => {
    let afterDigit = false;
    for (const char of cluster.normalize('NFKC')) {
      if (FORMAT.test(char) || isInvisible(char)) continue;
      if (afterDigit && MARK.test(char)) continue;
      afterDigit = DECIMAL_DIGIT.test(char);
      const mapped = afterDigit ? asciiDigit(char) : char === '。' || char === '｡' ? '.' : char;
      for (let index = 0; index < mapped.length; index += 1) {
        builder.push(mapped.charCodeAt(index), from, to);
      }
    }
  };

  let index = 0;
  while (index < length) {
    const code = original.charCodeAt(index);
    const low = original.charCodeAt(index + 1);
    const width = code >= 0xd800 && code <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? 2 : 1;
    let end = index + width;
    // A base character keeps the combining marks that follow it, so NFKC can compose them.
    while (end < length && original.charCodeAt(end) >= 0x300) {
      const next = original.codePointAt(end) ?? 0;
      const nextWidth = next > 0xffff ? 2 : 1;
      if (!MARK.test(original.slice(end, end + nextWidth))) break;
      end += nextWidth;
    }
    if (end === index + 1 && code < 0x80) builder.push(code, index, end);
    else if (end === index + 1 && code >= 0x0e50 && code <= 0x0e59) {
      builder.push(48 + code - 0x0e50, index, end); // Thai digits, the common non-ASCII case
    } else if (end === index + 1 && code >= 0xff10 && code <= 0xff19) {
      builder.push(48 + code - 0xff10, index, end); // full-width digits
    } else pushNormalized(original.slice(index, end), index, end);
    index = end;
  }
  return builder.build();
}

/** Canonical, case-folded form used to match dictionary entries against `NormalizedView.folded`. */
export function foldForMatching(value: string): string {
  // eslint-disable-next-line no-control-regex -- ASCII fast path for the dictionary build
  if (/^[\x00-\x7f]*$/.test(value)) return value.toLowerCase();
  return buildView(value).folded;
}
