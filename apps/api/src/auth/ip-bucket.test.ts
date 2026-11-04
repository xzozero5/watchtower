import { describe, expect, it } from 'vitest';

import { ipBucket } from './ip-bucket.js';

describe('ipBucket (T-125 C-7)', () => {
  it('leaves an IPv4 address and a non-address alone', () => {
    expect(ipBucket('203.0.113.9')).toBe('203.0.113.9');
    expect(ipBucket('unknown')).toBe('unknown');
  });

  it('counts every address of an IPv6 /64 as one, written in full', () => {
    const bucket = '2001:0db8:0000:0001::/64';
    expect(ipBucket('2001:db8:0:1::1')).toBe(bucket);
    expect(ipBucket('2001:db8:0:1:aaaa:bbbb:cccc:dddd')).toBe(bucket);
    expect(ipBucket('2001:DB8:0:1::9')).toBe(bucket);
    expect(ipBucket('2001:db8:0:2::1')).toBe('2001:0db8:0000:0002::/64');
  });

  it('expands :: correctly at the start, the middle and the end', () => {
    expect(ipBucket('::1')).toBe('0000:0000:0000:0000::/64');
    expect(ipBucket('fe80::1%eth0')).toBe('fe80:0000:0000:0000::/64');
    expect(ipBucket('2001:db8::')).toBe('2001:0db8:0000:0000::/64');
    expect(ipBucket('1:2:3:4:5:6:7:8')).toBe('0001:0002:0003:0004::/64');
  });

  it('treats an IPv4-mapped IPv6 address as the IPv4 one', () => {
    expect(ipBucket('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(ipBucket('::ffff:cb00:7109')).toBe('203.0.113.9');
  });
});
