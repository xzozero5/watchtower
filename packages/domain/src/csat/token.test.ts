import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { mintCsatToken, verifyCsatToken, wholeSeconds } from './token.js';

const KEY = randomBytes(32);
const NOW = new Date('2030-03-15T12:00:00.000Z');
const IN_A_DAY = new Date(NOW.getTime() + 24 * 3600 * 1000);

describe('survey link', () => {
  it('verifies and returns the survey id and expiry it was minted for', () => {
    const id = randomUUID();
    const token = mintCsatToken(KEY, id, IN_A_DAY);
    expect(verifyCsatToken(KEY, token, NOW)).toEqual({ surveyId: id, expiresAt: IN_A_DAY });
  });

  it('is deterministic, so a reminder can derive the same link without storing it', () => {
    const id = randomUUID();
    expect(mintCsatToken(KEY, id, IN_A_DAY)).toBe(mintCsatToken(KEY, id, IN_A_DAY));
    expect(mintCsatToken(KEY, id, IN_A_DAY)).not.toBe(mintCsatToken(KEY, randomUUID(), IN_A_DAY));
  });

  it('expires at the signed instant', () => {
    const token = mintCsatToken(KEY, randomUUID(), IN_A_DAY);
    expect(verifyCsatToken(KEY, token, new Date(IN_A_DAY.getTime() - 1000))).not.toBeNull();
    expect(verifyCsatToken(KEY, token, IN_A_DAY)).toBeNull();
    expect(verifyCsatToken(KEY, token, new Date(IN_A_DAY.getTime() + 1))).toBeNull();
  });

  it('refuses a link signed with another key', () => {
    const token = mintCsatToken(randomBytes(32), randomUUID(), IN_A_DAY);
    expect(verifyCsatToken(KEY, token, NOW)).toBeNull();
  });

  it('refuses a link whose survey id or expiry was changed', () => {
    const token = mintCsatToken(KEY, randomUUID(), IN_A_DAY);
    const parts = token.split('.');
    const otherId = mintCsatToken(KEY, randomUUID(), IN_A_DAY).split('.')[1] ?? '';
    expect(verifyCsatToken(KEY, [parts[0], otherId, parts[2], parts[3]].join('.'), NOW)).toBeNull();
    const later = (Math.floor(IN_A_DAY.getTime() / 1000) + 86_400).toString(36);
    expect(verifyCsatToken(KEY, [parts[0], parts[1], later, parts[3]].join('.'), NOW)).toBeNull();
  });

  it.each(['', 'x', 'wtc1', 'wtc1.a.b.c', 'wtp1.abc.def.ghi', `${'a'.repeat(5000)}`])(
    'refuses malformed input %#',
    (token) => {
      expect(verifyCsatToken(KEY, token, NOW)).toBeNull();
    },
  );

  it('does not accept a portal tracking link (a different prefix and key purpose)', () => {
    const id = randomUUID().replaceAll('-', '');
    expect(
      verifyCsatToken(KEY, `wtp1.${id}.zzzzzz.${'A'.repeat(22)}.${'B'.repeat(43)}`, NOW),
    ).toBeNull();
  });

  it('wholeSeconds drops the milliseconds so the stored expiry mints the same link', () => {
    const id = randomUUID();
    const exact = new Date(IN_A_DAY.getTime() + 789);
    expect(mintCsatToken(KEY, id, wholeSeconds(exact))).toBe(mintCsatToken(KEY, id, exact));
    expect(wholeSeconds(exact).getTime() % 1000).toBe(0);
  });
});
