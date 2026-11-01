import { KB_CHUNK_DEFAULTS } from '@watchtower/shared';

/**
 * Markdown-aware, Thai-safe chunking of an article body (T-107b, PRD R-4.2: citations down to
 * section level).
 *
 * - A chunk never crosses a heading, so every chunk has one `section` (the heading path, for
 *   example `Reset > Steps`). The heading line itself opens the first chunk of its section.
 * - Fenced code blocks are one block: a `#` inside a fence is not a heading, and a fence is only
 *   split when it alone is longer than `maxChars`.
 * - Paragraphs, lists and tables are packed together up to `targetChars`. A block longer than
 *   `maxChars` is cut at sentence and word boundaries from `Intl.Segmenter` (ICU's dictionary
 *   knows where Thai words end although Thai is written without spaces) and, for a run with no
 *   boundary at all (a long URL), at grapheme boundaries. A cut is never inside a grapheme
 *   cluster, so a Thai consonant keeps its vowel and tone marks and an emoji keeps its joiners.
 * - Every chunk is an exact slice of the body: `body.slice(charStart, charEnd) === text`. A
 *   citation can therefore highlight the passage. Offsets are UTF-16 code units, like `String`.
 * - When a long block is split, each piece repeats up to `overlapChars` of the previous one.
 *
 * Sizes are in characters, not tokens `[ASSUMED]`: a token count needs the tokenizer of a model
 * that may change, and Thai has no cheap stand-in. Setext headings (`Title` over `=====`) are not
 * recognised; only ATX (`# Title`).
 */

