import { describe, expect, it } from 'vitest';

import { buildView } from './normalize.js';
import { createRedactor } from './redactor.js';

// R-5: look-alike characters, separators and scripts must not hide PII from the detectors.
function luhn(first15: string): string {
  let sum = 0;
  for (let i = 0; i < first15.length; i += 1) {
    let digit = Number(first15[first15.length - 1 - i]);
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return `${first15}${String((10 - (sum % 10)) % 10)}`;
}
function thaiId(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(first12[i]) * (13 - i);
  return `${first12}${String((11 - (sum % 11)) % 10)}`;
}

const CARD = luhn('411111111111111');
const ID = thaiId('110170023067');
const redactor = createRedactor({ names: () => ['José García', 'สมชาย'] });
const redact = (text: string) => redactor.session({ scope: 'ticket:test' }).redact(text);

describe('normalised view', () => {
  it('keeps an index map back to the original string', () => {
    const view = buildView('a​b１');
    expect(view.text).toBe('ab1');
    expect([...view.starts]).toEqual([0, 2, 3]);
    expect([...view.ends]).toEqual([1, 3, 4]);
  });

  it('composes NFD, drops zero-width characters and maps every Nd digit to ASCII', () => {
    expect(buildView('José').text).toBe('José');
    expect(buildView('1​2‍3­4⁠').text).toBe('1234');
    expect(buildView('٠١٢٣٤٥٦٧٨٩').text).toBe('0123456789'); // Arabic-Indic
    expect(buildView('०१२३४५६७८९').text).toBe('0123456789'); // Devanagari
    expect(buildView('𝟘𝟙𝟚𝟛').text).toBe('0123'); // mathematical double-struck
    expect(buildView(' 81　').text).toBe(' 81 ');
  });
});

describe('phones with unusual separators and scripts', () => {
  it.each([
    ['โทร 08-1234-5678 ครับ', 'โทร [PHONE_1] ครับ'],
    ['tel 081.234.5678.', 'tel [PHONE_1].'],
    ['(02) 123 4567', '[PHONE_1]'],
    ['call (02)123-4567 now', 'call [PHONE_1] now'],
    ['call0812345678', 'call[PHONE_1]'],
    ['โทร0812345678ครับ', 'โทร[PHONE_1]ครับ'],
    ['+1 (415) 555-0100', '[PHONE_1]'],
    ['＋66 81 234 5678', '[PHONE_1]'],
    ['+66 81 234 5678', '[PHONE_1]'],
    ['081  234  5678', '[PHONE_1]'],
    ['081–234–5678', '[PHONE_1]'],
    ['081/234/5678', '[PHONE_1]'],
    ['０８１２３４５６７８', '[PHONE_1]'],
    ['٠٨١٢٣٤٥٦٧٨', '[PHONE_1]'],
    ['081​2345678', '[PHONE_1]'],
    ['08‍1-234-⁠5678', '[PHONE_1]'],
  ])('redacts %j', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('does not read a date followed by a count as a phone', () => {
    for (const text of ['08/10/2026 12 tickets', '08-10-2026 12', '2026-10-31 08 12 34']) {
      expect(redact(text)).toBe(text);
    }
  });
});

describe('emails with unusual forms', () => {
  it.each([
    ['somchai＠example.com', '[EMAIL_1]'],
    ['ｓｏｍｃｈａｉ＠ｅｘａｍｐｌｅ．ｃｏｍ', '[EMAIL_1]'],
    ['mail user@münchen.de now', 'mail [EMAIL_1] now'],
    ['user@例え.jp', '[EMAIL_1]'],
    ['user@xn--mnchen-3ya.de', '[EMAIL_1]'],
    ['สมชาย@example.com', '[EMAIL_1]'],
    ['อีเมลsomchai@example.comครับ', 'อีเมล[EMAIL_1]ครับ'],
    ['a​@b.com', '[EMAIL_1]'],
    ['first.last+tag@sub.example.co.th,', '[EMAIL_1],'],
  ])('redacts %j', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });
});

describe('cards, ids and bank accounts with unusual forms', () => {
  const group = (separator: string) =>
    [CARD.slice(0, 4), CARD.slice(4, 8), CARD.slice(8, 12), CARD.slice(12)].join(separator);

  it.each([['.'], ['/'], ['-'], [' '], [' '], ['  '], [' - ']])(
    'redacts a card separated by %j',
    (separator) => {
      expect(redact(`card ${group(separator)}`)).toBe('card [CARD_1]');
    },
  );

  it('redacts a card in full-width digits', () => {
    expect(redact(CARD.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d))))).toBe(
      '[CARD_1]',
    );
  });

  it.each([
    ['acc no. 1234567890', 'acc no. [BANK_1]'],
    ['Acc. No: 123-4-56789-0', 'Acc. No: [BANK_1]'],
    ['ACCOUNT NUMBER 1234567890', 'ACCOUNT NUMBER [BANK_1]'],
    ['A/C 123456789012', 'A/C [BANK_1]'],
    ['เลขบัญชี ๑๒๓๔๕๖๗๘๙๐', 'เลขบัญชี [BANK_1]'],
  ])('redacts a bank account after a keyword: %j', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('does not treat "access" or "accent" as an account keyword', () => {
    expect(redact('access 1234567890')).toBe('access 1234567890');
  });

  it('redacts a Thai ID with en dashes, full-width digits or zero-width characters', () => {
    const dashed = [
      ID.slice(0, 1),
      ID.slice(1, 5),
      ID.slice(5, 10),
      ID.slice(10, 12),
      ID.slice(12),
    ];
    expect(redact(dashed.join('–'))).toBe('[THAI_ID_1]');
    expect(redact(ID.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d))))).toBe(
      '[THAI_ID_1]',
    );
    expect(redact(`${ID.slice(0, 6)}${String.fromCharCode(0x200b)}${ID.slice(6)}`)).toBe(
      '[THAI_ID_1]',
    );
  });
});

