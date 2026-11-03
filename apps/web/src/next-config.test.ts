import { describe, expect, it } from 'vitest';

import config, {
  PERMISSIONS_POLICY,
  apiConnectSources,
  contentSecurityPolicy,
  securityHeaders,
} from '../next.config';

// The security headers of the web app (T-010 C-5). The directives are asserted one by one so a
// loosened policy shows up as a failing line, not as a changed string.

function directives(policy: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name, values);
  }
  return map;
}

describe('apiConnectSources', () => {
  it('gives the origin of the api and its websocket twin', () => {
    expect(apiConnectSources('http://127.0.0.1:4999')).toEqual([
      'http://127.0.0.1:4999',
      'ws://127.0.0.1:4999',
    ]);
    expect(apiConnectSources('https://api.example.com/v1/')).toEqual([
      'https://api.example.com',
      'wss://api.example.com',
    ]);
    // A path (the api behind Caddy at /api) is not part of an origin.
    expect(apiConnectSources('http://localhost:8080/api')).toEqual([
      'http://localhost:8080',
      'ws://localhost:8080',
    ]);
  });

  it('gives nothing for a missing, malformed or non-http value', () => {
    for (const value of [undefined, '', '  ', 'not a url', 'javascript:alert(1)', 'ftp://x.test']) {
      expect(apiConnectSources(value), String(value)).toEqual([]);
    }
  });
});

describe('contentSecurityPolicy', () => {
  const pinned = directives(contentSecurityPolicy({ apiUrl: 'http://127.0.0.1:4999' }));

  it('locks down framing, plugins, base URI and form targets', () => {
    expect(pinned.get('default-src')).toEqual(["'self'"]);
    expect(pinned.get('frame-ancestors')).toEqual(["'none'"]);
    expect(pinned.get('object-src')).toEqual(["'none'"]);
    expect(pinned.get('base-uri')).toEqual(["'self'"]);
    expect(pinned.get('form-action')).toEqual(["'self'"]);
  });

  it('allows images from here and data: only, and no remote fonts or manifests', () => {
    expect(pinned.get('img-src')).toEqual(["'self'", 'data:', 'blob:']);
    expect(pinned.get('font-src')).toEqual(["'self'"]);
    expect(pinned.get('manifest-src')).toEqual(["'self'"]);
  });

  it('lets scripts and styles come from here, with inline allowed because no nonce is wired', () => {
    expect(pinned.get('script-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(pinned.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(pinned.get('script-src')).not.toContain("'unsafe-eval'");
  });

  it('pins connect-src to this origin and the configured api (http and websocket)', () => {
    expect(pinned.get('connect-src')).toEqual([
      "'self'",
      'http://127.0.0.1:4999',
      'ws://127.0.0.1:4999',
    ]);
    expect(pinned.get('connect-src')).not.toContain('https:');
  });

  it('falls back to any http(s)/ws(s) host when API_URL was not known at build time', () => {
    const fallback = directives(contentSecurityPolicy({}));
    expect(fallback.get('connect-src')).toEqual(["'self'", 'https:', 'http:', 'wss:', 'ws:']);
    // Everything else stays as tight as before.
    expect(fallback.get('frame-ancestors')).toEqual(["'none'"]);
    expect(fallback.get('script-src')).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it('adds eval only for the dev server (React Refresh), never for a build', () => {
    expect(directives(contentSecurityPolicy({ development: true })).get('script-src')).toContain(
      "'unsafe-eval'",
    );
    expect(
      directives(contentSecurityPolicy({ development: false })).get('script-src'),
    ).not.toContain("'unsafe-eval'");
  });
});

describe('securityHeaders', () => {
  const byKey = new Map(
    securityHeaders({ apiUrl: 'http://127.0.0.1:4999' }).map((h) => [h.key, h.value]),
  );

  it('sends the full set', () => {
    expect([...byKey.keys()].sort()).toEqual([
      'Content-Security-Policy',
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
    expect(all?.headers.map((header) => header.key)).toContain('Content-Security-Policy');
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
