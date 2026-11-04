import { BlockList, isIP } from 'node:net';

/**
 * Addresses an outbound request made on behalf of a user-supplied URL must never reach (T-175, SSRF).
 * Everything that is not ordinary global unicast is refused: loopback, RFC 1918, carrier-grade NAT,
 * link-local (cloud metadata lives at 169.254.169.254 and fd00:ec2::254), documentation, benchmarking,
 * multicast, reserved, and the IPv6 forms that wrap an IPv4 address (mapped, NAT64, 6to4, Teredo),
 * because those can smuggle a private IPv4 past a check that only reads the text.
 *
 * IPv6 is an allow-list first: only global unicast `2000::/3` can pass at all (so `::ffff:0:0:0/96`,
 * `5f00::/16`, `fc00::/7` and everything else outside it is refused without being listed), then the
 * special-purpose ranges inside it are subtracted.
 */
const blocked4 = new BlockList();
const blocked6 = new BlockList(); // separate: a BlockList maps IPv4 onto ::ffff:0:0/96, which would block every IPv4 address

const allowed6 = new BlockList(); // used as an allow-list: an IPv6 address must be inside it
allowed6.addSubnet('2000::', 3, 'ipv6');

const IPV4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];
const IPV6: readonly (readonly [string, number])[] = [
  ['::', 96], // unspecified, loopback, IPv4-compatible
  ['::ffff:0:0', 96], // IPv4-mapped
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48],
  ['100::', 64], // discard-only
  ['2001::', 23], // Teredo and IETF assignments
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4
  ['3fff::', 20], // documentation (RFC 9637)
  ['fc00::', 7], // unique local (includes fd00:ec2::254)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];
for (const [net, prefix] of IPV4) blocked4.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of IPV6) blocked6.addSubnet(net, prefix, 'ipv6');

/** Brackets and an IPv6 zone id (`fe80::1%eth0`) are dropped before the check; the address decides. */
function strip(address: string): string {
  const inner = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const zone = inner.indexOf('%');
  return zone === -1 ? inner : inner.slice(0, zone);
}

/** True when the text is not a plain public IP address. Anything that does not parse as an IP is blocked. */
export function isBlockedAddress(address: string): boolean {
  const text = strip(address);
  const family = isIP(text);
  if (family === 0) return true;
  if (family === 4) return blocked4.check(text, 'ipv4');
  return !allowed6.check(text, 'ipv6') || blocked6.check(text, 'ipv6');
}

/** Host names that mean "this machine / the internal network" whatever DNS says. */
export function isInternalHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name.endsWith('.local') ||
    name.endsWith('.internal')
  );
}
