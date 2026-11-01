import { describe, expect, it } from 'vitest';

import {
  assertChunkOptions,
  ChunkOptionsError,
  chunkMarkdown,
  DEFAULT_CHUNK_OPTIONS,
  type Chunk,
  type ChunkOptions,
} from './chunker.js';

const SMALL: ChunkOptions = { targetChars: 200, maxChars: 300, minChars: 40, overlapChars: 40 };

/** Every chunk is an exact slice of the body, in order, and never empty. */
function expectSlices(body: string, chunks: readonly Chunk[]): void {
  let previousStart = -1;
  chunks.forEach((chunk, index) => {
    expect(chunk.ordinal).toBe(index);
    expect(chunk.text.length).toBeGreaterThan(0);
    expect(chunk.text).toBe(body.slice(chunk.charStart, chunk.charEnd));
    expect(chunk.text).toBe(chunk.text.trim());
    expect(chunk.charStart).toBeGreaterThanOrEqual(previousStart);
    previousStart = chunk.charStart;
  });
}

/** Every cut is on a grapheme boundary of the whole body. */
function expectGraphemeSafe(body: string, chunks: readonly Chunk[]): void {
  const boundaries = new Set<number>([body.length]);
  for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(body)) {
    boundaries.add(part.index);
  }
  for (const chunk of chunks) {
    expect(boundaries.has(chunk.charStart), `start ${String(chunk.charStart)}`).toBe(true);
    expect(boundaries.has(chunk.charEnd), `end ${String(chunk.charEnd)}`).toBe(true);
  }
}

const THAI_SENTENCE =
  'หากผู้ใช้ลืมรหัสผ่านให้เข้าไปที่หน้าเข้าสู่ระบบแล้วเลือกลืมรหัสผ่านระบบจะส่งลิงก์สำหรับตั้งรหัสผ่านใหม่ไปยังอีเมลที่ลงทะเบียนไว้ ';