export interface ChunkOptions {
  readonly targetChars: number;
  readonly maxChars: number;
  readonly minChars: number;
  readonly overlapChars: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = KB_CHUNK_DEFAULTS;

export interface Chunk {
  readonly ordinal: number;
  /** Heading path, `''` before the first heading. */
  readonly section: string;
  readonly text: string;
  readonly charStart: number;
  readonly charEnd: number;
}

export class ChunkOptionsError extends Error {
  override readonly name = 'ChunkOptionsError';
}

export function assertChunkOptions(options: ChunkOptions): void {
  const { targetChars, maxChars, minChars, overlapChars } = options;
  const whole = [targetChars, maxChars, minChars, overlapChars].every(Number.isInteger);
  if (
    !whole ||
    minChars < 0 ||
    overlapChars < 0 ||
    targetChars < 50 ||
    maxChars < targetChars ||
    minChars > targetChars ||
    overlapChars >= targetChars / 2
  ) {
    throw new ChunkOptionsError(
      'Chunk sizes must be whole numbers with 50 <= target <= max, min <= target and overlap < target / 2',
    );
  }
}

interface Span {
  start: number;
  end: number;
}

interface Section {
  path: string;
  /** Where the section starts: its heading line, or 0 for the text before the first heading. */
  start: number;
  end: number;
  blocks: Span[];
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** Splits the body into sections of blocks, with offsets into `body`. */
function parseSections(body: string): Section[] {
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let current: Section = { path: '', start: 0, end: 0, blocks: [] };
  let blockStart = -1;
  let fence: { marker: string; length: number } | null = null;

  const closeBlock = (end: number): void => {
    if (blockStart >= 0) current.blocks.push({ start: blockStart, end });
    blockStart = -1;
  };
  const closeSection = (end: number): void => {
    closeBlock(end);
    current.end = end;
    sections.push(current);
  };

  let offset = 0;
  while (offset <= body.length) {
    const newline = body.indexOf('\n', offset);
    const lineEnd = newline === -1 ? body.length : newline;
    const line = body.slice(offset, lineEnd).replace(/\r$/, '');
    const next = newline === -1 ? body.length + 1 : newline + 1;

    if (fence !== null) {
      const closing = FENCE.exec(line);
      const text = line.trim();
      if (
        closing?.[1] !== undefined &&
        closing[1][0] === fence.marker &&
        closing[1].length >= fence.length &&
        text === closing[1]
      ) {
        fence = null;
        closeBlock(lineEnd);
      }
    } else {
      const opening = FENCE.exec(line);
      const heading = HEADING.exec(line);
      if (opening?.[1] !== undefined) {
        closeBlock(offset);
        blockStart = offset;
        fence = { marker: opening[1][0] ?? '`', length: opening[1].length };
      } else if (heading?.[1] !== undefined) {
        closeSection(offset);
        const level = heading[1].length;
        while ((stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
        stack.push({ level, title: (heading[2] ?? '').trim() });
        current = {
          path: stack
            .map((entry) => entry.title)
            .filter(Boolean)
            .join(' > '),
          start: offset,
          end: offset,
          blocks: [],
        };
        blockStart = offset;
      } else if (line.trim() === '') {
        // The heading line is the first block; it joins the paragraph that follows it.
        if (
          blockStart >= 0 &&
          !(
            current.blocks.length === 0 &&
            blockStart === current.start &&
            isHeadingStart(body, blockStart)
          )
        ) {
          closeBlock(offset);
        }
      } else if (blockStart < 0) {
        blockStart = offset;
      }
    }
    if (newline === -1) break;
    offset = next;
  }
  closeSection(body.length);
  return sections;
}

function isHeadingStart(body: string, position: number): boolean {
  const newline = body.indexOf('\n', position);
  return HEADING.test(
    body.slice(position, newline === -1 ? body.length : newline).replace(/\r$/, ''),
  );
}

/** Trims whitespace off both ends of a span; null when nothing is left. */
function trimSpan(body: string, span: Span): Span | null {
  let { start, end } = span;
  while (start < end && /\s/u.test(body[start] ?? '')) start += 1;
  while (end > start && /\s/u.test(body[end - 1] ?? '')) end -= 1;
  return end > start ? { start, end } : null;
}

let wordSegmenter: Intl.Segmenter | undefined;
let graphemeSegmenter: Intl.Segmenter | undefined;

/** Units no longer than `limit`: words (and the gaps between them), long runs cut by grapheme. */
function unitsOf(text: string, base: number, limit: number): Span[] {
  wordSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const units: Span[] = [];
  for (const word of wordSegmenter.segment(text)) {
    const start = word.index;
    const end = start + word.segment.length;
    if (end - start <= limit) {
      units.push({ start: base + start, end: base + end });
      continue;
    }
    let pieceStart = start;
    for (const grapheme of graphemeSegmenter.segment(word.segment)) {
      const at = start + grapheme.index;
      if (at - pieceStart >= limit) {
        units.push({ start: base + pieceStart, end: base + at });
        pieceStart = at;
      }
    }
    units.push({ start: base + pieceStart, end: base + end });
  }
  return units;
}

const SENTENCE_END = /[.!?。！？…\n]\s*$|\s$/u;

/** Cuts a block that is longer than `maxChars` into pieces of about `targetChars`. */
function splitLong(body: string, block: Span, options: ChunkOptions): Span[] {
  const units = unitsOf(body.slice(block.start, block.end), block.start, options.targetChars);
  const pieces: Span[] = [];
  let first = 0;
  while (first < units.length) {
    const pieceStart = units[first]?.start ?? block.end;
    let last = first;
    while (
      last + 1 < units.length &&
      (units[last + 1]?.end ?? 0) - pieceStart <= options.targetChars
    ) {
      last += 1;
    }
    if (last + 1 < units.length) {
      // Prefer to end at a sentence break, when that keeps most of the piece.
      for (let candidate = last; candidate > first; candidate -= 1) {
        const unit = units[candidate];
        if (unit === undefined || unit.end - pieceStart < options.targetChars * 0.6) break;
        if (SENTENCE_END.test(body.slice(unit.start, unit.end))) {
          last = candidate;
          break;
        }
      }
    }
    const pieceEnd = units[last]?.end ?? block.end;
    pieces.push({ start: pieceStart, end: pieceEnd });
    if (last + 1 >= units.length) break;
    // The next piece repeats the tail of this one, by whole units, and always moves forward.
    let next = last + 1;
    while (
      next - 1 > first &&
      pieceEnd - (units[next - 1]?.start ?? pieceEnd) <= options.overlapChars
    ) {
      next -= 1;
    }
    first = Math.max(next, first + 1);
  }
  return pieces;
}

/**
 * Chunks one article body. `maxChars` is a hard ceiling for every chunk except a single
 * unbreakable grapheme cluster, which cannot be cut (and is never that long in practice).
 */
export function chunkMarkdown(
  body: string,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): Chunk[] {
  assertChunkOptions(options);
  const spans: { section: string; span: Span; merged: boolean }[] = [];

  for (const section of parseSections(body)) {
    let current: Span | null = null;
    const flush = (): void => {
      if (current === null) return;
      const trimmed = trimSpan(body, current);
      if (trimmed !== null) spans.push({ section: section.path, span: trimmed, merged: false });
      current = null;
    };
    for (const block of section.blocks) {
      if (block.end - block.start > options.maxChars) {
        flush();
        for (const piece of splitLong(body, block, options)) {
          const trimmed = trimSpan(body, piece);
          if (trimmed !== null) spans.push({ section: section.path, span: trimmed, merged: true });
        }
        continue;
      }
      if (current === null) {
        current = { ...block };
      } else if (block.end - current.start <= options.targetChars) {
        current.end = block.end;
      } else {
        flush();
        current = { ...block };
      }
    }
    flush();
  }

  // A heading with nothing under it carries no information; keep a chunk only if it has a body.
  const meaningful = spans.filter(({ span }) => !isOnlyHeading(body.slice(span.start, span.end)));

  // A tail shorter than minChars joins the previous chunk of its section when the result still fits.
  const joined: { section: string; span: Span; merged: boolean }[] = [];
  for (const item of meaningful) {
    const previous = joined[joined.length - 1];
    if (
      previous !== undefined &&
      previous.section === item.section &&
      !item.merged &&
      item.span.end - item.span.start < options.minChars &&
      item.span.end - previous.span.start <= options.maxChars
    ) {
      previous.span = { start: previous.span.start, end: item.span.end };
      continue;
    }
    joined.push({ ...item });
  }

  return joined.map(({ section, span }, ordinal) => ({
    ordinal,
    section,
    text: body.slice(span.start, span.end),
    charStart: span.start,
    charEnd: span.end,
  }));
}

function isOnlyHeading(text: string): boolean {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return lines.length === 1 && HEADING.test((lines[0] ?? '').replace(/\r$/, ''));
}
