/**
 * Which hosts a Web Push subscription may point at. The endpoint comes from a browser, that is from whoever
 * calls our API, so a forged subscription could make the worker send a request to any URL (SSRF). The
 * only defence that does not depend on DNS is to accept the few push services browsers use.
 *
 *  - FCM (Chrome, Chromium family, Android): `fcm.googleapis.com`             [VERIFY: secondary source]
 *  - Mozilla autopush (Firefox):             `updates.push.services.mozilla.com` [CONFIRMED: autopush docs, 2026-11-04]
 *  - Apple (Safari, iOS/iPadOS home screen): `*.push.apple.com`                [CONFIRMED: webkit.org, 2026-11-04]
 *  - Windows Notification Service (Edge):    `*.notify.windows.com`            [VERIFY: secondary source]
 *
 * A browser that uses another service is refused until its host is added here, on purpose.
 */
export const PUSH_HOST_EXACT: readonly string[] = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
];
export const PUSH_HOST_SUFFIXES: readonly string[] = ['.push.apple.com', '.notify.windows.com'];

export type EndpointRefusal = 'bad_url' | 'scheme' | 'credentials' | 'port' | 'host' | 'length';

export type EndpointCheck =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: EndpointRefusal };

export function isAllowedPushHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (PUSH_HOST_EXACT.includes(host)) return true;
  // What comes before the suffix must be plain DNS labels: `.push.apple.com` alone is no host.
  return PUSH_HOST_SUFFIXES.some(
    (suffix) =>
      host.endsWith(suffix) && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host.slice(0, -suffix.length)),
  );
}

/**
 * https only, default port only, no user info, an allow-listed host, at most 2048 characters. A literal IP
 * is never on the list, so private and loopback addresses are refused here before any DNS or address check.
 */
export function checkPushEndpoint(raw: string): EndpointCheck {
  if (raw.length > 2048) return { ok: false, reason: 'length' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'bad_url' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' };
  if (url.port !== '' && url.port !== '443') return { ok: false, reason: 'port' };
  if (!isAllowedPushHost(url.hostname)) return { ok: false, reason: 'host' };
  return { ok: true, url };
}