describe('chunkMarkdown', () => {
  it('returns nothing for an empty or blank body', () => {
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('  \n\n \n')).toEqual([]);
  });

  it('keeps a short article in one chunk with no section', () => {
    const body = 'Reset your password from the sign-in page.\n\nThe link lasts 15 minutes.';
    const chunks = chunkMarkdown(body);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ ordinal: 0, section: '', charStart: 0 });
    expectSlices(body, chunks);
  });

  it('never crosses a heading and names the heading path of each chunk', () => {
    const body = [
      '# Reset',
      '',
      'Intro paragraph about resets that is long enough to stay on its own, as it explains why a reset exists.',
      '',
      '## Steps',
      '',
      'Open the sign-in page and choose "Forgot password" so that the system can send the link by mail.',
      '',
      '## Limits',
      '',
      'A link works once and expires after fifteen minutes, after which a new one must be requested.',
      '',
      '# Billing',
      '',
      'Invoices are sent on the first day of each month to the billing contact of the organization.',
    ].join('\n');
    const chunks = chunkMarkdown(body, SMALL);
    expect(chunks.map((chunk) => chunk.section)).toEqual([
      'Reset',
      'Reset > Steps',
      'Reset > Limits',
      'Billing',
    ]);
    // The heading line opens the first chunk of its section, so keyword search finds it.
    expect(chunks[1]?.text.startsWith('## Steps')).toBe(true);
    expectSlices(body, chunks);
  });

  it('does not treat a # inside a fenced code block as a heading', () => {
    const body = [
      '# Setup',
      '',
      'Run the command below to list the accounts, then read the output carefully before going on.',
      '',
      '```bash',
      '# this is a comment, not a heading',
      'list-accounts --all',
      '```',
      '',
      'Done.',
    ].join('\n');
    const chunks = chunkMarkdown(body, SMALL);
    expect(chunks.every((chunk) => chunk.section === 'Setup')).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join('\n')).toContain('# this is a comment');
    expectSlices(body, chunks);
  });

  it('keeps a fence open across blank lines inside it', () => {
    const body = ['Before.', '', '```', 'a', '', 'b', '```', '', 'After.'].join('\n');
    const chunks = chunkMarkdown(body);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('a\n\nb');
  });

  it('drops a heading that has nothing under it', () => {
    const body =
      '# Guide\n\n## Part one\n\nSome text for part one, which is the only body in this article.\n';
    const chunks = chunkMarkdown(body, SMALL);
    expect(chunks.map((chunk) => chunk.section)).toEqual(['Guide > Part one']);
  });

  it('packs paragraphs up to the target and starts a new chunk after it', () => {
    const paragraph = 'Words go here and there and everywhere. '.repeat(3).trim();
    const body = Array.from({ length: 8 }, () => paragraph).join('\n\n');
    const chunks = chunkMarkdown(body, SMALL);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(SMALL.targetChars);
    expectSlices(body, chunks);
  });

  it('joins a short tail to the previous chunk of the same section when it fits', () => {
    const long = 'A sentence that is fairly long and keeps going. '.repeat(4).trim();
    const body = `${long}\n\nTiny.`;
    const chunks = chunkMarkdown(body, { ...SMALL, targetChars: long.length });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text.endsWith('Tiny.')).toBe(true);
  });

  it('splits an overlong English paragraph at word boundaries, with overlap, within maxChars', () => {
    const body = Array.from({ length: 120 }, (_, index) => `word${String(index)}`).join(' ');
    const chunks = chunkMarkdown(body, SMALL);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(SMALL.maxChars);
      // No word is cut in two: every chunk starts and ends on a whole word.
      expect(chunk.text).toMatch(/^word\d+( word\d+)*$/);
    }
    // Overlap: each chunk starts before the previous one ended, and nothing is skipped.
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1];
      const chunk = chunks[index];
      expect(chunk?.charStart).toBeLessThan(previous?.charEnd ?? 0);
      expect(chunk?.charStart ?? 0).toBeGreaterThan(previous?.charStart ?? 0);
    }
    expect(chunks[chunks.length - 1]?.charEnd).toBe(body.length);
    expectSlices(body, chunks);
  });

  it('chunks Thai text without cutting a grapheme (vowel and tone marks stay with their consonant)', () => {
    const body = `# คู่มือรีเซ็ตรหัสผ่าน\n\n${THAI_SENTENCE.repeat(12)}`;
    const chunks = chunkMarkdown(body, SMALL);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.section === 'คู่มือรีเซ็ตรหัสผ่าน')).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(SMALL.maxChars);
      // A combining mark (a Thai vowel above or below, a tone mark) never opens a chunk.
      expect(chunk.text).not.toMatch(/^\p{M}/u);
    }
    expectGraphemeSafe(body, chunks);
    expectSlices(body, chunks);
  });

  it('cuts Thai at word boundaries when it can: no chunk ends in the middle of a known word', () => {
    const body = THAI_SENTENCE.repeat(10).trim();
    const words = new Set<number>([body.length]);
    for (const part of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(body)) {
      words.add(part.index);
    }
    const chunks = chunkMarkdown(body, SMALL);
    const offBoundary = chunks.filter((chunk) => !words.has(chunk.charEnd));
    expect(offBoundary).toEqual([]);
  });

  it('cuts a run with no boundary at all (a long URL) by grapheme, never inside a surrogate pair', () => {
    const body = `https://example.com/${'a-very-long-path-segment'.repeat(30)}${'😀👍🏽'.repeat(60)}`;
    const chunks = chunkMarkdown(body, SMALL);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(SMALL.maxChars);
    expectGraphemeSafe(body, chunks);
    expect(chunks.map((chunk) => chunk.text).join('')).toContain('😀👍🏽');
    expectSlices(body, chunks);
  });

  it('handles Windows line endings and a body without a final newline', () => {
    const body = '# Title\r\n\r\nFirst paragraph.\r\n\r\n## Next\r\n\r\nSecond paragraph.';
    const chunks = chunkMarkdown(body, SMALL);
    expect(chunks.map((chunk) => chunk.section)).toEqual(['Title', 'Title > Next']);
    expectSlices(body, chunks);
  });

  it('is deterministic', () => {
    const body = `${THAI_SENTENCE.repeat(8)}\n\n# English\n\n${'Sentence number one. '.repeat(30)}`;
    expect(chunkMarkdown(body, SMALL)).toEqual(chunkMarkdown(body, SMALL));
  });

  it('uses the shared defaults when no options are given', () => {
    const body = 'Short.';
    expect(chunkMarkdown(body)).toEqual(chunkMarkdown(body, DEFAULT_CHUNK_OPTIONS));
  });

  it('refuses nonsense sizes', () => {
    expect(() => {
      assertChunkOptions({ ...SMALL, maxChars: 100 });
    }).toThrow(ChunkOptionsError);
    expect(() => {
      assertChunkOptions({ ...SMALL, overlapChars: 150 });
    }).toThrow(ChunkOptionsError);
    expect(() => {
      assertChunkOptions({ ...SMALL, targetChars: 10 });
    }).toThrow(ChunkOptionsError);
    expect(() => {
      assertChunkOptions({ ...SMALL, minChars: 250 });
    }).toThrow(ChunkOptionsError);
    expect(() => {
      assertChunkOptions({ ...SMALL, targetChars: 100.5 });
    }).toThrow(ChunkOptionsError);
    expect(() => {
      assertChunkOptions(SMALL);
    }).not.toThrow();
  });
});
