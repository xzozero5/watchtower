import { describe, expect, it } from 'vitest';

import { generateLinkCode, hashLinkCode, parseLinkCode } from './line-link.js';

describe('link code format', () => {
  it('generates WT-XXXXX-XXXXX from an alphabet without look-alike characters', () => {
    for (let index = 0; index < 200; index += 1) {
      const code = generateLinkCode();
      expect(code).toMatch(/^WT-[2-9A-HJKMNP-TV-Z]{5}-[2-9A-HJKMNP-TV-Z]{5}$/);
      expect(code).not.toMatch(/[01OILU]/);
    }
    expect(new Set(Array.from({ length: 200 }, generateLinkCode)).size).toBe(200);
  });

  it('reads back what was generated, however the customer retypes it', () => {
    const code = generateLinkCode();
    expect(parseLinkCode(code)).toBe(code);
    expect(parseLinkCode(`  ${code.toLowerCase()}\n`)).toBe(code);
    expect(parseLinkCode(code.replaceAll('-', ' '))).toBe(code);
    expect(parseLinkCode(code.replaceAll('-', ''))).toBe(code);
  });

  it('does not take a sentence, a short text or another prefix for a code', () => {
    const code = generateLinkCode();
    expect(parseLinkCode(`my code is ${code}`)).toBeNull();
    expect(parseLinkCode(`${code} please`)).toBeNull();
    expect(parseLinkCode('WT-ABCDE')).toBeNull();
    expect(parseLinkCode(code.replace('WT', 'XX'))).toBeNull();
    // 0 and O are not in the alphabet.
    expect(parseLinkCode('WT-0OOOO-00000')).toBeNull();
    expect(parseLinkCode('')).toBeNull();
  });

  it('hashes to 64 hex characters and never to the code itself', () => {
    const code = generateLinkCode();
    expect(hashLinkCode(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLinkCode(code)).not.toContain(code);
    expect(hashLinkCode(code)).toBe(hashLinkCode(code));
    expect(hashLinkCode(code)).not.toBe(hashLinkCode(generateLinkCode()));
  });
});
