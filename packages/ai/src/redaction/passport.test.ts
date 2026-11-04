import { describe, expect, it } from 'vitest';

import { createRedactor } from './redactor.js';

// C-9 (owner decision 2026-11-04): passport numbers are redacted; staff names, IPs, addresses and
// LINE userIds are not.
const redact = (text: string): string =>
  createRedactor({ names: () => [] })
    .session({ scope: 'ticket:test' })
    .redact(text);

// ICAO 9303 specimen, TD3 line 2.
const ZWSP = String.fromCharCode(0x200b);
const MRZ2 = 'L898902C36UTO7408122F1204159ZE184226B<<<<<10';

describe('passport numbers with a cue', () => {
  it.each([
    ['my passport AA1234567 expired', 'my passport [PASSPORT_1] expired'],
    ['Passport No: AB1234567.', 'Passport No: [PASSPORT_1].'],
    ['passport number is X123456', 'passport number is [PASSPORT_1]'],
    ['PASSPORT # a12345678', 'PASSPORT # [PASSPORT_1]'],
    ['เลขที่หนังสือเดินทาง AA1234567 ครับ', 'เลขที่หนังสือเดินทาง [PASSPORT_1] ครับ'],
    ['พาสปอร์ต: AA 1234567', 'พาสปอร์ต: [PASSPORT_1]'],
    ['เลขพาสปอร์ต AA1234567', 'เลขพาสปอร์ต [PASSPORT_1]'],
  ])('redacts %s', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('reuses the placeholder for the same number', () => {
    expect(redact('passport AA1234567 and again passport AA1234567')).toBe(
      'passport [PASSPORT_1] and again passport [PASSPORT_1]',
    );
  });

  it('handles full-width, Thai digits and zero-width characters', () => {
    expect(redact('passport ＡＡ１２３４５６７')).toBe('passport [PASSPORT_1]');
    expect(redact('passport AA๑๒๓๔๕๖๗')).toBe('passport [PASSPORT_1]');
    expect(redact(`passport A${ZWSP}A12${ZWSP}34567`)).toBe('passport [PASSPORT_1]');
  });

  it('round-trips through restore', () => {
    const session = createRedactor({ names: () => [] }).session({ scope: 'ticket:test' });
    const out = session.redact('passport AA1234567');
    expect(session.restore(out).text).toBe('passport AA1234567');
  });
});

describe('passport false positives', () => {
  it.each([
    'ticket WT-1234567 and order AB1234567',
    'order id AA1234567 is late',
    'passport photo attached',
    'passport AA12345 (too short)',
    'passport 1234567 digits only',
    'passport ABC1234567',
    'the passport is expired',
  ])('leaves %s alone', (input) => {
    expect(redact(input)).toBe(input);
  });
});

describe('passport MRZ line 2', () => {
  it('redacts a valid TD3 line without a cue', () => {
    expect(redact(MRZ2)).toBe('[PASSPORT_1]');
    expect(redact(`P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\n${MRZ2}\nok`)).toContain(
      '\n[PASSPORT_1]\nok',
    );
  });

  it('leaves a 44-char line with a wrong check digit', () => {
    const bad = MRZ2.replace('L898902C36', 'L898902C37');
    expect(redact(bad)).toBe(bad);
  });

  it('survives full-width and zero-width evasion', () => {
    const wide = MRZ2.replace(/[A-Z0-9<]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
    expect(redact(wide)).toBe('[PASSPORT_1]');
    expect(redact(`${MRZ2.slice(0, 20)}${ZWSP}${MRZ2.slice(20)}`)).toBe('[PASSPORT_1]');
  });
});

describe('passport detection performance', () => {
  it.each([
    ['repeated cue', 'passport '.repeat(22_000)],
    ['cue and short code', 'passport AA12 '.repeat(14_000)],
    ['mrz alphabet', '1M<'.repeat(66_000)],
    ['digit run', '1'.repeat(200_000)],
  ])('stays linear on %s', (_name, text) => {
    const before = process.cpuUsage();
    redact(text);
    const used = process.cpuUsage(before);
    expect((used.user + used.system) / 1000).toBeLessThan(800);
  });
});
