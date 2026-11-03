import { CSRF_HEADER, sessionInfoSchema } from '@watchtower/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiError, mockApi } from '@/test/mock-api';
import { makeSession } from '@/test/fixtures';

import { ApiClient, buildUrl } from './client';
import { createRefreshCoordinator } from './refresh-coordinator';
import { createEndpoints } from './endpoints';

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE = 'http://api.test';

function makeClient(overrides: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}) {
  const onSession = vi.fn();
  const onSessionExpired = vi.fn();
  const client = new ApiClient({
    baseUrl: BASE,
    coordinator: createRefreshCoordinator({
      run: async () => {
        const session = await client.request({
          method: 'POST',
          path: '/v1/auth/refresh',
          schema: sessionInfoSchema,
          retryOnUnauthenticated: false,
        });
        client.acceptSession(session);
      },
      locks: null,
      store: { read: () => null, write: () => undefined },
    }),
    onSession,
    onSessionExpired,
    ...overrides,
  });
  return { client, onSession, onSessionExpired, api: createEndpoints(client) };
}

describe('buildUrl', () => {
  it('joins the base and path, joins arrays with commas and drops empty values', () => {
    const url = buildUrl(BASE, '/v1/tickets', {
      status: ['open', 'new'],
      q: 'login',
      overdue: true,
      assignee: undefined,
      tag: '',
      empty: [],
      limit: 50,
    });
    expect(url).toBe(`${BASE}/v1/tickets?status=open%2Cnew&q=login&overdue=true&limit=50`);
  });
});

