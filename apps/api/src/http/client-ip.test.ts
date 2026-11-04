import { describe, expect, it } from 'vitest';

import { rateLimitClientKey } from './client-ip.js';

describe('rateLimitClientKey (T-207a C-3)', () => {
  it('keeps an IPv4 address as it is, and reads an IPv4-mapped one as IPv4', () => {
    expect(rateLimitClientKey('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitClientKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('puts every address of one /64 under one key, and different /64s under different ones', () => {
    const a = rateLimitClientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    const b = rateLimitClientKey('2001:0db8:0001:0002::1');
    const c = rateLimitClientKey('2001:DB8:1:2:ffff:ffff:ffff:ffff');
    expect(a).toBe('2001:db8:1:2::/64');
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(rateLimitClientKey('2001:db8:1:3::1')).not.toBe(a);
  });

  it('handles the compressed forms', () => {
    expect(rateLimitClientKey('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitClientKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitClientKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('gives a missing or unreadable address one shared key', () => {
    expect(rateLimitClientKey(null)).toBe('unknown');
    expect(rateLimitClientKey(undefined)).toBe('unknown');
    expect(rateLimitClientKey('')).toBe('unknown');
    expect(rateLimitClientKey('unknown')).toBe('unknown');
  });
});
