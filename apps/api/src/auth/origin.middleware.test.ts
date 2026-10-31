import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { createLogger } from '../logging/logger.js';
import { testConfig } from '../testing/support.js';
import { originCheck } from './origin.middleware.js';

const config = testConfig();
const middleware = originCheck(config, createLogger(config));

function run(method: string, origin?: string) {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const next: NextFunction = vi.fn();
  const request = { method, headers: origin === undefined ? {} : { origin } } as unknown as Request;
  middleware(request, { status } as unknown as Response, next);
  return { next, status, json };
}

describe('originCheck', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses a foreign Origin on %s', (method) => {
    const { next, status, json } = run(method, 'http://evil.example.com');
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'origin_not_allowed' }));
  });

  it('refuses Origin: null (sandboxed frames, some redirects)', () => {
    expect(run('POST', 'null').next).not.toHaveBeenCalled();
  });

  it('allows the web app and the api own origin (Swagger UI)', () => {
    expect(run('POST', 'http://localhost:3000').next).toHaveBeenCalled();
    expect(run('POST', 'http://localhost:4000').next).toHaveBeenCalled();
  });

  it('allows a request with no Origin (curl, server to server) and any safe method', () => {
    expect(run('POST').next).toHaveBeenCalled();
    expect(run('GET', 'http://evil.example.com').next).toHaveBeenCalled();
    expect(run('OPTIONS', 'http://evil.example.com').next).toHaveBeenCalled();
  });

  it('does not treat a lookalike origin as the app origin', () => {
    expect(run('POST', 'http://localhost:3000.evil.example.com').next).not.toHaveBeenCalled();
    expect(run('POST', 'https://localhost:3000').next).not.toHaveBeenCalled();
    expect(run('POST', 'http://localhost:3001').next).not.toHaveBeenCalled();
  });
});
