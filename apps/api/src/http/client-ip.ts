import { isIPv4, isIPv6 } from 'node:net';

/**
 * The key a client address is counted under in a rate limit (T-207a C-3). An IPv4 address is itself. An
 * IPv6 address is cut to its /64: that is the smallest block a provider hands to one subscriber, and a
 * single machine on it can use billions of addresses, so counting each one separately is no limit at all.
 * An IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) is the IPv4 address it carries. Anything that is not an
 * address (an empty value, `unknown`) is returned unchanged so it keeps one shared bucket.
 */
export function rateLimitClientKey(ip: string | null | undefined): string {
  if (ip === null || ip === undefined || ip === '') return 'unknown';
  const bare = ip.split('%')[0] ?? ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped?.[1] !== undefined && isIPv4(mapped[1])) return mapped[1];
  if (isIPv4(bare)) return bare;
  if (!isIPv6(bare)) return ip;
  const groups = expandIpv6(bare);
  if (groups === null) return ip;
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/** The eight 16-bit groups of an IPv6 address as lower-case hex without leading zeros, or null. */
function expandIpv6(address: string): string[] | null {
  let text = address.toLowerCase();
  // A dotted tail (`::1.2.3.4`) is two groups.
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail !== null) {
    const [, a = '0', b = '0', c = '0', d = '0'] = tail;
    const high = (Number(a) << 8) | Number(b);
    const low = (Number(c) << 8) | Number(d);
    text = `${text.slice(0, tail.index)}${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = (halves[0] ?? '') === '' ? [] : (halves[0] ?? '').split(':');
  const rest =
    halves.length === 2 ? ((halves[1] ?? '') === '' ? [] : (halves[1] ?? '').split(':')) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [
    ...head,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'),
    ...rest,
  ];
  if (all.length !== 8) return null;
  return all.map((group) => (Number.parseInt(group, 16) || 0).toString(16));
}
