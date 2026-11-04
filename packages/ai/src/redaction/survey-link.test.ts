import { describe, expect, it } from 'vitest';

import { createRedactor } from './redactor.js';

// T-171 review C-8: a survey link is a bearer token; a customer may quote it back in a reply, and
// it must not reach a model.
const redact = (text: string): string =>
  createRedactor({ names: () => [] })
    .session({ scope: 'ticket:test' })
    .redact(text);

const TOKEN =
  'wtc1.0123456789abcdef0123456789abcdef.lxyz12.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq';

describe('survey link tokens', () => {
  it('redacts the token inside a quoted survey URL', () => {
    const out = redact(`thanks https://help.example.test/csat#token=${TOKEN}&score=5 bye`);
    expect(out).toContain('[LINK_1]');
    expect(out).not.toContain('wtc1.');
    expect(out).not.toContain('ABCDEFGH');
  });

  it('redacts a bare token and several in one text', () => {
    const out = redact(`${TOKEN} and ${TOKEN}`);
    expect(out).not.toContain('wtc1.');
  });

  it('leaves text that only looks similar alone', () => {
    expect(redact('wtc1.short.x.y and wtc1. alone')).toBe('wtc1.short.x.y and wtc1. alone');
  });

  it('stays linear on a long run of the prefix', () => {
    const before = process.cpuUsage();
    redact('wtc1.'.repeat(40_000));
    const used = process.cpuUsage(before);
    expect((used.user + used.system) / 1000).toBeLessThan(1500);
  });
});
