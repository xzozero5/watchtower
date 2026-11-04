import { describe, expect, it } from 'vitest';

import { scrubGoldenIdentifiers } from './golden-scrub.js';

describe('scrubGoldenIdentifiers (C-8)', () => {
  it('replaces the organization name and its aliases, longest first, any case', () => {
    const out = scrubGoldenIdentifiers('Dear ACME Holdings Ltd team, thanks from acme.', [
      'Acme',
      'Acme Holdings Ltd',
    ]);
    expect(out).toBe('Dear [ORG] team, thanks from [ORG].');
  });

  it('replaces contract numbers, ids with a separator and money amounts', () => {
    const out = scrubGoldenIdentifiers(
      'Under contract no. CT-2024-0091 we charged 12,500 baht, then ฿1,200.50 and $5,000; ref INV-000123.',
      [],
    );
    expect(out).not.toMatch(/CT-2024|0091|12,500|1,200|5,000|INV-000123/);
    expect(out).toContain('[CONTRACT_ID]');
    expect(out).toContain('[AMOUNT]');
  });

  it('handles Thai wording and leaves ordinary text alone', () => {
    const out = scrubGoldenIdentifiers(
      'สัญญาเลขที่ AB-123456 ยอด 5,000 บาท ขออภัยในความไม่สะดวก',
      [],
    );
    expect(out).toBe('[CONTRACT_ID] ยอด [AMOUNT] ขออภัยในความไม่สะดวก');
    expect(scrubGoldenIdentifiers('Please restart the service and try again.', ['Acme'])).toBe(
      'Please restart the service and try again.',
    );
  });

  it('ignores names shorter than three characters and escapes the rest', () => {
    expect(scrubGoldenIdentifiers('a ab (c)', ['a', 'ab'])).toBe('a ab (c)');
    expect(scrubGoldenIdentifiers('Foo (Thailand) Co.', ['Foo (Thailand) Co.'])).toBe('[ORG]');
  });
});
