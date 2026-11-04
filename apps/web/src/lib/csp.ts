/**
 * Where the browser may connect to besides this origin: the api (`API_URL`), over http(s) and, for
 * the realtime socket, ws(s). Returns [] when `apiUrl` is absent or not an http(s) URL.
 */
export function apiConnectSources(apiUrl: string | undefined): string[] {
  const raw = apiUrl?.trim();
  if (!raw) return [];
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return [];
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return [];
  const socket = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return [parsed.origin, `${socket}//${parsed.host}`];
}

export interface PolicyOptions {
  /** `API_URL`: the api the browser calls. Without it the policy allows any http(s)/ws(s) host, see below. */
  readonly apiUrl?: string | undefined;
  /** `next dev` needs eval for React Refresh; a production build must not. */
  readonly development?: boolean;
  /**
   * A fresh random value for this response. With it `script-src` is `'self' 'nonce-…' 'strict-dynamic'`
   * and inline scripts without the nonce are refused; without it (tests, a caller that cannot make
   * one) the policy falls back to `'unsafe-inline'`.
   */
  readonly nonce?: string | undefined;
}

/**
 * The Content-Security-Policy of the web app (T-010 C-5, T-125). `src/proxy.ts` builds it for every
 * response, so the nonce is new each time and `connect-src` follows `API_URL` at **run** time.
 *
 *  - `script-src 'self' 'nonce-…' 'strict-dynamic'`: Next.js puts the nonce on the scripts it renders
 *    (it reads it from the request's CSP header) and the root layout puts it on the theme bootstrap;
 *    `'strict-dynamic'` lets those scripts load the chunks they need. An injected inline script has no
 *    nonce and does not run. Without a `nonce` option the old `'unsafe-inline'` fallback is used.
 *  - `style-src 'self' 'unsafe-inline'`: React sets inline styles.
 *  - `connect-src 'self' <API_URL>`: the browser calls the api directly, with cookies. `API_URL` is
 *    read per request by the proxy (ADR-001: a runtime setting). When it is absent or malformed the
 *    policy falls back to any http(s) and ws(s) host, which is the weakest part of this policy; the
 *    proxy always passes one (`readRuntimeConfig` has a default), so only a direct caller sees it.
 *  - `img-src 'self' data: blob:`, no remote images. `blob:` is for pictures the app fetches itself
 *    through the authenticated api and shows as object URLs (attachment thumbnails, inline `cid:`
 *    images in an email, which the email's srcdoc frame inherits this policy for); a blob URL can only
 *    be made by script on this origin. `object-src 'none'`, `base-uri 'self'`,
 *    `form-action 'self'`, `frame-ancestors 'none'`.
 *  - `worker-src 'self' blob:`: the portal proof-of-work may run in a Web Worker built from a Blob.
 */
export function contentSecurityPolicy(options: PolicyOptions = {}): string {
  const api = apiConnectSources(options.apiUrl);
  const connect =
    api.length > 0 ? ["'self'", ...api] : ["'self'", 'https:', 'http:', 'wss:', 'ws:'];
  const script = [
    "'self'",
    ...(options.nonce === undefined
      ? ["'unsafe-inline'"]
      : [`'nonce-${options.nonce}'`, "'strict-dynamic'"]),
    ...(options.development === true ? ["'unsafe-eval'"] : []),
  ];
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
