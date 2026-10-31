import { describe, expect, it } from 'vitest';

import { buildMatcher, MatchLimitError } from './aho-corasick.js';
import {
  createNameDetector,
  DictionaryTooLargeError,
  MAX_DICTIONARY_CHARS,
  MAX_NAME_CHARS,
  MAX_NAME_PARTS,
  NameMatchLimitError,
} from './detectors.js';
import { buildView } from './normalize.js';
import { createRedactor } from './redactor.js';

// SR106-N2: adversarial display names must not be able to exhaust memory or CPU. Before the fix
// a name made of many overlapping parts cost 434 MB to 1.1 GB for a 100 KB input and ran out of
// memory at 1 MB, because every match was collected before any was dropped.

const HEAP_BUDGET_BYTES = 64 * 1024 * 1024;
const CPU_BUDGET_MS = 2000;

interface Measured<T> {
  value?: T;
  error?: unknown;
  heapDelta: number;
  cpuMs: number;
}

/** Runs `work`, reporting the heap growth at its end and the CPU time it used. */
function measure<T>(work: () => T): Measured<T> {
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  const result: Measured<T> = { heapDelta: 0, cpuMs: 0 };
  try {
    result.value = work();
  } catch (error) {
    result.error = error;
  }
  const used = process.cpuUsage(cpuBefore);
  result.heapDelta = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
  result.cpuMs = (used.user + used.system) / 1000;
  return result;
}

const repeat = (unit: string, size: number): string =>
  unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

/** Names whose parts are runs of one letter of many lengths: every position matches many parts. */
function overlappingNames(count: number): string[] {
  const names: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const parts: string[] = [];
    for (let part = 0; part < 40; part += 1) {
      parts.push('a'.repeat(3 + ((n * 7 + part * 13) % 120)));
    }
    names.push(parts.join(' '));
  }
  return names;
}

describe('name limits', () => {
  it('keeps only the first MAX_NAME_CHARS characters of a name', () => {
    const detect = createNameDetector({
      names: ['b'.repeat(MAX_NAME_CHARS + 50)],
      minLength: 3,
      matchParts: false,
    });
    const spans = detect(buildView(`x ${'b'.repeat(MAX_NAME_CHARS + 50)} y`));
    // The cut name no longer ends on a word boundary, so it is not matched inside the longer word.
    expect(spans.length).toBeLessThanOrEqual(1);
    for (const found of spans) expect(found.end - found.start).toBeLessThanOrEqual(MAX_NAME_CHARS);
    const exact = detect(buildView(`x ${'b'.repeat(MAX_NAME_CHARS)} y`));
    expect(exact).toHaveLength(1);
  });

  it('matches only the first MAX_NAME_PARTS parts of a name on their own', () => {
    const words = Array.from({ length: MAX_NAME_PARTS + 3 }, (_, i) => `word${String(i)}x`);
    const detect = createNameDetector({
      names: [words.join(' ')],
      minLength: 3,
      matchParts: true,
    });
    const found = (word: string): number => detect(buildView(`say ${word} now`)).length;
    expect(found(words[0] ?? '')).toBe(1);
    expect(found(words[MAX_NAME_PARTS - 1] ?? '')).toBe(1);
    expect(found(words[MAX_NAME_PARTS] ?? '')).toBe(0);
  });

  it('does not read past the bounded prefix of a huge name', () => {
    const huge = `${'p '.repeat(1_000_000)}tail`;
    const run = measure(() =>
      createNameDetector({ names: [huge, huge], minLength: 1, matchParts: true }),
    );
    expect(run.error).toBeUndefined();
    expect(run.heapDelta).toBeLessThan(HEAP_BUDGET_BYTES);
    expect(run.cpuMs).toBeLessThan(CPU_BUDGET_MS);
  });

  it('refuses a dictionary whose patterns add up to too many characters', () => {
    const names: string[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      names.push(`${String(i).padStart(6, '0')}${'z'.repeat(120)}`);
    }
    expect(names.length * 126).toBeGreaterThan(MAX_DICTIONARY_CHARS);
    expect(() => createNameDetector({ names, minLength: 3, matchParts: false })).toThrow(
      DictionaryTooLargeError,
    );
  });
});

