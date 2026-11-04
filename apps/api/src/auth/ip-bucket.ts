import { isIP } from 'node:net';

/**
 * The key a client address is counted under by the sign-in limits (T-125 C-7). An IPv4 address is its
 * own key. An IPv6 address is counted as its /64: one subscriber is normally given a whole /64 (or
 * more), so counting single addresses would let one machine try a new address for every guess and
 * never meet a limit. The key is the first four groups in full, for example `2001:db8:0:1::/64`
 * becomes `2001:0db8:0000:0001::/64`. An IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) is the IPv4 one.
 * Anything that is not an IP address is returned unchanged (it is already 'unknown' or a test value).
 */
export function ipBucket(ip: string): string {
  const version = isIP(ip);
  if (version === 4) return ip;
  if (version !== 6) return ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1] !== undefined) return mapped[1];
  // Drop a zone (`fe80::1%eth0`), then expand `::` so that the groups can be counted.
  const [address = ''] = ip.split('%');
  const [head = '', tail] = address.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array.from({ length: missing }, () => '0'), ...tailGroups];
  // ::ffff:102:304 is the same IPv4-mapped address in hex form.
  if (
    groups.slice(0, 5).every((group) => /^0+$/.test(group)) &&
    /^0*ffff$/i.test(groups[5] ?? '')
  ) {
    const high = Number.parseInt(groups[6] ?? '0', 16);
    const low = Number.parseInt(groups[7] ?? '0', 16);
    return `${String(high >> 8)}.${String(high & 255)}.${String(low >> 8)}.${String(low & 255)}`;
  }
  const prefix = groups.slice(0, 4).map((group) => group.toLowerCase().padStart(4, '0'));
  return `${prefix.join(':')}::/64`;
}
