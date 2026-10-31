import { randomBytes } from 'node:crypto';

import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  jsonResponse,
  recordingSleep,
  scriptedFetch,
  timeoutError,
  type ScriptStep,
} from '../common/__fixtures__/scripted-fetch.js';
import type { ChannelError } from '../common/errors.js';
import { LiveGmailTransport } from './live.js';
import { isHistoryExpired } from './transport.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

// A random value per run: tests must never contain something that looks like a real credential.
const token = `t-${randomBytes(12).toString('hex')}`;

function transportFor(steps: readonly ScriptStep[], extra: { userId?: string } = {}) {
  const scripted = scriptedFetch(steps);
  const { sleep, delays } = recordingSleep();
  const getAccessToken = vi.fn(() => Promise.resolve(token));
  const transport = new LiveGmailTransport({
    fetch: scripted.fetch,
    getAccessToken,
    http: { sleep, random: () => 0 },
    ...extra,
  });
  return { transport, getAccessToken, delays, ...scripted };
}

describe('LiveGmailTransport requests', () => {
  it('lists history with the documented query parameters and a bearer token', async () => {
    const { transport, requests } = transportFor([
      jsonResponse(200, { history: [], historyId: '999' }),
    ]);
    const page = await transport.listHistory({
      startHistoryId: '123',
      maxResults: 50,
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
      pageToken: 'next',
    });
    expect(page).toEqual({ history: [], historyId: '999' });
    const sent = requests[0];
    expect(sent?.method).toBe('GET');
    const url = new URL(sent?.url ?? '');
    expect(url.origin).toBe('https://gmail.googleapis.com');
    expect(url.pathname).toBe('/gmail/v1/users/me/history');
    expect(url.searchParams.get('startHistoryId')).toBe('123');
    expect(url.searchParams.get('maxResults')).toBe('50');
    expect(url.searchParams.getAll('historyTypes')).toEqual(['messageAdded']);
    expect(url.searchParams.get('labelId')).toBe('INBOX');
    expect(url.searchParams.get('pageToken')).toBe('next');
    expect(sent?.headers['authorization']).toBe(`Bearer ${token}`);
  });

  it('gets a raw message and a message list', async () => {
    const { transport, requests } = transportFor([
      jsonResponse(200, { id: 'm1', threadId: 't1', labelIds: ['INBOX'], raw: 'AAAA' }),
      jsonResponse(200, { messages: [{ id: 'm1', threadId: 't1' }], nextPageToken: 'n' }),
    ]);
    const message = await transport.getMessage({ id: 'm1', format: 'raw' });
    expect(message.raw).toBe('AAAA');
    const list = await transport.listMessages({
      query: 'after:1',
      labelIds: ['INBOX'],
      maxResults: 10,
    });
    expect(list.nextPageToken).toBe('n');
    expect(requests[0]?.url).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/m1?format=raw',
    );
    expect(requests[1]?.url).toContain('q=after%3A1');
    expect(requests[1]?.url).toContain('labelIds=INBOX');
  });

  it('url-encodes ids and honours userId and baseUrl overrides', async () => {
    const scripted = scriptedFetch([jsonResponse(200, { id: 'a/b', threadId: 't' })]);
    const transport = new LiveGmailTransport({
      fetch: scripted.fetch,
      getAccessToken: () => Promise.resolve(token),
      userId: 'support@example.com',
      baseUrl: 'http://localhost:9999/',
    });
    await transport.getMessage({ id: 'a/b', format: 'minimal' });
    expect(scripted.requests[0]?.url).toBe(
      'http://localhost:9999/gmail/v1/users/support%40example.com/messages/a%2Fb?format=minimal',
    );
  });

  it('sends JSON with raw and threadId, and watches with the topic', async () => {
    const { transport, requests } = transportFor([
      jsonResponse(200, { id: 'm2', threadId: 't1', labelIds: ['SENT'] }),
      jsonResponse(200, { historyId: '5', expiration: '1700000000000' }),
      new Response(null, { status: 204 }),
    ]);
    await transport.sendMessage({ raw: 'QUJD', threadId: 't1' });
    await transport.watch({
      topicName: 'projects/example-project/topics/example-topic',
      labelIds: ['INBOX'],
      labelFilterBehavior: 'include',
    });
    await transport.stopWatch();
    expect(requests[0]?.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({ raw: 'QUJD', threadId: 't1' });
    expect(requests[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(requests[1]?.body ?? '{}')).toEqual({
      topicName: 'projects/example-project/topics/example-topic',
      labelIds: ['INBOX'],
      labelFilterBehavior: 'INCLUDE',
    });
    expect(requests[2]?.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/stop');
  });
});

describe('LiveGmailTransport errors', () => {
  it('maps 404 on history.list to the "run a full sync" signal', async () => {
    const { transport } = transportFor([
      jsonResponse(404, {
        error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' },
      }),
    ]);
    const error = await transport
      .listHistory({ startHistoryId: '1' })
      .catch((caught: unknown) => caught);
    expect(isHistoryExpired(error)).toBe(true);
    expect(error).toMatchObject({ kind: 'not_found', status: 404, code: 'NOT_FOUND' });
  });

  it('does not treat a 404 on another operation as an expired history', async () => {
    const { transport } = transportFor([jsonResponse(404, {})]);
    const error = await transport
      .getMessage({ id: 'x', format: 'raw' })
      .catch((caught: unknown) => caught);
    expect(isHistoryExpired(error)).toBe(false);
  });

  it('keeps the provider message text out of the error', async () => {
    const { transport } = transportFor([
      jsonResponse(400, {
        error: {
          code: 400,
          message: 'bad address alice@customer.example.com',
          status: 'INVALID_ARGUMENT',
        },
      }),
    ]);
    const error = (await transport
      .getMessage({ id: 'x', format: 'raw' })
      .catch((c: unknown) => c)) as ChannelError;
    expect(error.kind).toBe('client');
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain('alice@customer');
  });

  it('classifies 403 rate-limit reasons separately from permission errors', async () => {
    const { transport } = transportFor([
      jsonResponse(403, {
        error: { errors: [{ reason: 'userRateLimitExceeded' }], status: 'PERMISSION_DENIED' },
      }),
      jsonResponse(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }),
    ]);
    // 403 rate limit is not retried by the HTTP layer (only 429 and 5xx are), so each call is one request.
    expect(
      await transport.getMessage({ id: 'a', format: 'raw' }).catch((c: unknown) => c),
    ).toMatchObject({
      kind: 'rate_limited',
      code: 'userRateLimitExceeded',
    });
    expect(
      await transport.getMessage({ id: 'a', format: 'raw' }).catch((c: unknown) => c),
    ).toMatchObject({
      kind: 'auth',
    });
  });

  it('rejects a response that does not match the schema', async () => {
    const { transport } = transportFor([jsonResponse(200, { unexpected: true })]);
    const error = await transport
      .listHistory({ startHistoryId: '1' })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'invalid_response' });
  });

  it('rejects a non-JSON success body', async () => {
    const { transport } = transportFor([new Response('<html>', { status: 200 })]);
    const error = await transport
      .listHistory({ startHistoryId: '1' })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'invalid_response' });
  });
});

