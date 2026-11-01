import { randomBytes, randomUUID } from 'node:crypto';

import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  jsonResponse,
  recordingSleep,
  scriptedFetch,
  timeoutError,
  type ScriptStep,
} from '../common/__fixtures__/scripted-fetch.js';
import { LiveLineTransport } from './live.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

// A random value per run: tests must never contain something that looks like a real credential.
const token = `t-${randomBytes(12).toString('hex')}`;
const text = (value: string) => [{ type: 'text' as const, text: value }];

function transportFor(steps: readonly ScriptStep[]) {
  const scripted = scriptedFetch(steps);
  const { sleep, delays } = recordingSleep();
  const getChannelAccessToken = vi.fn(() => Promise.resolve(token));
  const transport = new LiveLineTransport({
    fetch: scripted.fetch,
    getChannelAccessToken,
    http: { sleep, random: () => 0 },
  });
  return { transport, getChannelAccessToken, delays, ...scripted };
}

describe('LiveLineTransport requests (endpoints verified against the Messaging API reference)', () => {
  it('replies with POST /v2/bot/message/reply and no retry key', async () => {
    const { transport, requests } = transportFor([
      jsonResponse(
        200,
        { sentMessages: [{ id: '1', quoteToken: 'q' }] },
        { 'x-line-request-id': 'req-1' },
      ),
    ]);
    const result = await transport.reply({ replyToken: 'rt', messages: text('ack') });
    expect(result).toEqual({
      requestId: 'req-1',
      sentMessageIds: ['1'],
      alreadyAccepted: false,
      acceptedRequestId: null,
    });
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.line.me/v2/bot/message/reply',
    });
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      replyToken: 'rt',
      messages: text('ack'),
    });
    expect(requests[0]?.headers['authorization']).toBe(`Bearer ${token}`);
    expect(requests[0]?.headers['x-line-retry-key']).toBeUndefined();
    expect(requests[0]?.headers['content-type']).toBe('application/json');
  });

  it('pushes with X-Line-Retry-Key', async () => {
    const retryKey = randomUUID();
    const { transport, requests } = transportFor([
      jsonResponse(200, { sentMessages: [{ id: '9' }] }),
    ]);
    await transport.push({ to: 'U1', messages: text('hi'), retryKey });
    expect(requests[0]?.url).toBe('https://api.line.me/v2/bot/message/push');
    expect(requests[0]?.headers['x-line-retry-key']).toBe(retryKey);
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({ to: 'U1', messages: text('hi') });
  });

  it('reads quota and consumption', async () => {
    const { transport, requests } = transportFor([
      jsonResponse(200, { type: 'limited', value: 15000 }),
      jsonResponse(200, { totalUsage: 41 }),
    ]);
    expect(await transport.getQuota()).toEqual({ type: 'limited', value: 15000 });
    expect(await transport.getConsumption()).toEqual({ totalUsage: 41 });
    expect(requests.map((r) => r.url)).toEqual([
      'https://api.line.me/v2/bot/message/quota',
      'https://api.line.me/v2/bot/message/quota/consumption',
    ]);
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('downloads content from api-data.line.me, and reports 202 as preparing', async () => {
    const { transport, requests } = transportFor([
      new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }),
      new Response(null, { status: 202 }),
    ]);
    expect(await transport.getContent('100 001')).toEqual({
      status: 'ready',
      bytes: Uint8Array.from([1, 2, 3]),
      contentType: 'image/jpeg',
    });
    expect(await transport.getContent('2')).toEqual({ status: 'preparing' });
    expect(requests[0]?.url).toBe('https://api-data.line.me/v2/bot/message/100%20001/content');
  });

  it('marks as read and shows a loading animation', async () => {
    const { transport, requests } = transportFor([jsonResponse(200, {}), jsonResponse(202, {})]);
    await transport.markAsRead({ markAsReadToken: 'mt' });
    await transport.showLoadingAnimation({ chatId: 'U1', loadingSeconds: 30 });
    expect(requests[0]?.url).toBe('https://api.line.me/v2/bot/chat/markAsRead');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({ markAsReadToken: 'mt' });
    expect(requests[1]?.url).toBe('https://api.line.me/v2/bot/chat/loading/start');
    expect(JSON.parse(requests[1]?.body ?? '{}')).toEqual({ chatId: 'U1', loadingSeconds: 30 });
  });

  it('validates locally and sends nothing for bad input', async () => {
    const { transport, requests } = transportFor([]);
    await expect(
      transport.push({ to: 'U1', messages: text('x'), retryKey: 'nope' }),
    ).rejects.toMatchObject({
      kind: 'client',
    });
    await expect(
      transport.reply({ replyToken: 'rt', messages: text('x'.repeat(5001)) }),
    ).rejects.toMatchObject({
      kind: 'client',
    });
    await expect(
      transport.showLoadingAnimation({ chatId: 'U1', loadingSeconds: 7 }),
    ).rejects.toMatchObject({
      kind: 'client',
    });
    expect(requests).toHaveLength(0);
  });
});

