import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { newNonce, proxy } from './proxy';

// The Content-Security-Policy is made per request (T-125 C-5): a new nonce each time and the api
// origin as it is at run time.

const get = (url = 'http://localhost:3000/') => proxy(new NextRequest(url));
const policyOf = (response: Response) => response.headers.get('content-security-policy') ?? '';
const nonceOf = (policy: string) => /'nonce-([^']+)'/.exec(policy)?.[1];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('proxy', () => {
  it('sends a policy with a nonce, and a different nonce for every response', () => {
    const first = policyOf(get());
    const second = policyOf(get());
    expect(nonceOf(first)).toBeTruthy();
    expect(nonceOf(first)).not.toBe(nonceOf(second));
    expect(first).toContain("'strict-dynamic'");
    expect(first).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(newNonce()).not.toBe(newNonce());
  });

  it('hands the same nonce and policy to the page through the request headers', () => {
    const response = get();
    const forwarded = response.headers.get('x-middleware-request-x-nonce');
    expect(forwarded).toBe(nonceOf(policyOf(response)));
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(
      policyOf(response),
    );
  });

  it('follows API_URL as it is when the request arrives, not as it was when the image was built', () => {
    vi.stubEnv('API_URL', 'https://api-a.example.test');
    expect(policyOf(get())).toContain(
      "connect-src 'self' https://api-a.example.test wss://api-a.example.test",
    );
    vi.stubEnv('API_URL', 'https://api-b.example.test');
    const later = policyOf(get());
    expect(later).toContain('https://api-b.example.test');
    expect(later).not.toContain('api-a.example.test');
    expect(later).not.toMatch(/connect-src[^;]*\bhttps:(?=[ ;]|$)/);
  });
});
