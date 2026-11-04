import { describe, expect, it } from 'vitest';

import { domainOfAddress, externalDomains } from './recipients.js';

describe('domainOfAddress', () => {
  it('takes the part after the last @, lower-case', () => {
    expect(domainOfAddress('Ann@Example.COM')).toBe('example.com');
    expect(domainOfAddress('"a@b"@c.example')).toBe('c.example');
    expect(domainOfAddress('no-at-sign')).toBe('');
  });
});

describe('externalDomains', () => {
  const known = new Set(['customer.example', 'ops.example']);

  it('lists each domain outside the known set once, sorted', () => {
    expect(
      externalDomains(
        ['a@customer.example', 'x@Stranger.example', 'y@stranger.example', 'z@another.test'],
        known,
      ),
    ).toEqual(['another.test', 'stranger.example']);
  });

  it('is empty when every address is on a known domain', () => {
    expect(externalDomains(['a@customer.example', 'b@OPS.example'], known)).toEqual([]);
    expect(externalDomains([], known)).toEqual([]);
  });

  it('does not treat a look-alike or a subdomain as known', () => {
    expect(
      externalDomains(['a@customer.example.evil.test', 'b@mail.customer.example'], known),
    ).toEqual(['customer.example.evil.test', 'mail.customer.example']);
  });
});
