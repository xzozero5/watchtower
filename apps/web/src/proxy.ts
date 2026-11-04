import { NextResponse, type NextRequest } from 'next/server';

import { contentSecurityPolicy } from '@/lib/csp';
import { readRuntimeConfig } from '@/lib/runtime-config';

/** A new unpredictable value for every response (the Next.js CSP guide uses a UUID in base64). */
export function newNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString('base64');
}

/**
 * Sends the Content-Security-Policy (T-125 C-5). It runs per request, so the policy has a nonce that
 * is new each time and `connect-src` follows `API_URL` as it is NOW, not as it was when the image was
 * built (ADR-001). The same policy goes on the request too: that is how Next.js learns the nonce and
 * puts it on its own scripts, and the root layout reads `x-nonce` for the theme bootstrap script.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const policy = contentSecurityPolicy({
    apiUrl: readRuntimeConfig().apiUrl,
    development: process.env.NODE_ENV === 'development',
    nonce,
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  // Not the build output (hashed, immutable files) nor the image optimiser: they are not documents.
  matcher: [
    {
      source: '/((?!_next/static|_next/image).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
