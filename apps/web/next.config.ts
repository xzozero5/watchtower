import { join } from 'node:path';

import type { NextConfig } from 'next';

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
}

/**
 * The Content-Security-Policy of the web app (T-010 C-5).
 *
 *  - `script-src 'self' 'unsafe-inline'`: the pages render inline scripts that no nonce covers (the
 *    theme bootstrap in the root layout and the data Next.js streams for hydration). A nonce or
 *    hash policy needs a request-time proxy (`src/proxy.ts`) that generates a nonce per response and
 *    makes every page dynamic; that file is outside this change, so this keeps `'unsafe-inline'` and
 *    relies on the rest of the policy. Follow-up: nonce-based `script-src` through a proxy, which
 *    also removes the need to know `API_URL` at build time (see `connect-src`). `[ASSUMED]`
 *  - `style-src 'self' 'unsafe-inline'`: React sets inline styles.
 *  - `connect-src 'self' <API_URL>`: the browser calls the api directly, with cookies. `API_URL` is
 *    a runtime setting (ADR-001) but Next.js evaluates `headers()` when it builds, so the value
 *    here is the `API_URL` present at **build** time. When it is absent the policy falls back to
 *    any http(s) and ws(s) host, which keeps a runtime-configured image working and is the weakest
 *    part of this policy. Build with `API_URL` set, or use the proxy follow-up, to pin it.
 *  - `img-src 'self' data:`, no remote images; `object-src 'none'`, `base-uri 'self'`,
 *    `form-action 'self'`, `frame-ancestors 'none'`.
 *  - `worker-src 'self' blob:`: the portal proof-of-work may run in a Web Worker built from a Blob.
 */
export function contentSecurityPolicy(options: PolicyOptions = {}): string {
  const api = apiConnectSources(options.apiUrl);
  const connect =
    api.length > 0 ? ["'self'", ...api] : ["'self'", 'https:', 'http:', 'wss:', 'ws:'];
  const script = [
    "'self'",
    "'unsafe-inline'",
    ...(options.development === true ? ["'unsafe-eval'"] : []),
  ];
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
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

/** Features the app never uses are switched off for the page and everything it embeds. */
export const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()';

export function securityHeaders(options: PolicyOptions = {}): { key: string; value: string }[] {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(options) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: PERMISSIONS_POLICY },
  ];
}

const config: NextConfig = {
  // Self-contained server for the Docker image (ADR-001: one image for compose and Cloud Run).
  output: 'standalone',
  // The monorepo root, so the trace includes workspace packages such as @watchtower/ui.
  outputFileTracingRoot: join(import.meta.dirname, '..', '..'),
  poweredByHeader: false,
  reactStrictMode: true,
  // No next/image optimiser: it needs sharp, and the app has no remote images yet.
  images: { unoptimized: true },
  headers() {
    return Promise.resolve([
      {
        // A service worker must never be served stale, or a bad one could not be replaced.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Type', value: 'text/javascript; charset=utf-8' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      {
        source: '/:path*',
        headers: securityHeaders({
          apiUrl: process.env.API_URL,
          development: process.env.NODE_ENV === 'development',
        }),
      },
    ]);
  },
};

export default config;
