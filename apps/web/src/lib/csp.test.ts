import { describe, expect, it } from 'vitest';

import { apiConnectSources, contentSecurityPolicy } from './csp';

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

describe('contentSecurityPolicy with a nonce (T-125 C-5)', () => {
  const withNonce = directives(
    contentSecurityPolicy({ apiUrl: 'http://127.0.0.1:4999', nonce: 'abc123==' }),
  );

  it('lets only scripts that carry the nonce run, and drops unsafe-inline for scripts', () => {
    expect(withNonce.get('script-src')).toEqual(["'self'", "'nonce-abc123=='", "'strict-dynamic'"]);
    expect(withNonce.get('script-src')).not.toContain("'unsafe-inline'");
  });

  it('keeps unsafe-eval out of a production policy and in only for the dev server', () => {
    const dev = directives(contentSecurityPolicy({ nonce: 'n', development: true }));
    expect(dev.get('script-src')).toContain("'unsafe-eval'");
    expect(withNonce.get('script-src')).not.toContain("'unsafe-eval'");
  });
});
