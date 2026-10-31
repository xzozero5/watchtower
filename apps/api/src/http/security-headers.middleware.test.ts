import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AppLogger } from '../logging/logger.js';
import { isPrivateAddress, proxyHint } from './proxy-hint.middleware.js';
import { HSTS_VALUE, isAuthPath, securityHeaders } from './security-headers.middleware.js';

function run(middleware: (req: Request, res: Response, next: NextFunction) => void, path: string) {
  const headers = new Map<string, string>();
  const response = {
    setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
  } as unknown as Response;
  const next = vi.fn();
  middleware({ path } as Request, response, next);
  expect(next).toHaveBeenCalledOnce();
  return headers;
}

describe('securityHeaders', () => {
  it('sets nosniff, frame-ancestors none and no-referrer on every reply', () => {
    const headers = run(securityHeaders({ NODE_ENV: 'development' }), '/v1/tickets');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.has('cache-control')).toBe(false);
  });

  it('forbids caching of /v1/auth and everything under it, and nothing else', () => {
    const middleware = securityHeaders({ NODE_ENV: 'development' });
    for (const path of ['/v1/auth', '/v1/auth/session', '/v1/auth/magic-link/verify']) {
      expect(run(middleware, path).get('cache-control'), path).toBe('no-store');
    }
    for (const path of ['/v1/authors', '/v1/tickets', '/health', '/docs']) {
      expect(run(middleware, path).has('cache-control'), path).toBe(false);
    }
    expect(isAuthPath('/v1/auth/x')).toBe(true);
    expect(isAuthPath('/v1/authx')).toBe(false);
  });

  it('sends HSTS only in production', () => {
    expect(
      run(securityHeaders({ NODE_ENV: 'production' }), '/health').get('strict-transport-security'),
    ).toBe(HSTS_VALUE);
    for (const env of ['development', 'test'] as const) {
      expect(
        run(securityHeaders({ NODE_ENV: env }), '/health').has('strict-transport-security'),
      ).toBe(false);
    }
  });
});

describe('isPrivateAddress', () => {
  it('recognises the addresses a proxy in front of the api would have', () => {
    for (const address of [
      '172.18.0.5',
      '10.1.2.3',
      '192.168.0.9',
      '127.0.0.1',
      '::1',
      '::ffff:172.18.0.2',
      'fd00::1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of [
      '8.8.8.8',
      '172.32.0.1',
      '203.0.113.7',
      '2001:db8::1',
      'nonsense',
      undefined,
    ]) {
      expect(isPrivateAddress(address), String(address)).toBe(false);
    }
  });
});

describe('proxyHint (C-8)', () => {
  function request(forwarded: string | undefined, remote: string | undefined): Request {
    return {
      headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
      socket: { remoteAddress: remote },
    } as unknown as Request;
  }
  const logger = () =>
    ({ warn: vi.fn() }) as unknown as AppLogger & { warn: ReturnType<typeof vi.fn> };

  it('warns once when X-Forwarded-For arrives from a private address and hops is 0', () => {
    const log = logger();
    const hint = proxyHint({ TRUST_PROXY_HOPS: 0 }, log);
    const next = vi.fn();
    hint(request('203.0.113.9', '172.18.0.4'), {} as Response, next);
    hint(request('203.0.113.10', '172.18.0.4'), {} as Response, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledOnce();
    const [fields, message] = log.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toContain('TRUST_PROXY_HOPS=1');
    expect(JSON.stringify(fields)).not.toContain('203.0.113');
  });

  it('stays quiet when hops is set, when there is no header, or when the peer is public', () => {
    const log = logger();
    const next = vi.fn();
    proxyHint({ TRUST_PROXY_HOPS: 1 }, log)(
      request('203.0.113.9', '172.18.0.4'),
      {} as Response,
      next,
    );
    proxyHint({ TRUST_PROXY_HOPS: 0 }, log)(request(undefined, '172.18.0.4'), {} as Response, next);
    // A public client forging the header is simply ignored by Express (hops 0); nothing to warn about.
    proxyHint({ TRUST_PROXY_HOPS: 0 }, log)(
      request('1.2.3.4', '198.51.100.7'),
      {} as Response,
      next,
    );
    expect(next).toHaveBeenCalledTimes(3);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
