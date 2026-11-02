import { describe, expect, it } from 'vitest';

import { createRedactor, RedactionInputTooLargeError, RedactionScopeError } from './redactor.js';
import { buildView } from './normalize.js';
import { isLuhnValid, isValidThaiNationalId } from './validators.js';

// Independent of the production checksum code, so a bug there cannot hide itself.
function thaiId(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(first12[i]) * (13 - i);
  return `${first12}${String((11 - (sum % 11)) % 10)}`;
}

function luhnCard(first15: string): string {
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

const ID = thaiId('110170023067'); // 13 digits, valid checksum
const redactor = createRedactor({
  names: () => ['สมชาย ใจดี', 'Nattaya Wong', 'Jo'],
});
const redact = (text: string) => redactor.session({ scope: 'ticket:test' }).redact(text);

describe('validators', () => {
  it('validates the Thai national ID checksum', () => {
    expect(isValidThaiNationalId(ID)).toBe(true);
    expect(isValidThaiNationalId(`${ID.slice(0, 12)}${String((Number(ID[12]) + 1) % 10)}`)).toBe(
      false,
    );
    expect(isValidThaiNationalId('0000000000000')).toBe(false);
    expect(isValidThaiNationalId('123456789012')).toBe(false);
  });

  it('validates Luhn', () => {
    expect(isLuhnValid('4111111111111111')).toBe(true);
    expect(isLuhnValid('4111111111111112')).toBe(false);
  });

  it('maps Thai digits to ASCII without changing length', () => {
    expect(buildView('๐๘๑-๒๓๔-๕๖๗๘').text).toBe('081-234-5678');
    expect(buildView('๐๘๑-๒๓๔-๕๖๗๘').text).toHaveLength('๐๘๑-๒๓๔-๕๖๗๘'.length);
  });
});

describe('Thai national ID', () => {
  it('redacts plain, dashed and spaced forms that pass the checksum', () => {
    const dashed = [
      ID.slice(0, 1),
      ID.slice(1, 5),
      ID.slice(5, 10),
      ID.slice(10, 12),
      ID.slice(12),
    ].join('-');
    const spaced = dashed.replaceAll('-', ' ');
    for (const form of [ID, dashed, spaced]) {
      expect(redact(`เลขบัตรประชาชน ${form} ครับ`)).toBe('เลขบัตรประชาชน [THAI_ID_1] ครับ');
    }
  });

  it('redacts a dashed ID however it is grouped, up to one digit at a time (N4)', () => {
    const grouped = (sizes: number[], separator = '-') => {
      const parts: string[] = [];
      let at = 0;
      for (const size of sizes) {
        parts.push(ID.slice(at, at + size));
        at += size;
      }
      return parts.join(separator);
    };
    const forms = [
      grouped([1, 2, 2, 2, 2, 2, 2]),
      grouped([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
      grouped([2, 2, 2, 2, 2, 2, 1], '–'),
      grouped([4, 4, 4, 1]),
      grouped([5, 5, 3]),
    ];
    for (const form of forms) {
      expect(redact(`ID: ${form}`), form).toBe('ID: [THAI_ID_1]');
    }
    // The checksum still decides what is an ID: the same shapes with a wrong last digit are not one
    // (a run of 12 or more digits is redacted as a phone-sized number, digit by digit it is left alone).
    const wrong = `${ID.slice(0, 12)}${String((Number(ID[12]) + 1) % 10)}`;
    const digitByDigit = wrong.split('').join('-');
    expect(redact(digitByDigit)).toBe(digitByDigit);
    expect(redact(`${wrong.slice(0, 1)}-${wrong.slice(1)}`)).not.toContain('THAI_ID');
  });

  it('redacts Thai-digit IDs', () => {
    const thaiDigits = ID.replace(/\d/g, (digit) => String.fromCharCode(0x0e50 + Number(digit)));
    expect(redact(`บัตร ${thaiDigits}`)).toBe('บัตร [THAI_ID_1]');
  });

  it('does not read 13 digits that fail the checksum as an ID (they are redacted as a number)', () => {
    const wrong = `${ID.slice(0, 12)}${String((Number(ID[12]) + 1) % 10)}`;
    expect(redact(`order ${wrong}`)).toBe('order [PHONE_1]');
  });

  it('does not read an ID inside a longer digit run (the whole run is redacted as a number)', () => {
    expect(redact(`ref ${ID}9`)).toBe('ref [PHONE_1]');
  });
});

describe('phone numbers', () => {
  it.each([
    ['โทร 081-234-5678 ด่วน', 'โทร [PHONE_1] ด่วน'],
    ['โทร0812345678ครับ', 'โทร[PHONE_1]ครับ'],
    ['call 0891234567.', 'call [PHONE_1].'],
    ['มือถือ ๐๘๑-๒๓๔-๕๖๗๘', 'มือถือ [PHONE_1]'],
    ['office 02 123 4567', 'office [PHONE_1]'],
    ['office 02-123-4567', 'office [PHONE_1]'],
    ['chiang mai 053-123-456', 'chiang mai [PHONE_1]'],
    ['+66 81 234 5678', '[PHONE_1]'],
    ['+66-2-123-4567', '[PHONE_1]'],
    ['+66 (0) 81 234 5678', '[PHONE_1]'],
    ['0066812345678', '[PHONE_1]'],
    ['us +1 415 555 2671 ok', 'us [PHONE_1] ok'],
    ['uk +44 20 7946 0958', 'uk [PHONE_1]'],
  ])('redacts %j', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('keeps one token for the same number written twice', () => {
    expect(redact('0812345678 และ 0812345678')).toBe('[PHONE_1] และ [PHONE_1]');
  });
});

describe('emails', () => {
  it.each([
    ['ติดต่อ somchai.j+wt@example.co.th ครับ', 'ติดต่อ [EMAIL_1] ครับ'],
    ['อีเมลsomchai@example.comครับ', 'อีเมล[EMAIL_1]ครับ'],
    ['mail a@b.com.', 'mail [EMAIL_1].'],
    ['<A.B@Sub.Example.ORG>', '<[EMAIL_1]>'],
  ])('redacts %j', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('numbers distinct addresses separately', () => {
    expect(redact('a@x.com b@x.com a@x.com')).toBe('[EMAIL_1] [EMAIL_2] [EMAIL_1]');
  });

  it('leaves an @ mention without a domain alone', () => {
    expect(redact('ping @somchai about it')).toBe('ping @somchai about it');
  });
});

describe('credit-card-like numbers', () => {
  const card = luhnCard('411111111111111');
  const amex = luhnCard('37828224631000');

  it('redacts a run, grouped forms and an Amex-shaped number', () => {
    const grouped = `${card.slice(0, 4)} ${card.slice(4, 8)} ${card.slice(8, 12)} ${card.slice(12)}`;
    const dashed = grouped.replaceAll(' ', '-');
    expect(redact(`card ${card}`)).toBe('card [CARD_1]');
    expect(redact(`card ${grouped}`)).toBe('card [CARD_1]');
    expect(redact(`card ${dashed}`)).toBe('card [CARD_1]');
    expect(amex).toHaveLength(15);
    expect(redact(`amex ${amex.slice(0, 4)} ${amex.slice(4, 10)} ${amex.slice(10)}`)).toBe(
      'amex [CARD_1]',
    );
  });

  it('does not redact 16 digits that fail Luhn', () => {
    const bad = `${card.slice(0, 15)}${String((Number(card[15]) + 1) % 10)}`;
    expect(redact(`ref ${bad}`)).toBe(`ref ${bad}`);
  });

  it('does not read a list of ordinary numbers as a card', () => {
    expect(redact('qty 12 34 56 78 90 12 34 total')).toBe('qty 12 34 56 78 90 12 34 total');
  });

  it('prefers the Thai ID reading of 13 valid digits', () => {
    expect(redact(ID)).toBe('[THAI_ID_1]');
  });
});

describe('bank accounts [ASSUMED formats]', () => {
  it.each([
    ['โอนเข้า 123-4-56789-0 ครับ', 'โอนเข้า [BANK_1] ครับ'],
    ['acct 123-456789-0', 'acct [BANK_1]'],
    ['เลขที่บัญชี 1234567890 ธนาคาร', 'เลขที่บัญชี [BANK_1] ธนาคาร'],
    ['บัญชีธนาคารกสิกรไทย 123 4 56789 0', 'บัญชีธนาคารกสิกรไทย [BANK_1]'],
    ['Account No: 1234567890', 'Account No: [BANK_1]'],
    ['a/c 123456789012', 'a/c [BANK_1]'],
  ])('redacts %j', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('redacts a bare 10-digit number: any run of 10 to 15 digits is treated as a phone (N4)', () => {
    expect(redact('invoice 1234567890')).toBe('invoice [PHONE_1]');
  });
});

describe('phone numbers written without a plus sign, and encoded addresses (T-137 review)', () => {
  it.each([
    ['call 66812345678 now', 'call [PHONE_1] now'],
    ['call 6621234567', 'call [PHONE_1]'],
    ['call 66 81 234 5678', 'call [PHONE_1]'],
    ['call 4155552671 now', 'call [PHONE_1] now'],
    ['call 415-555-2671 now', 'call [PHONE_1] now'],
    ['mail a%40corp.example', 'mail [EMAIL_1]'],
    ['mailto:a%40corp.example?subject=x', 'mailto:[EMAIL_1]?subject=x'],
    ['q=somchai.j%40example.co.th&x=1', 'q=[EMAIL_1]&x=1'],
    ['q=A%40Corp.Example', 'q=[EMAIL_1]'],
  ])('redacts %j', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('numbers an encoded address and a plain one of the same mailbox as one', () => {
    expect(redact('a@corp.example and a%40corp.example')).toBe('[EMAIL_1] and [EMAIL_2]');
  });

  // Any run of 10 to 15 digits is a phone number, whatever is written around it (T-137 review).
  const NUMBERS = [
    '66812345678',
    '14155552671',
    '447911123456',
    '4155552671',
    '0812345678',
    '12025550123',
    '6621234567',
    '819012345678',
    '123456789012345',
  ];
  const PREFIXES = [
    '',
    '+',
    '%2B',
    '%2b',
    'msisdn_',
    'phone=',
    'tel:',
    'x',
    'a1-',
    '(',
    '#',
    'id:',
    '%20',
    'โทร',
  ];
  const SUFFIXES = ['', ' ', '.', ',', '_x', 'abc', ')', ';', '%20', '\n', '&x=1', 'ครับ'];

  it('redacts a run of 10 to 15 digits with any prefix and any suffix', () => {
    for (const number of NUMBERS) {
      for (const prefix of PREFIXES) {
        for (const suffix of SUFFIXES) {
          const input = `call ${prefix}${number}${suffix} now`;
          const out = redact(input);
          expect(out, input).not.toContain(number);
          // A run that happens to pass the national ID checksum is an ID; either way it is gone.
          expect(out, input).toMatch(/\[(?:PHONE|THAI_ID)_\d+\]/);
        }
      }
    }
  });

  it('redacts a run written with spaces or dashes', () => {
    for (const input of ['66 81 234 5678', '1-415-555-2671', '44 7911 123456', '415 555 2671']) {
      expect(redact(`call ${input} now`), input).toBe('call [PHONE_1] now');
    }
  });

  it('has no exception for a ticket key whose digits could be a phone number', () => {
    // A ticket number has fewer than 10 digits, so a key never needs one; a "key" with a phone in it is a phone.
    for (const [input, expected] of [
      ['TEL-66812345678', 'TEL-[PHONE_1]'],
      ['TEL-415-555-2671', 'TEL-[PHONE_1]'],
      ['OPS-66812345678', 'OPS-[PHONE_1]'],
      ['OPS-4155552671-1', 'OPS-[PHONE_1]-1'],
      ['ORD-2026-000123', 'ORD-[PHONE_1]'],
      ['WT-20261031-0042', 'WT-[PHONE_1]'],
    ] as const) {
      expect(redact(input), input).toBe(expected);
    }
  });

  it('leaves ticket keys, uuids, trace ids, timestamps and short numbers alone', () => {
    for (const text of [
      'see OPS-1234 and OPS-98765',
      'id a0000000-4155-4000-8000-4155552671ab',
      'trace 4bf92f3577b34da6a3ce929d0e0e4736 span 00f067aa0ba902b7',
      'at 2026-11-02T10:15:30.123456789Z and 2026-11-02 10:15:30,123+07:00',
      'order 1234 total 6600 qty 12 34 56 78 90',
      'port 66 and 4155 and 2671 and 123456789',
      'at 2026-11-02 10:15',
      'version 4.155.552',
      'no mail here: 50% off 40 items',
      'a%4 b%40 c',
    ]) {
      expect(redact(text), text).toBe(text);
    }
  });
});

describe('names from the dictionary', () => {
  it('redacts Thai and Latin names, whole and by part', () => {
    expect(redact('สวัสดีคุณสมชาย ใจดี ครับ')).toBe('สวัสดีคุณ[NAME_1] ครับ');
    expect(redact('คุณสมชายแจ้งว่า')).toBe('คุณ[NAME_1]แจ้งว่า');
    expect(redact('Hi nattaya wong, and Wong again')).toBe('Hi [NAME_1], and [NAME_2] again');
  });

  it('uses word boundaries for Latin names and ignores names that are too short', () => {
    const local = createRedactor({ names: () => ['Ann', 'Jo'] });
    const out = local
      .session({ scope: 'ticket:test' })
      .redact('Ann met Annabel and Jo joined; Joanna stayed');
    expect(out).toBe('[NAME_1] met Annabel and Jo joined; Joanna stayed');
  });

  it('picks up new dictionary entries for the next session', () => {
    const names = ['Somsri'];
    const dynamic = createRedactor({ names: () => names });
    expect(dynamic.session({ scope: 'ticket:test' }).redact('Somsri and Prasert')).toBe(
      '[NAME_1] and Prasert',
    );
    names.push('Prasert');
    expect(dynamic.session({ scope: 'ticket:test' }).redact('Somsri and Prasert')).toBe(
      '[NAME_1] and [NAME_2]',
    );
  });

  it('escapes regex characters in names', () => {
    const local = createRedactor({ names: () => ['A.B. (Cho)'], matchNameParts: false });
    expect(local.session({ scope: 'ticket:test' }).redact('from A.B. (Cho) today')).toBe(
      'from [NAME_1] today',
    );
  });
});

describe('false-positive guards', () => {
  it.each([
    '2026-10-31',
    '31/10/2026',
    '31/10/2569',
    '2026-10-31 21:01:00',
    '20261031',
    '2026-10-31T21:01:00+07:00',
    'TKT-0000123',
    '#10234567',
    'v1.2.3-rc.1',
    'port 4000 and 5432',
    'SLA 99.95% within 15 min',
    'ราคา 1,234,567.89 บาท',
    'ปี ๒๕๖๙ วันที่ ๓๑ ตุลาคม',
    '10.0.0.1',
    'user_id=42&page=3',
  ])('leaves %j alone', (text) => {
    expect(redact(text)).toBe(text);
  });
});

describe('mapping and restore', () => {
  it('restores originals from the session', () => {
    const session = redactor.session({ scope: 'ticket:test' });
    const text = `คุณสมชาย ใจดี โทร 0812345678 อีเมล a@b.com บัตร ${ID}`;
    const redacted = session.redact(text);
    expect(redacted).toBe('คุณ[NAME_1] โทร [PHONE_1] อีเมล [EMAIL_1] บัตร [THAI_ID_1]');
    expect(session.restore(redacted)).toEqual({ text, needsReview: false, unresolved: [] });
    const unknown = session.restore('answer for [EMAIL_1] and [PHONE_9]');
    expect(unknown.text).toBe('answer for a@b.com and [PHONE_9]');
    expect(unknown).toMatchObject({ needsReview: true, unresolved: ['[PHONE_9]'] });
  });

  it('keeps the original values out of the redacted text', () => {
    const session = redactor.session({ scope: 'ticket:test' });
    const redacted = session.redact(`mail a@b.com or call 0812345678 (${ID})`);
    for (const entry of Object.values(session.snapshot().tokens)) {
      expect(redacted).not.toContain(entry.value);
    }
  });

  it('can restore in a later session from a stored snapshot, and continues numbering', () => {
    const first = redactor.session({ scope: 'ticket:test' });
    first.redact('a@b.com');
    const later = redactor.session({ scope: 'ticket:test', snapshot: first.snapshot() });
    expect(later.restore('hello [EMAIL_1]').text).toBe('hello a@b.com');
    expect(later.redact('c@d.com a@b.com')).toBe('[EMAIL_2] [EMAIL_1]');
  });

  it('refuses a snapshot from another scope', () => {
    const first = redactor.session({ scope: 'ticket:one' });
    first.redact('a@b.com');
    expect(() => redactor.session({ scope: 'ticket:two', snapshot: first.snapshot() })).toThrow(
      RedactionScopeError,
    );
  });

  it('escapes token-shaped input so a restore cannot expand it', () => {
    const session = redactor.session({ scope: 'ticket:test' });
    const text = 'literal [EMAIL_1] next to a@b.com';
    const redacted = session.redact(text);
    expect(redacted).toBe('literal [LITERAL_1] next to [EMAIL_1]');
    expect(session.restore(redacted).text).toBe(text);
  });

  it('reports counts without original values', () => {
    const session = redactor.session({ scope: 'ticket:test' });
    session.redact('a@b.com a@b.com 0812345678');
    const report = session.report();
    expect(report).toEqual({ total: 3, byKind: { EMAIL: 2, PHONE: 1 } });
    expect(JSON.stringify(report)).not.toContain('b.com');
  });

  it('reports a total of zero for clean text', () => {
    const session = redactor.session({ scope: 'ticket:test' });
    session.redact('nothing to see');
    expect(session.report()).toEqual({ total: 0, byKind: {} });
  });

  it('refuses input over the size limit instead of scanning it', () => {
    const small = createRedactor({ maxInputChars: 100 });
    expect(() => small.session({ scope: 's' }).redact('x'.repeat(101))).toThrow(
      RedactionInputTooLargeError,
    );
  });
});

// Property-style tests with a seeded generator (no extra dependency, reproducible failures).
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('properties (seeded)', () => {
  const FILLER = [
    'สวัสดีครับ',
    'ปัญหาเรื่องระบบ',
    'please check',
    ' ',
    '\n',
    ', ',
    '2026-10-31',
    'ORD-2026-000123',
    '[EMAIL_1]',
    '[BOGUS]',
    '[NAME_99]',
    '๑๒๓',
    '<b>',
    '😀',
    '$&',
  ];

  function digits(random: () => number, count: number): string {
    let out = '';
    for (let i = 0; i < count; i += 1) out += String(Math.floor(random() * 10));
    return out;
  }

  function pii(random: () => number): string {
    const kind = Math.floor(random() * 5);
    if (kind === 0) return `user${digits(random, 4)}@mail${digits(random, 2)}.example.com`;
    if (kind === 1) return `08${digits(random, 1)}${digits(random, 7)}`;
    if (kind === 2) return thaiId(`${String(1 + Math.floor(random() * 8))}${digits(random, 11)}`);
    if (kind === 3) return luhnCard(`4${digits(random, 14)}`);
    return `+66 8${digits(random, 1)} ${digits(random, 3)} ${digits(random, 4)}`;
  }

  function sample(random: () => number): { text: string; secrets: string[] } {
    const secrets: string[] = [];
    let text = '';
    const pieces = 3 + Math.floor(random() * 10);
    for (let i = 0; i < pieces; i += 1) {
      if (random() < 0.4) {
        const secret = pii(random);
        secrets.push(secret);
        // Always separate PII from other digits so a neighbour cannot change its shape.
        text += ` ${secret} `;
      } else {
        text += FILLER[Math.floor(random() * FILLER.length)] ?? '';
      }
    }
    return { text, secrets };
  }

  it('restore(redact(x)) === x', () => {
    const random = mulberry32(20261031);
    for (let run = 0; run < 400; run += 1) {
      const { text } = sample(random);
      const session = redactor.session({ scope: 'ticket:test' });
      expect(session.restore(session.redact(text), 'internal').text).toBe(text);
    }
  });

  it('never leaves a generated PII value in the output', () => {
    const random = mulberry32(7);
    for (let run = 0; run < 400; run += 1) {
      const { text, secrets } = sample(random);
      const out = redactor.session({ scope: 'ticket:test' }).redact(text);
      for (const secret of secrets) expect(out).not.toContain(secret);
    }
  });

  it('is deterministic and idempotent on its own output shape', () => {
    const random = mulberry32(99);
    for (let run = 0; run < 200; run += 1) {
      const { text } = sample(random);
      const out = redactor.session({ scope: 'ticket:test' }).redact(text);
      expect(redactor.session({ scope: 'ticket:test' }).redact(text)).toBe(out);
      // A second pass over the output only escapes its tokens; it round-trips and adds no PII kinds.
      const again = redactor.session({ scope: 'ticket:test' });
      expect(again.restore(again.redact(out), 'internal').text).toBe(out);
      expect(Object.keys(again.report().byKind).filter((kind) => kind !== 'LITERAL')).toEqual([]);
    }
  });

  it('does not throw on arbitrary unicode', () => {
    const random = mulberry32(5);
    for (let run = 0; run < 200; run += 1) {
      let text = '';
      for (let i = 0; i < 60; i += 1) text += String.fromCodePoint(Math.floor(random() * 0x2fff));
      expect(() => redactor.session({ scope: 'ticket:test' }).redact(text)).not.toThrow();
    }
  });
});
