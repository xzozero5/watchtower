import { describe, expect, it } from 'vitest';

import config, { PERMISSIONS_POLICY, securityHeaders } from '../next.config';

// The security headers of the web app (T-010 C-5). The directives are asserted one by one so a
// loosened policy shows up as a failing line, not as a changed string.

describe('securityHeaders', () => {
  const byKey = new Map(securityHeaders().map((h) => [h.key, h.value]));

  it('sends the full set', () => {
    // No Content-Security-Policy here: src/proxy.ts sends it, with a nonce per response (T-125 C-5).
    expect([...byKey.keys()].sort()).toEqual([
      'Permissions-Policy',
      'Referrer-Policy',
      'X-Content-Type-Options',
      'X-Frame-Options',
    ]);
    expect(byKey.get('X-Content-Type-Options')).toBe('nosniff');
    expect(byKey.get('X-Frame-Options')).toBe('DENY');
    expect(byKey.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('switches off the features the app never uses', () => {
    expect(byKey.get('Permissions-Policy')).toBe(PERMISSIONS_POLICY);
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment']) {
      expect(PERMISSIONS_POLICY).toContain(`${feature}=()`);
    }
  });
});

describe('next.config headers()', () => {
  it('applies the security headers to every path and keeps the service worker uncached', async () => {
    const rules = await config.headers?.();
    const all = rules?.find((rule) => rule.source === '/:path*');
    expect(all?.headers.map((header) => header.key)).toContain('X-Frame-Options');
    expect(all?.headers.map((header) => header.key)).not.toContain('Content-Security-Policy');
    const worker = rules?.find((rule) => rule.source === '/sw.js');
    expect(worker?.headers.find((header) => header.key === 'Cache-Control')?.value).toContain(
      'no-store',
    );
  });

  it('never caches the public portal or the CSAT survey page and never sends a Referer from them', async () => {
    const rules = await config.headers?.();
    for (const source of ['/portal/:path*', '/csat/:path*']) {
      const rule = rules?.find((entry) => entry.source === source);
      const byKey = new Map(rule?.headers.map((header) => [header.key, header.value]));
      expect(byKey.get('Cache-Control'), source).toBe('no-store');
      expect(byKey.get('Referrer-Policy'), source).toBe('no-referrer');
    }
  });
});
