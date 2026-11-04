import { afterEach, describe, expect, it } from 'vitest';

import {
  applyRedactionNer,
  createLocalNameFinder,
  NerLimitError,
  type NameFinder,
} from './ner-local.js';
import { createRedactor, setDefaultNameFinder } from './redactor.js';

// T-153 prototype: a local finder for names with no cue. English only; the gaps are asserted too,
// so a change that quietly widens or narrows it shows up here.
afterEach(() => {
  setDefaultNameFinder(null);
});

const local = createRedactor({ nameFinder: createLocalNameFinder() });
const redact = (text: string): string => local.session({ scope: 'ticket:ner' }).redact(text);

describe('local name finder', () => {
  it('finds an English name that has no cue and is not in the dictionary', () => {
    const out = redact('Yesterday John Smith opened three tickets about the same invoice.');
    expect(out).not.toContain('John');
    expect(out).not.toContain('Smith');
    expect(out).toMatch(/Yesterday \[NAME_1\] \[NAME_2\] opened/);
  });

  it('keeps punctuation outside the placeholder and gives a repeated word one placeholder', () => {
    const out = redact('We spoke with Maria Garcia, and Maria Garcia agreed.');
    expect(out).toBe('We spoke with [NAME_1] [NAME_2], and [NAME_1] [NAME_2] agreed.');
  });

  it('shares the placeholder with the dictionary', () => {
    const session = createRedactor({
      names: () => ['Wei Zhang'],
      nameFinder: createLocalNameFinder(),
    }).session({ scope: 'x' });
    const out = session.redact('Wei Zhang from procurement wrote. Later Wei Zhang called.');
    expect(out).not.toContain('Wei');
    expect(out.match(/\[NAME_\d+\]/g)).toHaveLength(2);
    expect(new Set(out.match(/\[NAME_\d+\]/g)).size).toBe(1);
  });

  it('leaves capitalised words that are not people alone', () => {
    const text = 'On Monday the Bangkok office saw Apple Pay failures in the Google Cloud console.';
    expect(redact(text)).toBe(text);
  });

  it('does not find Thai names: the documented gap that a stronger model has to close', () => {
    const text = 'สมชาย ใจดี โทรมาเมื่อวานนี้แล้วบอกว่าใบแจ้งหนี้ผิด';
    expect(redact(text)).toBe(text);
  });

  it('restores for the customer, because the name came from the ticket', () => {
    const session = local.session({ scope: 'ticket:restore' });
    const redacted = session.redact('The account belongs to Maria Garcia and was renewed.');
    expect(session.restore(redacted, 'customer').text).toBe(
      'The account belongs to Maria Garcia and was renewed.',
    );
  });

  it('is bounded: a text that is far too long is refused, not skipped', () => {
    const finder = createLocalNameFinder();
    expect(() => finder('word '.repeat(300_000))).toThrow(NerLimitError);
  });
});

describe('redactor name finder option', () => {
  const failing: NameFinder = () => {
    throw new Error('finder down');
  };

  it('fails closed: a finder that throws makes redact throw', () => {
    const redactor = createRedactor({ nameFinder: failing });
    expect(() => redactor.session({ scope: 's' }).redact('hello')).toThrow('finder down');
  });

  it('is off by default and follows the process default when one is set', () => {
    const text = 'Yesterday John Smith opened a ticket.';
    expect(createRedactor().session({ scope: 's' }).redact(text)).toBe(text);
    applyRedactionNer('local');
    expect(createRedactor().session({ scope: 's' }).redact(text)).not.toContain('John');
    // an explicit null wins over the default
    expect(createRedactor({ nameFinder: null }).session({ scope: 's' }).redact(text)).toBe(text);
    applyRedactionNer('off');
    expect(createRedactor().session({ scope: 's' }).redact(text)).toBe(text);
  });

  it('maps a finder span to the right place when the text had invisible characters', () => {
    const redactor = createRedactor({
      nameFinder: (text) => {
        const at = text.indexOf('Somchai');
        return at === -1 ? [] : [{ start: at, end: at + 'Somchai'.length }];
      },
    });
    const out = redactor.session({ scope: 's' }).redact('Hi​ there Somchai​!');
    expect(out).not.toContain('Somchai');
  });
});
