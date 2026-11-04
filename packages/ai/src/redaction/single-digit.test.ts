import { describe, expect, it } from 'vitest';

import { createRedactor } from './redactor.js';

// T-114a C-2: a number typed one digit at a time must not slip past the redactor.
const redact = (text: string): string =>
  createRedactor({ names: () => [] })
    .session({ scope: 'ticket:test' })
    .redact(text);

const join = (digits: string, sep: string): string => digits.split('').join(sep);

/** Independent Luhn completion: append the check digit to `base`. */
function luhn(base: string): string {
  let sum = 0;
  for (let i = 0; i < base.length; i += 1) {
    let d = Number(base[base.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return `${base}${String((10 - (sum % 10)) % 10)}`;
}

describe('digit-by-digit numbers', () => {
  it.each([' ', '.', '-', '  '])('redacts a mobile number separated by %j', (sep) => {
    const out = redact(`call ${join('0812345678', sep)} now`);
    expect(out).toContain('[PHONE_1]');
    expect(out).not.toMatch(/8\D*1\D*2\D*3/);
  });

  it('redacts a 9-digit Bangkok number', () => {
    expect(redact(join('021234567', ' '))).toBe('[PHONE_1]');
  });

  it.each([
    ['13 digits', luhn('422222222222')],
    ['16 digits', luhn('411111111111111')],
    ['19 digits', luhn('411111111111111111')],
  ])('redacts a Luhn-valid card (%s) one digit per group', (_name, card) => {
    const out = redact(`card ${join(card, ' ')} ok`);
    expect(out).toContain('[CARD_1]');
    expect(out).not.toMatch(/\d \d \d/);
  });

  it('leaves a short list of single digits alone', () => {
    expect(redact('1 2 3 4 5 6 7 8')).toBe('1 2 3 4 5 6 7 8');
  });

  it('stays linear on a long run of single digits', () => {
    const text = '0 8 1 2 3 4 5 6 7 '.repeat(10_000);
    const before = process.cpuUsage();
    redact(text);
    const used = process.cpuUsage(before);
    expect((used.user + used.system) / 1000).toBeLessThan(1500);
  });
});
