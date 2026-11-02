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

  it('does not treat "access" or "accent" as an account keyword (the number is still a run of 10 digits)', () => {
    expect(redact('access 1234567890')).toBe('access [PHONE_1]');
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

// SR106-N5: the second review round found these still got through.
describe('SR106-N5: mixed and extra separators inside numbers', () => {
  it.each([
    ['081-234 5678', '[PHONE_1]'],
    ['081 234-5678', '[PHONE_1]'],
    ['tel 081-234.5678 ok', 'tel [PHONE_1] ok'],
    ['08-1234 5678', '[PHONE_1]'],
    ['081_234_5678', '[PHONE_1]'],
    ['081,234,5678', '[PHONE_1]'],
    ['081, 234, 5678', '[PHONE_1]'],
    ['081\n234\n5678', '[PHONE_1]'],
    ['081\r\n234\r\n5678', '[PHONE_1]'],
    ['081、234、5678', '[PHONE_1]'],
    ['02 123-4567', '[PHONE_1]'],
  ])('redacts the phone %j', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('redacts two phones in a comma separated list as two phones', () => {
    expect(redact('0812345678, 0898765432')).toBe('[PHONE_1], [PHONE_2]');
    expect(redact('0812345678,\n0898765432')).toBe('[PHONE_1],\n[PHONE_2]');
  });

  it('redacts a card separated by underscores, commas or newlines', () => {
    const parts = [CARD.slice(0, 4), CARD.slice(4, 8), CARD.slice(8, 12), CARD.slice(12)];
    for (const separator of ['_', ',', '\n', ', ']) {
      expect(redact(`card ${parts.join(separator)}`)).toBe('card [CARD_1]');
    }
  });

  it('still leaves dates, counts and short lists alone', () => {
    for (const text of [
      '08/10/2026 12 tickets',
      '08-10-2026 12',
      '08.10.2026 12',
      '08,10,2026 12',
      '1, 2, 3, 4, 5, 6, 7, 8, 9, 10',
      'rows 12_34_56',
      'versions 1.2.3, 4.5.6',
    ]) {
      expect(redact(text), text).toBe(text);
    }
  });

  it('redacts a national ID in less usual groupings', () => {
    const groupings: number[][] = [
      [13],
      [1, 4, 5, 2, 1],
      [4, 4, 4, 1],
      [5, 5, 3],
      [6, 7],
      [1, 12],
      [3, 3, 3, 4],
    ];
    for (const sizes of groupings) {
      let at = 0;
      const parts = sizes.map((size) => {
        const part = ID.slice(at, at + size);
        at += size;
        return part;
      });
      for (const separator of [' ', '-', '_', ', ']) {
        expect(redact(`id ${parts.join(separator)}`), `${sizes.join('-')} ${separator}`).toBe(
          'id [THAI_ID_1]',
        );
      }
    }
  });

  it('does not read a 13-digit number with a bad check digit as an ID (it is a run of digits, redacted anyway)', () => {
    const bad = `${ID.slice(0, 12)}${String((Number(ID.slice(12)) + 1) % 10)}`;
    const grouped = `${bad.slice(0, 4)} ${bad.slice(4, 8)} ${bad.slice(8)}`;
    expect(redact(grouped)).toBe('[PHONE_1]');
  });
});

describe('SR106-N5: invisible characters', () => {
  const INVISIBLES: [string, string][] = [
    ['combining grapheme joiner U+034F', '͏'],
    ['variation selector-15 U+FE0E', '︎'],
    ['variation selector-16 U+FE0F', '️'],
    ['variation selector-17 U+E0100', '\u{E0100}'],
    ['Mongolian free variation selector U+180B', '᠋'],
    ['Hangul filler U+3164', 'ㅤ'],
    ['halfwidth Hangul filler U+FFA0', 'ﾠ'],
    ['Hangul choseong filler U+115F', 'ᅟ'],
    ['Khmer inherent vowel U+17B4', '឴'],
    ['Braille blank U+2800', '⠀'],
  ];

  it.each(INVISIBLES)('does not let %s split a phone number', (_label, mark) => {
    expect(redact(`08${mark}12${mark}34${mark}5678`)).toBe('[PHONE_1]');
    expect(redact(`081-234${mark}-5678`)).toBe('[PHONE_1]');
  });

  it.each(INVISIBLES)('does not let %s split an email', (_label, mark) => {
    expect(redact(`so${mark}mchai@exam${mark}ple.c${mark}om`)).toBe('[EMAIL_1]');
  });

  it('does not let an invisible mark split a card or an ID', () => {
    const mark = '͏';
    const card = [CARD.slice(0, 4), CARD.slice(4, 8), CARD.slice(8, 12), CARD.slice(12)].join(
      `${mark} `,
    );
    expect(redact(card)).toBe('[CARD_1]');
    expect(redact(`${ID.slice(0, 5)}${mark}${ID.slice(5)}`)).toBe('[THAI_ID_1]');
  });

  it('does not let a combining mark on a digit split a number', () => {
    const marked = Array.from('0812345678')
      .map((digit) => `${digit}́`)
      .join('');
    expect(redact(marked)).toBe('[PHONE_1]');
  });

  it('restores the original text when invisible characters sit inside a redacted span', () => {
    const session = redactor.session({ scope: 'ticket:test' });
    const text = 'call 08͏12ㅤ345678 now';
    const out = session.redact(text);
    expect(out).toBe('call [PHONE_1] now');
    expect(session.restore(out, 'internal').text).toBe(text);
  });

  it('maps the view back to the original around dropped characters', () => {
    const view = buildView('1͏2ㅤ3');
    expect(view.text).toBe('123');
    expect([...view.starts]).toEqual([0, 2, 4]);
  });
});

describe('SR106-N5: ideographic full stops and Thai domains', () => {
  it.each([
    ['user@example。com', '[EMAIL_1]'],
    ['user@example｡com', '[EMAIL_1]'],
    ['user@sub。example。co。th', '[EMAIL_1]'],
    ['ผู้ใช้@example。com', '[EMAIL_1]'],
    ['mail user@例え。jp now', 'mail [EMAIL_1] now'],
  ])('redacts %j', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it.each([
    ['สมชาย@ตัวอย่าง.ไทย', '[EMAIL_1]'],
    ['user@ตัวอย่าง.ไทย', '[EMAIL_1]'],
    ['user@ร้านค้า.com', '[EMAIL_1]'],
    ['user@ร้านค้า.co.th', '[EMAIL_1]'],
    ['user@mail.ร้านค้า.ไทย', '[EMAIL_1]'],
    ['อีเมลuser@ตัวอย่าง.ไทย ครับ', 'อีเมล[EMAIL_1] ครับ'],
    ['ส่งไปที่ user@ตัวอย่าง.ไทย แล้วโทร', 'ส่งไปที่ [EMAIL_1] แล้วโทร'],
  ])('redacts the Thai domain in %j', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('does not swallow Thai words that follow the domain', () => {
    expect(redact('user@example.comครับ')).toBe('[EMAIL_1]ครับ');
    expect(redact('user@example.com.ครับ')).toBe('[EMAIL_1].ครับ');
    expect(redact('user@example.co.thครับผม')).toBe('[EMAIL_1]ครับผม');
    expect(redact('user@example.com แล้วครับ')).toBe('[EMAIL_1] แล้วครับ');
    expect(redact('ส่งมาที่user@example.comเลยครับ')).toBe('ส่งมาที่[EMAIL_1]เลยครับ');
  });

  it('does not treat a lone Thai word after an @ as a domain', () => {
    for (const text of ['ติดต่อ@ตัวอย่าง.บริษัท', 'ราคา 5@ครับ', 'user@ตัวอย่าง']) {
      expect(redact(text), text).toBe(text);
    }
  });

  it('restores the original text of an email with a Thai domain', () => {
    const session = redactor.session({ scope: 'ticket:test' });
    const text = 'user@ตัวอย่าง.ไทยครับ and user@example。com';
    expect(session.restore(session.redact(text), 'internal').text).toBe(text);
  });
});

describe('SR106-N5: known gaps (pinned so that closing one is a deliberate change)', () => {
  it('does not fold homoglyphs from other scripts (Cyrillic а for Latin a)', () => {
    // NFKC does not map U+0430 to 'a', so the keyword "account" is not recognised.
    expect(redact('аccount 1234567890')).toBe('аccount [PHONE_1]');
  });

  it('redacts a bare 10-digit account number as a phone-sized run, without a keyword or bank formatting', () => {
    expect(redact('transfer to 1234567890 please')).toBe('transfer to [PHONE_1] please');
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
