import { join } from 'node:path';

import type { NextConfig } from 'next';

/** Features the app never uses are switched off for the page and everything it embeds. */
export const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()';

/**
 * The headers that do not depend on the request. The Content-Security-Policy is not here: it carries a
 * nonce that is new for every response and the api origin read at run time, so `src/proxy.ts` sends it
 * (T-125 C-5; the policy itself is in `src/lib/csp.ts`).
 */
export function securityHeaders(): { key: string; value: string }[] {
  return [
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
        headers: securityHeaders(),
      },
      {
        // The public client portal (T-007): tracking pages carry a ticket number, never cache them
        // and never send a Referer. Listed after the rule above, so these values win.
        source: '/portal/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
      {
        // The public CSAT survey page (T-110b): same rules as the portal.
        source: '/csat/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
      {
        // The public status page and its confirm and unsubscribe links (T-204b): the links carry a
        // signed token in the fragment, so never cache and never send a Referer.
        source: '/status/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ]);
  },
};

export default config;
