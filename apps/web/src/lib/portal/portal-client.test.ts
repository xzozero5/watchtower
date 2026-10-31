import { describe, expect, it, vi } from 'vitest';

import {
  classifyPortalError,
  DEFAULT_RETRY_AFTER_SECONDS,
  parseRetryAfter,
  PortalApiError,
  PortalClient,
} from './portal-client';

const BASE = 'http://api.test';
const UUID = '7d0a5f0e-1b2c-4d3e-8f4a-5b6c7d8e9f01';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
const errorBody = (statusCode: number, code: string) => ({
  statusCode,
  error: 'Error',
  code,
  message: code,
});

function clientWith(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchSpy = vi.fn((url: string, init: RequestInit) => Promise.resolve(respond(url, init)));
  const client = new PortalClient({
    baseUrl: BASE,
    fetchImpl: () => fetchSpy as unknown as typeof fetch,
  });
  return { client, fetchSpy };
}

describe('error mapping', () => {
  const api = (status: number, code: string | null, retry: number | null = null) =>
    new PortalApiError(status, code, retry);

  it('maps api answers to the kinds the pages have copy for', () => {
    expect(classifyPortalError(api(400, 'verification_failed')).kind).toBe('verification');
    expect(classifyPortalError(api(400, 'validation_failed')).kind).toBe('validation');
    expect(classifyPortalError(api(400, null)).kind).toBe('validation');
    expect(classifyPortalError(api(401, 'invalid_or_expired_link')).kind).toBe('invalidLink');
    expect(classifyPortalError(api(401, null)).kind).toBe('invalidLink');
    expect(classifyPortalError(api(409, 'ticket_not_open')).kind).toBe('notOpen');
    expect(classifyPortalError(api(429, 'rate_limited', 90))).toEqual({
      kind: 'rateLimited',
      retryAfterSeconds: 90,
    });
    expect(classifyPortalError(api(0, null)).kind).toBe('network');
    expect(classifyPortalError(api(500, null)).kind).toBe('server');
    expect(classifyPortalError(api(502, null)).kind).toBe('server');
    expect(classifyPortalError(new Error('boom')).kind).toBe('server');
  });

  it('reads Retry-After as seconds or as an HTTP date, and ignores nonsense', () => {
    expect(parseRetryAfter('120')).toBe(120);
    expect(parseRetryAfter(' 5 ')).toBe(5);
    expect(parseRetryAfter('0')).toBe(1);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    const now = Date.parse('2026-11-05T10:00:00Z');
    expect(parseRetryAfter('Thu, 05 Nov 2026 10:02:00 GMT', now)).toBe(120);
  });
});

describe('PortalClient', () => {
  it('asks for a challenge without cookies and validates the answer', async () => {
    const challenge = {
      provider: 'pow-sha256',
      challenge: 'abc.1.2.8.sig',
      difficultyBits: 8,
      issuedAt: '2026-11-05T10:00:00.000Z',
      expiresAt: '2026-11-05T10:30:00.000Z',
      minFillSeconds: 3,
    };
    const { client, fetchSpy } = clientWith(() => json(challenge));
    expect(await client.challenge()).toEqual(challenge);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE}/v1/portal/challenge`);
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  });

  it('sends the tracking value in X-Portal-Token only, never in the URL', async () => {
    const view = {
      key: 'OPS-12',
      subject: 'Cannot log in',
      status: 'in_progress',
      statusLabel: 'In progress',
      mergedIntoKey: null,
      maskedEmail: 'a***@example.com',
      createdAt: '2026-11-05T09:00:00.000Z',
      updatedAt: '2026-11-05T09:30:00.000Z',
      resolvedAt: null,
      expectedFirstResponseAt: null,
      canReply: true,
      timeline: [],
      truncated: false,
      accessExpiresAt: '2026-11-12T09:00:00.000Z',
    };
    const { client, fetchSpy } = clientWith(() => json(view));
    await client.ticket('OPS-12', 'sample-value');
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE}/v1/portal/tickets/OPS-12`);
    expect(String(url)).not.toContain('sample-value');
    expect((init as RequestInit).headers).toMatchObject({ 'x-portal-token': 'sample-value' });
    expect((init as RequestInit).credentials).toBe('omit');
  });

  it('encodes the ticket number in the path', async () => {
    const { client, fetchSpy } = clientWith(() =>
      json(errorBody(401, 'invalid_or_expired_link'), { status: 401 }),
    );
    await expect(client.ticket('OPS-1/../x', 'v')).rejects.toBeInstanceOf(PortalApiError);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(`${BASE}/v1/portal/tickets/OPS-1%2F..%2Fx`);
  });

  it('posts a reply as JSON and validates the result', async () => {
    const { client, fetchSpy } = clientWith(() =>
      json(
        {
          message: {
            id: UUID,
            from: 'customer',
            authorName: null,
            body: 'Thanks',
            createdAt: '2026-11-05T10:00:00.000Z',
          },
          status: 'in_progress',
          statusLabel: 'In progress',
        },
        { status: 201 },
      ),
    );
    const result = await client.reply('OPS-12', 'v', { body: 'Thanks' });
    expect(result.message.body).toBe('Thanks');
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ body: 'Thanks' }));
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('turns 429 into a rate-limit error with the Retry-After wait', async () => {
    const { client } = clientWith(() =>
      json(errorBody(429, 'rate_limited'), { status: 429, headers: { 'retry-after': '300' } }),
    );
    const error = await client
      .resend({ ticketKey: 'OPS-12', email: 'a@example.com' })
      .catch((e: unknown) => e);
    expect(classifyPortalError(error)).toEqual({ kind: 'rateLimited', retryAfterSeconds: 300 });
  });

  it('falls back to a default wait when a 429 has no usable Retry-After', async () => {
    const { client } = clientWith(() => json(errorBody(429, 'rate_limited'), { status: 429 }));
    const error = await client.challenge().catch((e: unknown) => e);
    expect(classifyPortalError(error).retryAfterSeconds).toBe(DEFAULT_RETRY_AFTER_SECONDS);
  });

  it('classifies a failed verification and a closed ticket by their codes', async () => {
    const verification = clientWith(() =>
      json(errorBody(400, 'verification_failed'), { status: 400 }),
    );
    const failure = await verification.client
      .reply('OPS-1', 'v', { body: 'x' })
      .catch((e: unknown) => e);
    expect(classifyPortalError(failure).kind).toBe('verification');

    const closed = clientWith(() => json(errorBody(409, 'ticket_not_open'), { status: 409 }));
    const notOpen = await closed.client.reply('OPS-1', 'v', { body: 'x' }).catch((e: unknown) => e);
    expect(classifyPortalError(notOpen).kind).toBe('notOpen');
  });

  it('reports an unreachable api as a network failure, and a proxy HTML page as a server failure', async () => {
    const offline = new PortalClient({
      baseUrl: BASE,
      fetchImpl: () => () => Promise.reject(new TypeError('Failed to fetch')),
    });
    expect(classifyPortalError(await offline.challenge().catch((e: unknown) => e)).kind).toBe(
      'network',
    );

    const html = clientWith(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    expect(classifyPortalError(await html.client.challenge().catch((e: unknown) => e)).kind).toBe(
      'server',
    );
  });

  it('rejects an answer that does not match the contract', async () => {
    const { client } = clientWith(() => json({ unexpected: true }));
    const error = await client.challenge().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortalApiError);
    expect(classifyPortalError(error).kind).toBe('server');
  });
});
