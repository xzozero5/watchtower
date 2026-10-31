import { describe, expect, it } from 'vitest';

import { createRedactor } from './redactor.js';
import { isLuhnValid, isValidThaiNationalId, toAsciiDigits } from './validators.js';

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
const redact = (text: string) => redactor.session().redact(text);

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
    expect(toAsciiDigits('๐๘๑-๒๓๔-๕๖๗๘')).toBe('081-234-5678');
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

  it('redacts Thai-digit IDs', () => {
    const thaiDigits = ID.replace(/\d/g, (digit) => String.fromCharCode(0x0e50 + Number(digit)));
    expect(redact(`บัตร ${thaiDigits}`)).toBe('บัตร [THAI_ID_1]');
  });

  it('does not redact 13 digits that fail the checksum', () => {
    const wrong = `${ID.slice(0, 12)}${String((Number(ID[12]) + 1) % 10)}`;
    expect(redact(`order ${wrong}`)).toBe(`order ${wrong}`);
  });

  it('does not match inside a longer digit run', () => {
    expect(redact(`ref ${ID}9`)).toBe(`ref ${ID}9`);
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

  it('leaves bare 10-digit numbers without context alone when they are not phone-shaped', () => {
    expect(redact('invoice 1234567890')).toBe('invoice 1234567890');
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
    const out = local.session().redact('Ann met Annabel and Jo joined; Joanna stayed');
    expect(out).toBe('[NAME_1] met Annabel and Jo joined; Joanna stayed');
  });

  it('picks up new dictionary entries for the next session', () => {
    const names = ['Somsri'];
    const dynamic = createRedactor({ names: () => names });
    expect(dynamic.session().redact('Somsri and Prasert')).toBe('[NAME_1] and Prasert');
    names.push('Prasert');
    expect(dynamic.session().redact('Somsri and Prasert')).toBe('[NAME_1] and [NAME_2]');
  });

  it('escapes regex characters in names', () => {
    const local = createRedactor({ names: () => ['A.B. (Cho)'], matchNameParts: false });
    expect(local.session().redact('from A.B. (Cho) today')).toBe('from [NAME_1] today');
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
    'ORD-2026-000123',
    'TKT-0000123',
    'WT-20261031-0042',
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
  it('restores originals from the mapping', () => {
    const session = redactor.session();
    const text = `คุณสมชาย ใจดี โทร 0812345678 อีเมล a@b.com บัตร ${ID}`;
    const redacted = session.redact(text);
    expect(redacted).toBe('คุณ[NAME_1] โทร [PHONE_1] อีเมล [EMAIL_1] บัตร [THAI_ID_1]');
    expect(session.restore(redacted)).toBe(text);
    expect(session.restore('answer for [EMAIL_1] and [PHONE_9]')).toBe(
      'answer for a@b.com and [PHONE_9]',
    );
  });

  it('keeps the mapping out of the redacted text', () => {
    const session = redactor.session();
    const redacted = session.redact(`mail a@b.com or call 0812345678 (${ID})`);
    for (const original of Object.values(session.mapping())) {
      expect(redacted).not.toContain(original);
    }
  });

  it('can restore in a later session from a stored mapping, and continues numbering', () => {
    const first = redactor.session();
    first.redact('a@b.com');
    const later = redactor.session(first.mapping());
    expect(later.restore('hello [EMAIL_1]')).toBe('hello a@b.com');
    expect(later.redact('c@d.com a@b.com')).toBe('[EMAIL_2] [EMAIL_1]');
  });

  it('escapes token-shaped input so a restore cannot expand it', () => {
    const session = redactor.session();
    const text = 'literal [EMAIL_1] next to a@b.com';
    const redacted = session.redact(text);
    expect(redacted).toBe('literal [LITERAL_1] next to [EMAIL_1]');
    expect(session.restore(redacted)).toBe(text);
  });

  it('reports counts without original values', () => {
    const session = redactor.session();
    session.redact('a@b.com a@b.com 0812345678');
    const report = session.report();
    expect(report).toEqual({ total: 3, byKind: { EMAIL: 2, PHONE: 1 } });
    expect(JSON.stringify(report)).not.toContain('b.com');
  });

  it('reports a total of zero for clean text', () => {
    const session = redactor.session();
    session.redact('nothing to see');
    expect(session.report()).toEqual({ total: 0, byKind: {} });
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
      const session = redactor.session();
      expect(session.restore(session.redact(text))).toBe(text);
    }
  });

  it('never leaves a generated PII value in the output', () => {
    const random = mulberry32(7);
    for (let run = 0; run < 400; run += 1) {
      const { text, secrets } = sample(random);
      const out = redactor.session().redact(text);
      for (const secret of secrets) expect(out).not.toContain(secret);
    }
  });

  it('is deterministic and idempotent on its own output shape', () => {
    const random = mulberry32(99);
    for (let run = 0; run < 200; run += 1) {
      const { text } = sample(random);
      const out = redactor.session().redact(text);
      expect(redactor.session().redact(text)).toBe(out);
      // A second pass over the output only escapes its tokens; it round-trips and adds no PII kinds.
      const again = redactor.session();
      expect(again.restore(again.redact(out))).toBe(out);
      expect(Object.keys(again.report().byKind).filter((kind) => kind !== 'LITERAL')).toEqual([]);
    }
  });

  it('does not throw on arbitrary unicode', () => {
    const random = mulberry32(5);
    for (let run = 0; run < 200; run += 1) {
      let text = '';
      for (let i = 0; i < 60; i += 1) text += String.fromCodePoint(Math.floor(random() * 0x2fff));
      expect(() => redactor.session().redact(text)).not.toThrow();
    }
  });
});
