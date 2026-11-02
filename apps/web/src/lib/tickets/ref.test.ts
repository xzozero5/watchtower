import { describe, expect, it } from 'vitest';

import { parseTicketRef } from './ref';

describe('parseTicketRef', () => {
  it('accepts a bare number, a hash number and a full key', () => {
    expect(parseTicketRef('1003', 'OPS')).toEqual({ key: 'OPS-1003', number: 1003 });
    expect(parseTicketRef(' #1003 ', 'OPS')?.key).toBe('OPS-1003');
    expect(parseTicketRef('OPS-1003', 'OPS')?.key).toBe('OPS-1003');
  });

  it('keeps a prefix the person typed', () => {
    expect(parseTicketRef('abc-7', 'OPS')?.key).toBe('ABC-7');
  });

  it('refuses words, zero and mixed text', () => {
    for (const text of ['login', '0', '12 34', 'OPS-', '', 'hello 12']) {
      expect(parseTicketRef(text, 'OPS')).toBeNull();
    }
  });
});