describe('LiveGmailTransport retry, timeout and token refresh', () => {
  it('retries reads on 500 and 429 using Retry-After', async () => {
    const { transport, requests, delays } = transportFor([
      jsonResponse(500, {}),
      jsonResponse(429, {}, { 'retry-after': '2' }),
      jsonResponse(200, { history: [], historyId: '1' }),
    ]);
    await transport.listHistory({ startHistoryId: '1' });
    expect(requests).toHaveLength(3);
    expect(delays).toEqual([0, 2000]);
  });

  it('never repeats a send after a 5xx or a timeout (no idempotency key in Gmail)', async () => {
    const first = transportFor([
      jsonResponse(503, {}),
      jsonResponse(200, { id: 'm', threadId: 't' }),
    ]);
    const error503 = await first.transport.sendMessage({ raw: 'QQ' }).catch((c: unknown) => c);
    expect(error503).toMatchObject({ kind: 'server', outcomeUnknown: true });
    expect(first.requests).toHaveLength(1);

    const second = transportFor([timeoutError(), jsonResponse(200, { id: 'm', threadId: 't' })]);
    const errorTimeout = await second.transport.sendMessage({ raw: 'QQ' }).catch((c: unknown) => c);
    expect(errorTimeout).toMatchObject({ kind: 'timeout', outcomeUnknown: true });
    expect(second.requests).toHaveLength(1);
  });

  it('does retry a send that was refused with 429', async () => {
    const { transport, requests } = transportFor([
      jsonResponse(429, {}, { 'retry-after': '1' }),
      jsonResponse(200, { id: 'm', threadId: 't' }),
    ]);
    await expect(transport.sendMessage({ raw: 'QQ' })).resolves.toMatchObject({ id: 'm' });
    expect(requests).toHaveLength(2);
  });

  it('asks the token provider for a fresh token once after a 401', async () => {
    const { transport, getAccessToken, requests } = transportFor([
      jsonResponse(401, { error: { status: 'UNAUTHENTICATED' } }),
      jsonResponse(200, { history: [], historyId: '1' }),
    ]);
    await transport.listHistory({ startHistoryId: '1' });
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(getAccessToken).toHaveBeenLastCalledWith({ forceRefresh: true });
    expect(requests).toHaveLength(2);
  });

  it('gives up after a second 401', async () => {
    const { transport, requests } = transportFor([jsonResponse(401, {}), jsonResponse(401, {})]);
    const error = await transport
      .listHistory({ startHistoryId: '1' })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'auth', status: 401 });
    expect(requests).toHaveLength(2);
  });

  it('never puts the access token into an error', async () => {
    const { transport } = transportFor([
      jsonResponse(500, {}),
      jsonResponse(500, {}),
      jsonResponse(500, {}),
      jsonResponse(500, {}),
    ]);
    const error = (await transport
      .getMessage({ id: 'x', format: 'raw' })
      .catch((c: unknown) => c)) as Error;
    expect(`${error.message} ${error.stack ?? ''} ${JSON.stringify(error)}`).not.toContain(token);
  });
});