describe('names in other Unicode forms', () => {
  it('matches NFC and NFD forms, any case, and restores the original bytes', () => {
    const session = redactor.session({ scope: 'ticket:test' });
    const nfd = 'Hola José García, y JOSÉ GARCÍA';
    const out = session.redact(nfd);
    expect(out).not.toMatch(/Jos|Garc/i);
    expect(session.restore(out, 'internal').text).toBe(nfd);
  });

  it('matches a name with a zero-width character inside', () => {
    expect(redact('คุณสม​ชาย โทรมา')).toBe('คุณ[NAME_1] โทรมา');
  });
});

describe('token look-alikes in other forms are escaped', () => {
  it('escapes full-width and zero-width variants of a token', () => {
    const session = redactor.session({ scope: 'ticket:test' });
    const text = '［EMAIL_1］ and [EMAIL​_2] and [EMAIL_３]';
    const out = session.redact(text);
    expect(out).toBe('[LITERAL_1] and [LITERAL_2] and [LITERAL_3]');
    expect(session.restore(out, 'internal').text).toBe(text);
  });
});

describe('round trip on hostile Unicode (seeded)', () => {
  function mulberry32(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const PIECES = [
    '0812345678',
    '081-234-5678',
    '+66 81 234 5678',
    'a@b.com',
    'ａ＠ｂ．ｃｏｍ',
    CARD,
    ID,
    'José',
    '​',
    '‍',
    '٠١٢',
    '０８１',
    '[EMAIL_1]',
    '［PHONE_2］',
    'สมชาย',
    '😀',
    '́',
    ' ',
    '\n',
    '-',
    '.',
    '(',
    ')',
    '@',
    'account ',
    'abc',
    'ค',
    '\ud800',
  ];

  it('restores exactly what was redacted', () => {
    const random = mulberry32(31102026);
    for (let run = 0; run < 500; run += 1) {
      let text = '';
      const count = 1 + Math.floor(random() * 14);
      for (let i = 0; i < count; i += 1) text += PIECES[Math.floor(random() * PIECES.length)] ?? '';
      const session = redactor.session({ scope: 'ticket:test' });
      expect(session.restore(session.redact(text), 'internal').text).toBe(text);
    }
  });
});
