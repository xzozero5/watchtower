import { describe, expect, it } from 'vitest';

import { createRedactor, RedactionInputTooLargeError } from './redactor.js';
import { DictionaryTooLargeError, MAX_DICTIONARY_ENTRIES } from './detectors.js';

// R-3 / R-4: no input may make the redactor super-linear. These inputs target the usual
// culprits (a pattern restarting at every position of one long run). Before the fix a 200 KB
// run of one repeated character took tens of seconds. The budget is generous for CI noise and
// still three orders of magnitude below the old behaviour.
const SIZE = 200_000;

/**
 * CPU time of this process (user + system), not wall time: the whole repo's tests run in
 * parallel under turbo and wall time inflates tenfold under that load, while CPU time does not.
 */
function cpuMs(work: () => void): number {
  const before = process.cpuUsage();
  work();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
}
const BUDGET_MS = 200;

const repeat = (unit: string, size = SIZE): string =>
  unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

const ADVERSARIAL: [string, string][] = [
  ['letters', repeat('a')],
  ['digits', repeat('1')],
  ['zeros', repeat('0')],
  ['digit and space', repeat('1 ')],
  ['digit and dash', repeat('1-')],
  ['digit and dot', repeat('1.')],
  ['zero and slash', repeat('0/')],
  ['phone list', repeat('0812345678 ')],
  ['phone-like groups', repeat('081-234-567 ')],
  ['card-like groups', repeat('4111 1111 1111 111 ')],
  ['thai id list', repeat('1101700230673 ')],
  ['at signs', repeat('@')],
  ['local parts', repeat('a@')],
  ['dotted domain', repeat('a@b.')],
  ['no-dot domain', repeat('a@b')],
  ['long local part', `${repeat('a', SIZE / 2)}@${repeat('b.', SIZE / 2 - 1)}`],
  ['token openers', repeat('[EMAIL_')],
  ['token digits', `[EMAIL_${repeat('1', SIZE - 7)}`],
  ['brackets', repeat('[')],
  ['keyword', repeat('account ')],
  ['keyword and digits', repeat('บัญชี 1 ')],
  ['a/c', repeat('a/c 1')],
  ['plus', repeat('+')],
  ['plus groups', repeat('+66 ')],
  ['parens', repeat('(0) ')],
  ['separators', repeat(' - ')],
  ['zero-width', repeat('​')],
  ['combining marks', repeat('á')],
  ['thai text', repeat('สวัสดีครับผมโทรมาเรื่องระบบ ')],
  ['thai digits', repeat('๐๘๑ ')],
  ['mixed', repeat('x1 2-3.4/5 (6) +7 a@b. [A_1] ')],
];

describe('redactor time on adversarial 200 KB inputs', () => {
  const redactor = createRedactor({ names: () => ['Somchai Jaidee', 'สมชาย'] });

  it.each(ADVERSARIAL)('%s', (_name, input) => {
    expect(input.length).toBeGreaterThanOrEqual(SIZE);
    // Best of three, so a one-off pause (GC, a noisy neighbour) cannot fail the test.
    let best = Infinity;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = redactor.session({ scope: 'ticket:test' });
      best = Math.min(
        best,
        cpuMs(() => session.redact(input)),
      );
    }
    expect(best).toBeLessThan(BUDGET_MS);
  });

  it('refuses input beyond the size limit', () => {
    expect(() =>
      createRedactor({ maxInputChars: 1000 }).session({ scope: 's' }).redact('a'.repeat(1001)),
    ).toThrow(RedactionInputTooLargeError);
  });
});

describe('name dictionary at scale (R-4)', () => {
  function names(count: number): string[] {
    const list: string[] = [];
    for (let i = 0; i < count; i += 1) {
      list.push(`Firstname${String(i).padStart(5, '0')} Lastname${String(i * 7).padStart(5, '0')}`);
    }
    return list;
  }

  it('matches 10,000 names in a 100 KB text within the time budget', () => {
    const dictionary = names(10_000);
    const redactor = createRedactor({ names: () => dictionary });
    let text = '';
    for (let i = 0; text.length < 100_000; i += 1) {
      text += `Ticket ${String(i)} from Firstname${String((i * 13) % 10_000).padStart(5, '0')} regarding the outage. `;
    }

    let out = '';
    let session = redactor.session({ scope: 'ticket:test' });
    const elapsed = cpuMs(() => {
      session = redactor.session({ scope: 'ticket:test' });
      out = session.redact(text);
    });

    expect(elapsed).toBeLessThan(1000);
    expect(out).not.toContain('Firstname');
    expect(session.report().byKind.NAME).toBeGreaterThan(900);
    expect(session.restore(out, 'internal').text).toBe(text);
  });

  it('finds the same names as a direct search', () => {
    const dictionary = names(300);
    const redactor = createRedactor({ names: () => dictionary, matchNameParts: false });
    const text = `x ${String(dictionary[7])} y ${String(dictionary[299])} z Firstname00008 Lastname00056 q`;
    const out = redactor.session({ scope: 'ticket:test' }).redact(text);
    expect(out).toBe('x [NAME_1] y [NAME_2] z [NAME_3] q');
  });

  it('prefers the longest name and handles names that are prefixes of each other', () => {
    const redactor = createRedactor({
      names: () => ['Ann Lee', 'Ann Leeson', 'Annabel'],
      matchNameParts: false,
    });
    const out = redactor
      .session({ scope: 'ticket:test' })
      .redact('Ann Leeson, Ann Lee, Annabel, Ann');
    expect(out).toBe('[NAME_1], [NAME_2], [NAME_3], Ann');
  });

  it('refuses a dictionary that is far too large instead of building it', () => {
    const redactor = createRedactor({
      names: () => names(MAX_DICTIONARY_ENTRIES / 2 + 10),
    });
    expect(() => redactor.session({ scope: 'ticket:test' })).toThrow(DictionaryTooLargeError);
  });
});