describe('leftmost-longest selection during the scan', () => {
  const select = (patterns: string[], text: string): string[] =>
    buildMatcher(patterns)
      .scan(text)
      .map((match) => text.slice(match.start, match.end));

  it('takes the leftmost match, then the longest at that start', () => {
    expect(select(['ab', 'abcd', 'bc', 'cd'], 'abcd')).toEqual(['abcd']);
    expect(select(['ab', 'bcd', 'cde'], 'abcde')).toEqual(['ab', 'cde']);
  });

  it('keeps a later match that does not overlap an earlier one', () => {
    expect(select(['abc', 'bcdef', 'def'], 'abcdef')).toEqual(['abc', 'def']);
  });

  it('agrees with a brute-force leftmost-longest on random inputs', () => {
    let seed = 12345;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const word = (max: number): string =>
      Array.from({ length: 1 + random(max) }, () => 'abc'[random(3)]).join('');
    for (let round = 0; round < 300; round += 1) {
      const patterns = Array.from(new Set(Array.from({ length: 1 + random(8) }, () => word(5))));
      const text = word(60) + word(60);
      const expected: string[] = [];
      let cursor = 0;
      for (let start = 0; start < text.length; start += 1) {
        if (start < cursor) continue;
        let best = '';
        for (const pattern of patterns) {
          if (text.startsWith(pattern, start) && pattern.length > best.length) best = pattern;
        }
        if (best !== '') {
          expected.push(`${String(start)}:${best}`);
          cursor = start + best.length;
        }
      }
      const got = buildMatcher(patterns)
        .scan(text)
        .map((match) => `${String(match.start)}:${text.slice(match.start, match.end)}`);
      expect(got, `${JSON.stringify(patterns)} ${text}`).toEqual(expected);
    }
  });

  it('works across window boundaries on a long text', () => {
    const matches = buildMatcher(['abc', 'abcabc', 'bcab']).scan('abc'.repeat(5000));
    expect(matches).toHaveLength(2500);
    expect(matches.every((match, i) => match.start === i * 6 && match.end === i * 6 + 6)).toBe(
      true,
    );
  });

  it('throws MatchLimitError past the ceiling instead of collecting matches', () => {
    const matcher = buildMatcher(['a', 'aa', 'aaa']);
    expect(() => matcher.scan('a'.repeat(1000), { maxMatches: 100 })).toThrow(MatchLimitError);
  });
});

describe('adversarial display names (SR106-N2)', () => {
  const names = overlappingNames(500);

  it.each([
    ['100 KB', 100_000],
    ['1 MB', 1_000_000],
  ])('fails closed on %s of overlapping hits within the memory and CPU budget', (_label, size) => {
    const redactor = createRedactor({ names: () => names, maxInputChars: 2_000_000 });
    const text = repeat('a', size);
    const run = measure(() => redactor.session({ scope: 'ticket:dos' }).redact(text));
    expect(run.error).toBeInstanceOf(NameMatchLimitError);
    expect(run.heapDelta).toBeLessThan(HEAP_BUDGET_BYTES);
    expect(run.cpuMs).toBeLessThan(CPU_BUDGET_MS);
  });

  it.each([
    ['100 KB', 100_000],
    ['1 MB', 1_000_000],
  ])('redacts %s of dense but bounded name hits within the budget', (_label, size) => {
    // Few patterns overlap at any position, so the ceiling is not reached; the window stays small.
    const redactor = createRedactor({
      names: () => ['abc abcabc abcabcabc', 'bcab'],
      maxInputChars: 2_000_000,
    });
    const text = repeat('abc ', size);
    const session = redactor.session({ scope: 'ticket:dense' });
    const run = measure(() => session.redact(text));
    expect(run.error).toBeUndefined();
    expect(run.heapDelta).toBeLessThan(HEAP_BUDGET_BYTES);
    expect(run.cpuMs).toBeLessThan(CPU_BUDGET_MS);
    expect(run.value).not.toContain('abc');
    expect(session.restore(run.value ?? '', 'internal').text).toBe(text);
  });

  it('the dictionary adds little memory on top of the plain 1 MB redaction', () => {
    const plain = measure(() =>
      createRedactor({ maxInputChars: 2_000_000 })
        .session({ scope: 'ticket:plain' })
        .redact(repeat('a', 1_000_000)),
    );
    const named = measure(() =>
      createRedactor({ names: () => names, maxInputChars: 2_000_000 })
        .session({ scope: 'ticket:named' })
        .redact(repeat('a', 1_000_000)),
    );
    expect(plain.error).toBeUndefined();
    expect(named.error).toBeInstanceOf(NameMatchLimitError);
    expect(named.heapDelta - plain.heapDelta).toBeLessThan(HEAP_BUDGET_BYTES);
  });

  it('leaves no partial state behind after a limit failure', () => {
    const redactor = createRedactor({ names: () => names, maxInputChars: 2_000_000 });
    const session = redactor.session({ scope: 'ticket:dos' });
    expect(() => session.redact(repeat('a', 200_000))).toThrow(NameMatchLimitError);
    expect(session.report().total).toBe(0);
    expect(session.snapshot().tokens).toEqual({});
    // The session still works for ordinary text afterwards.
    expect(session.redact('mail me at a@b.com')).toBe('mail me at [EMAIL_1]');
  });
});
