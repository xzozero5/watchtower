import { describe, expect, it } from 'vitest';

import { isBlockedAddress, isInternalHostname } from './ip-guard.js';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '169.254.0.1',
    '100.64.0.1',
    '192.0.0.8',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    '[::1]',
    'fe80::1',
    'fe80::1%eth0',
    'fc00::1',
    'fd00:ec2::254',
    'fec0::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '2001:db8::1',
    '0000:0000:0000:0000:0000:0000:0000:0001',
    'not-an-ip',
    '',
  ])('refuses %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001:81b::200e',
  ])('allows the public address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('isInternalHostname', () => {
  it.each([
    'localhost',
    'LOCALHOST.',
    'a.localhost',
    'printer.local',
    'metadata.google.internal',
    'db.internal',
  ])('refuses %s', (name) => {
    expect(isInternalHostname(name)).toBe(true);
  });
  it.each(['example.com', 'localhost.example.com', 'internal.example.com'])('allows %s', (name) => {
    expect(isInternalHostname(name)).toBe(false);
  });
});