describe('LiveLineTransport push idempotency (X-Line-Retry-Key)', () => {
  it('maps 409 "already accepted" to success without sending again', async () => {
    const { transport } = transportFor([
      jsonResponse(
        409,
        { message: 'The retry key is already accepted' },
        { 'x-line-accepted-request-id': 'first-req', 'x-line-request-id': 'second' },
      ),
    ]);
    const result = await transport.push({ to: 'U1', messages: text('x'), retryKey: randomUUID() });
    expect(result).toEqual({
      requestId: 'second',
      sentMessageIds: [],
      alreadyAccepted: true,
      acceptedRequestId: 'first-req',
    });
  });

  it('retries a timeout and a 5xx with the same retry key, then reports success', async () => {
    const retryKey = randomUUID();
    const { transport, requests, delays } = transportFor([
      timeoutError(),
      jsonResponse(500, {}),
      jsonResponse(200, { sentMessages: [{ id: '5' }] }),
    ]);
    const result = await transport.push({ to: 'U1', messages: text('x'), retryKey });
    expect(result.sentMessageIds).toEqual(['5']);
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((r) => r.headers['x-line-retry-key']))).toEqual(
      new Set([retryKey]),
    );
    expect(delays).toHaveLength(2);
  });

  it('surfaces an unknown outcome after the retry budget is spent', async () => {
    const { transport } = transportFor([
      timeoutError(),
      timeoutError(),
      timeoutError(),
      timeoutError(),
    ]);
    const error = await transport
      .push({ to: 'U1', messages: text('x'), retryKey: randomUUID() })
      .catch((c: unknown) => c);
    expect(error).toMatchObject({ kind: 'timeout', outcomeUnknown: true, retryable: true });
  });
});

describe('LiveLineTransport reply is not repeated blindly', () => {
  it('does not retry a reply after a timeout or 5xx', async () => {
    const timeout = transportFor([timeoutError(), jsonResponse(200, {})]);
    await expect(
      timeout.transport.reply({ replyToken: 'rt', messages: text('x') }),
    ).rejects.toMatchObject({
      kind: 'timeout',
    });
    expect(timeout.requests).toHaveLength(1);

    const server = transportFor([jsonResponse(502, {}), jsonResponse(200, {})]);
    await expect(
      server.transport.reply({ replyToken: 'rt', messages: text('x') }),
    ).rejects.toMatchObject({
      kind: 'server',
      outcomeUnknown: true,
    });
    expect(server.requests).toHaveLength(1);
  });

  it('maps an invalid reply token (400) to a stable code without keeping the provider text', async () => {
    const { transport } = transportFor([jsonResponse(400, { message: 'Invalid reply token' })]);
    const error = (await transport
      .reply({ replyToken: 'rt', messages: text('x') })
      .catch((c: unknown) => c)) as Error;
    expect(error).toMatchObject({ kind: 'client', status: 400, code: 'invalid_reply_token' });
    expect(`${error.message}${JSON.stringify(error)}`).not.toContain('Invalid reply token');
  });
});

