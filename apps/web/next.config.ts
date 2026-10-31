import { join } from 'node:path';

import type { NextConfig } from 'next';

const config: NextConfig = {
  // Self-contained server for the Docker image (ADR-001: one image for compose and Cloud Run).
  output: 'standalone',
  // The monorepo root, so the trace includes workspace packages such as @watchtower/ui.
  outputFileTracingRoot: join(import.meta.dirname, '..', '..'),
  poweredByHeader: false,
  reactStrictMode: true,
  // No next/image optimiser: it needs sharp, and the app has no remote images yet.
  images: { unoptimized: true },
  // A content security policy comes with the security review (T-010); these are the safe basics.
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ]);
  },
};

export default config;