describe('ApiClient', () => {
  it('downloads binary through the authenticated endpoint with a coordinated refresh', async () => {
    let attempts = 0;
    const fresh = makeSession('agent');
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe('include');
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === '/v1/auth/refresh') {
        return new Response(JSON.stringify(fresh), {
          headers: { 'content-type': 'application/json' },
        });
      }
      attempts += 1;
      return attempts === 1
        ? new Response(
            JSON.stringify({
              statusCode: 401,
              error: 'Error',
              code: 'unauthenticated',
              message: 'expired',
            }),
            { status: 401 },
          )
        : new Response(new Uint8Array([0, 255, 42]), {
            headers: { 'content-type': 'application/pdf' },
          });
    });
    const { api, onSession } = makeClient({
      fetchImpl: () => (input, init) => Promise.resolve(fetchMock(input, init)),
    });
    const blob = await api.downloadAttachment('OPS-1', 'message/1', 2);
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([0, 255, 42]);
    expect(
      fetchMock.mock.calls.map(
        ([input]) => new URL(input instanceof Request ? input.url : input.toString()).pathname,
      ),
    ).toEqual([
      '/v1/tickets/OPS-1/messages/message%2F1/attachments/2',
      '/v1/auth/refresh',
      '/v1/tickets/OPS-1/messages/message%2F1/attachments/2',
    ]);
    const request = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(request[1].credentials).toBe('include');
    expect(request[1].cache).toBe('no-store');
    expect(onSession).toHaveBeenCalledWith(fresh);
  });

  it('does not turn denied or missing downloads into blobs or retry their authorization', async () => {
    const mock = mockApi({
      'GET /v1/tickets/:id/messages/:messageId/attachments/:index': apiError(403, 'forbidden'),
    });
    const { api } = makeClient();
    await expect(api.downloadAttachment('OPS-1', 'm1', 0)).rejects.toMatchObject({ status: 403 });
    expect(mock.callsTo('/v1/auth/refresh')).toHaveLength(0);
  });

  it('sends cookies, and the CSRF token only on unsafe methods once a session is known', async () => {
    const session = makeSession('agent');
    const mock = mockApi({
      'GET /v1/auth/session': { json: session },
      'POST /v1/tickets/:id/status': { json: { ok: true } },
      'GET /v1/ticket-workflow': { json: { transitions: [] } },
    });
    const { client } = makeClient();
    await createEndpoints(client).session();

    const options = mock.fetchMock.mock.calls[0]?.[1];
    expect(options?.credentials).toBe('include');

    await client.request({
      method: 'POST',
      path: '/v1/tickets/OPS-1/status',
      body: { status: 'open' },
      schema: null,
    });
    await createEndpoints(client).workflow();

    expect(mock.calls[0]?.headers.get(CSRF_HEADER)).toBeNull();
    expect(mock.calls[1]?.headers.get(CSRF_HEADER)).toBe(session.csrfToken);
    expect(mock.calls[1]?.headers.get('content-type')).toBe('application/json');
    expect(mock.calls[2]?.headers.get(CSRF_HEADER)).toBeNull();
  });

  it('refreshes once on a 401, retries the request and keeps the user signed in', async () => {
    const fresh = makeSession('agent', { csrfToken: 'fresh-csrf' });
    let attempts = 0;
    const mock = mockApi({
      'GET /v1/ticket-workflow': () => {
        attempts += 1;
        return attempts === 1 ? apiError(401, 'unauthenticated') : { json: { transitions: [] } };
      },
      'POST /v1/auth/refresh': { json: fresh },
    });
    const { client, onSession, onSessionExpired } = makeClient();

    await expect(createEndpoints(client).workflow()).resolves.toEqual({ transitions: [] });

    expect(mock.callsTo('/v1/auth/refresh')).toHaveLength(1);
    expect(mock.callsTo('/v1/ticket-workflow')).toHaveLength(2);
    expect(onSession).toHaveBeenCalledWith(fresh);
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('shares one refresh between simultaneous 401s (single-flight)', async () => {
    let failing = true;
    const mock = mockApi({
      'GET /v1/ticket-workflow': () =>
        failing ? apiError(401, 'unauthenticated') : { json: { transitions: [] } },
      'GET /v1/queues': () =>
        failing ? apiError(401, 'unauthenticated') : { json: { queues: [] } },
      'GET /v1/intents': () =>
        failing ? apiError(401, 'unauthenticated') : { json: { intents: [] } },
      'POST /v1/auth/refresh': () => {
        failing = false;
        return { json: makeSession('agent') };
      },
    });
    const { api } = makeClient();

    await Promise.all([api.workflow(), api.queues(), api.intents()]);

    // Three requests were refused, but the one-time refresh token was spent only once.
    expect(mock.callsTo('/v1/auth/refresh')).toHaveLength(1);
  });

  it('reports the session as over when the refresh itself is refused', async () => {
    const mock = mockApi({
      'GET /v1/ticket-workflow': apiError(401, 'unauthenticated'),
      'POST /v1/auth/refresh': apiError(401, 'invalid_refresh_token'),
    });
    const { client, onSessionExpired } = makeClient();

    await expect(createEndpoints(client).workflow()).rejects.toMatchObject({ status: 401 });

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(mock.callsTo('/v1/ticket-workflow')).toHaveLength(1);
  });

  it('does not treat a transient refresh failure as the end of the session', async () => {
    mockApi({
      'GET /v1/ticket-workflow': apiError(401, 'unauthenticated'),
      'POST /v1/auth/refresh': { status: 503, json: undefined },
    });
    const { client, onSessionExpired } = makeClient();
    await expect(createEndpoints(client).workflow()).rejects.toMatchObject({ status: 503 });
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('does not refresh for sign-in endpoints: a 401 there is an answer', async () => {
    const mock = mockApi({
      'POST /v1/auth/break-glass': apiError(401, 'invalid_credentials'),
    });
    const { api } = makeClient();
    await expect(api.breakGlass({ email: 'a@b.co', password: 'x' })).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    expect(mock.callsTo('/v1/auth/refresh')).toHaveLength(0);
  });

  it('can read the session without trying to renew an expired one', async () => {
    const mock = mockApi({ 'GET /v1/auth/session': apiError(401, 'unauthenticated') });
    const { api } = makeClient();
    await expect(api.session(undefined, { refresh: false })).rejects.toMatchObject({ status: 401 });
    expect(mock.callsTo('/v1/auth/refresh')).toHaveLength(0);
  });

  it('reads the CSRF token again once when it is refused, then retries', async () => {
    let first = true;
    const mock = mockApi({
      'POST /v1/tickets/:id/status': () => {
        if (first) {
          first = false;
          return apiError(403, 'csrf_invalid');
        }
        return { status: 204 };
      },
      'GET /v1/auth/session': { json: makeSession('agent', { csrfToken: 'renewed' }) },
    });
    const { client } = makeClient();

    await client.request({
      method: 'POST',
      path: '/v1/tickets/OPS-1/status',
      body: {},
      schema: null,
    });

    const posts = mock.callsTo('/v1/tickets/OPS-1/status', 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers.get(CSRF_HEADER)).toBe('renewed');
  });

  it('turns an answer that breaks the contract into a clear error', async () => {
    mockApi({ 'GET /v1/queues': { json: { queues: 'nope' } } });
    const { api } = makeClient();
    await expect(api.queues()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('turns a network failure into a "network" error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed to fetch')));
    const { api } = makeClient();
    await expect(api.queues()).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it('forgets the CSRF token on sign-out', async () => {
    const mock = mockApi({
      'GET /v1/auth/session': { json: makeSession('agent') },
      'POST /v1/auth/logout': { status: 204 },
      'POST /v1/anything': { status: 204 },
    });
    const { client, api } = makeClient();
    await api.session();
    await api.logout();
    await client.request({ method: 'POST', path: '/v1/anything', schema: null });
    expect(mock.callsTo('/v1/anything')[0]?.headers.get(CSRF_HEADER)).toBeNull();
  });
});