describe('LiveLineTransport rate limits and quota', () => {
  it('waits for Retry-After on a rate-limit 429 and tries again', async () => {
    const { transport, requests, delays } = transportFor([
      jsonResponse(
        429,
        { message: 'The API rate limit has been exceeded' },
        { 'retry-after': '2' },
      ),
      jsonResponse(200, { totalUsage: 1 }),
    ]);
    await transport.getConsumption();
    expect(requests).toHaveLength(2);
    expect(delays).toEqual([2000]);
  });

  it('does not retry a monthly-limit 429 and reports a stable code', async () => {
    const { transport, requests } = transportFor([
      jsonResponse(429, { message: 'You have reached your monthly limit.' }),
      jsonResponse(200, {}),
    ]);
    const error = await transport
      .push({ to: 'U1', messages: text('x'), retryKey: randomUUID() })
      .catch((c: unknown) => c);
    expect(error).toMatchObject({ kind: 'rate_limited', status: 429, code: 'monthly_limit' });
    expect(requests).toHaveLength(1);
  });

  it('stops reading a media body that outgrows the cap, without holding it all (C-7)', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
        // A server that never ends: only the cap can stop the read.
        if (pulled > 10_000) controller.close();
      },
    });
    const scripted = scriptedFetch([new Response(endless, { status: 200 })]);
    const transport = new LiveLineTransport({
      fetch: scripted.fetch,
      getChannelAccessToken: () => Promise.resolve(token),
      maxContentBytes: 4096,
    });
    const error = await transport.getContent('big').catch((c: unknown) => c);
    expect(error).toMatchObject({ kind: 'client', code: 'content_too_large' });
    expect((error as { retryable: boolean }).retryable).toBe(false);
    // Cap 4 KiB at 1 KiB per chunk: a handful of pulls, nowhere near the 10,000 on offer.
    expect(pulled).toBeLessThan(20);
  });

  it('refuses a declared length over the cap', async () => {
    const scripted = scriptedFetch([
      new Response(new Uint8Array(10), { status: 200, headers: { 'content-length': '999999' } }),
    ]);
    const transport = new LiveLineTransport({
      fetch: scripted.fetch,
      getChannelAccessToken: () => Promise.resolve(token),
      maxContentBytes: 1000,
    });
    await expect(transport.getContent('big')).rejects.toMatchObject({ code: 'content_too_large' });
  });

  it('maps 404 and 410 on content to not_found', async () => {
    const { transport } = transportFor([jsonResponse(404, {}), jsonResponse(410, {})]);
    expect(await transport.getContent('a').catch((c: unknown) => c)).toMatchObject({
      kind: 'not_found',
    });
    expect(await transport.getContent('b').catch((c: unknown) => c)).toMatchObject({
      kind: 'not_found',
      status: 410,
    });
  });
});

describe('LiveLineTransport credentials', () => {
  it('asks for a fresh token once after a 401', async () => {
    const { transport, getChannelAccessToken, requests } = transportFor([
      jsonResponse(401, { message: 'Authentication failed' }),
      jsonResponse(200, { type: 'none' }),
    ]);
    await transport.getQuota();
    expect(getChannelAccessToken).toHaveBeenCalledTimes(2);
    expect(getChannelAccessToken).toHaveBeenLastCalledWith({ forceRefresh: true });
    expect(requests).toHaveLength(2);
  });

  it('never puts the access token into an error', async () => {
    const { transport } = transportFor([jsonResponse(401, {}), jsonResponse(401, {})]);
    const error = (await transport.getQuota().catch((c: unknown) => c)) as Error;
    expect(error).toMatchObject({ kind: 'auth' });
    expect(`${error.message} ${error.stack ?? ''} ${JSON.stringify(error)}`).not.toContain(token);
  });

  it('rejects a response that does not match the schema', async () => {
    const { transport } = transportFor([jsonResponse(200, { type: 'weird' })]);
    expect(await transport.getQuota().catch((c: unknown) => c)).toMatchObject({
      kind: 'invalid_response',
    });
  });
});
