import { describe, expect, it } from 'vitest';

import { TicketKeys } from './ticket-keys.js';

describe('TicketKeys', () => {
  it('formats and parses with the configured prefix', () => {
    const keys = new TicketKeys('SUP');
    expect(keys.format(1234)).toBe('SUP-1234');
    expect(keys.format(7n)).toBe('SUP-7');
    expect(keys.parse('SUP-1234')).toBe(1234);
    expect(keys.parse(' sup-9 ')).toBe(9);
  });

  it('does not read a key of another prefix, or anything that is not a key', () => {
    const keys = new TicketKeys('SUP');
    for (const value of ['OPS-1', 'SUP-', 'SUP-0', 'SUP-1a', '1234', 'SUP1-5', '']) {
      expect(keys.parse(value)).toBeNull();
    }
  });
});
