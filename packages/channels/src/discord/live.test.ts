import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import {
  jsonResponse,
  recordingSleep,
  scriptedFetch,
  timeoutError,
  type ScriptStep,
} from '../common/__fixtures__/scripted-fetch.js';
import { ChannelError } from '../common/errors.js';
import { randomWebhookParts } from './__fixtures__/random-webhook.js';
import { LiveDiscordTransport, type LiveDiscordOptions } from './live.js';
import { MAX_RATE_LIMIT_WAIT_MS } from './rate-limit.js';
import { DiscordWebhook } from './webhook.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const parts = randomWebhookParts();
const webhook = DiscordWebhook.parse(parts.url);
const message = { content: 'hello' };

function transportFor(
  steps: readonly ScriptStep[],
  options: Partial<LiveDiscordOptions> & { now?: () => number } = {},
) {
  const scripted = scriptedFetch(steps);
  const { sleep, delays } = recordingSleep();
  const transport = new LiveDiscordTransport({
    fetch: scripted.fetch,
    http: { sleep, random: () => 0, ...(options.now === undefined ? {} : { now: options.now }) },
    ...options,
  });
  return { transport, delays, ...scripted };
}

const created = (headers: Record<string, string> = {}) =>
  jsonResponse(200, { id: '1234567890123456789' }, headers);

async function failureOf(work: Promise<unknown>): Promise<ChannelError> {
  const caught = await work.then(
    () => null,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(ChannelError);
  return caught as ChannelError;
}

describe('LiveDiscordTransport request (checked against the Execute Webhook docs, 2026-11-01)', () => {
  it('POSTs JSON with wait=true to discord.com and returns the created message id as delivered', async () => {
    const { transport, requests } = transportFor([created()]);
    const result = await transport.execute(webhook, message);
    expect(result).toEqual({ delivered: true, messageId: '1234567890123456789' });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.method).toBe('POST');
    expect(new URL(request?.url ?? '').hostname).toBe('discord.com');
    expect(request?.url).toBe(`${parts.url}?wait=true`);
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.hasSignal).toBe(true);
    expect(JSON.parse(request?.body ?? '{}')).toEqual({
      content: 'hello',
      allowed_mentions: { parse: [] },
    });
  });

  it('accepts a 204 and a body without an id', async () => {
    const { transport } = transportFor([new Response(null, { status: 204 })]);
    await expect(transport.execute(webhook, message)).resolves.toEqual({
      delivered: true,
      messageId: null,
    });
  });

  it('never follows a redirect: a 3xx answer is an error and no second request is made', async () => {
    const { transport, requests } = transportFor([
      new Response(null, { status: 307, headers: { location: 'https://evil.example/steal' } }),
    ]);
    const error = await failureOf(transport.execute(webhook, message));
    expect(error.kind).toBe('invalid_response');
    expect(requests).toHaveLength(1);
  });

  it('passes redirect: manual to fetch', async () => {
    let init: RequestInit | undefined;
    const transport = new LiveDiscordTransport({
      fetch: (_url, requestInit) => {
        init = requestInit;
        return Promise.resolve(created());
      },
    });
    await transport.execute(webhook, message);
    expect(init?.redirect).toBe('manual');
  });
});

describe('LiveDiscordTransport errors', () => {
  it('refuses an invalid message before any request', async () => {
    const { transport, requests } = transportFor([]);
    const error = await failureOf(transport.execute(webhook, { content: 'x'.repeat(2001) }));
    expect(error.kind).toBe('client');
    expect(requests).toHaveLength(0);
  });

  it('maps 400 to client and never copies Discord text or the token', async () => {
    const { transport } = transportFor([
      jsonResponse(400, { message: `bad request for ${parts.token}`, code: 50035 }),
    ]);
    const error = await failureOf(transport.execute(webhook, message));
    expect(error.kind).toBe('client');
    expect(error.code).toBe('invalid_request');
    expect(`${error.message} ${JSON.stringify(error)} ${String(error.stack)}`).not.toContain(
      parts.token,
    );
  });

  it.each([
    [404, 'not_found', 'webhook_gone'],
    [410, 'not_found', 'webhook_gone'],
    [401, 'auth', 'webhook_unauthorized'],
    [403, 'auth', 'webhook_unauthorized'],
  ])('treats %i as a dead webhook and stops calling it', async (status, kind, code) => {
    const { transport, requests } = transportFor([jsonResponse(status, { message: 'x' })]);
    const first = await failureOf(transport.execute(webhook, message));
    expect(first.kind).toBe(kind);
    expect(first.code).toBe(code);
    expect(first.retryable).toBe(false);
    // The next post fails locally, with no request: Discord restricts clients that keep calling a dead webhook.
    const second = await failureOf(transport.execute(webhook, message));
    expect(second.kind).toBe('not_found');
    expect(requests).toHaveLength(1);
  });

  it('tries a dead webhook again after deadWebhookMs', async () => {
    let now = 5_000;
    const { transport, requests } = transportFor([jsonResponse(404, {}), created()], {
      now: () => now,
      deadWebhookMs: 1000,
    });
    await failureOf(transport.execute(webhook, message));
    now += 1001;
    await expect(transport.execute(webhook, message)).resolves.toMatchObject({ delivered: true });
    expect(requests).toHaveLength(2);
  });

  it('does not retry a 5xx or a timeout: the outcome is unknown and there is no idempotency key', async () => {
    const server = transportFor([jsonResponse(502, {})]);
    const serverError = await failureOf(server.transport.execute(webhook, message));
    expect(serverError.kind).toBe('server');
    expect(serverError.outcomeUnknown).toBe(true);
    expect(server.requests).toHaveLength(1);

    const slow = transportFor([timeoutError()]);
    const timeout = await failureOf(slow.transport.execute(webhook, message));
    expect(timeout.kind).toBe('timeout');
    expect(slow.requests).toHaveLength(1);
  });
});

describe('LiveDiscordTransport rate limits (read from headers, never hard-coded)', () => {
  it('honours Retry-After on a 429 that fits the inline wait, then succeeds', async () => {
    const { transport, requests, delays } = transportFor([
      jsonResponse(
        429,
        { message: 'You are being rate limited.', retry_after: 1.5, global: false },
        { 'retry-after': '2', 'x-ratelimit-scope': 'user' },
      ),
      created(),
    ]);
    await expect(transport.execute(webhook, message)).resolves.toMatchObject({ delivered: true });
    expect(requests).toHaveLength(2);
    expect(delays).toEqual([2000]);
  });

  it('reads a fractional Retry-After (seconds) instead of treating it as a date', async () => {
    const { transport, delays } = transportFor([
      jsonResponse(429, { retry_after: 0.75 }, { 'retry-after': '0.75' }),
      created(),
    ]);
    await transport.execute(webhook, message);
    expect(delays).toEqual([750]);
  });

  it('falls back to the JSON retry_after when the header is missing', async () => {
    const { transport, delays } = transportFor([
      jsonResponse(429, { message: 'slow down', retry_after: 1.2, global: false }),
      created(),
    ]);
    await transport.execute(webhook, message);
    // No header: the HttpClient backoff (random 0) applies, and the body value decided that the wait fits.
    expect(delays).toHaveLength(1);
  });

  it('does not sleep a long Retry-After inside the call: returns rate_limited with retryAfterMs', async () => {
    const { transport, requests, delays } = transportFor([
      jsonResponse(429, { retry_after: 90, global: false }, { 'retry-after': '90' }),
    ]);
    const error = await failureOf(transport.execute(webhook, message));
    expect(error.kind).toBe('rate_limited');
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(90_000);
    expect(requests).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it('caps a hostile Retry-After in the error it reports (F-5)', async () => {
    const { transport } = transportFor([
      jsonResponse(429, { retry_after: 1e308 }, { 'retry-after': '99999999' }),
    ]);
    const error = await failureOf(transport.execute(webhook, message));
    expect(error.retryAfterMs).toBe(MAX_RATE_LIMIT_WAIT_MS);
    const bodyOnly = transportFor([jsonResponse(429, { retry_after: 1e308 })]);
    expect((await failureOf(bodyOnly.transport.execute(webhook, message))).retryAfterMs).toBe(
      MAX_RATE_LIMIT_WAIT_MS,
    );
  });

  it('gives up after a second 429 and reports the wait Discord asked for', async () => {
    const limited = () => jsonResponse(429, { retry_after: 1 }, { 'retry-after': '1' });
    const { transport, requests } = transportFor([limited(), limited()]);
    const error = await failureOf(transport.execute(webhook, message));
    expect(error.kind).toBe('rate_limited');
    expect(error.retryAfterMs).toBe(1000);
    expect(requests).toHaveLength(2);
  });

  it('waits for an exhausted bucket (X-RateLimit-Remaining 0) before the next post', async () => {
    let now = 10_000;
    const { transport, requests, delays } = transportFor(
      [
        created({
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset-after': '1.5',
          'x-ratelimit-bucket': 'abc123',
        }),
        created(),
      ],
      { now: () => now },
    );
    await transport.execute(webhook, message);
    await transport.execute(webhook, message);
    expect(requests).toHaveLength(2);
    expect(delays).toEqual([1500]);
    now += 2000;
  });

  it('does not wait when the bucket still has room, or after it reset', async () => {
    let now = 10_000;
    const { transport, delays } = transportFor(
      [
        created({ 'x-ratelimit-remaining': '3', 'x-ratelimit-reset-after': '5' }),
        created({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '1' }),
        created(),
      ],
      { now: () => now },
    );
    await transport.execute(webhook, message);
    await transport.execute(webhook, message);
    now += 1001;
    await transport.execute(webhook, message);
    expect(delays).toEqual([]);
  });

  it('refuses locally, without a request, when the bucket is exhausted for longer than the inline wait', async () => {
    const { transport, requests } = transportFor(
      [created({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '30' })],
      { now: () => 10_000 },
    );
    await transport.execute(webhook, message);
    const error = await failureOf(transport.execute(webhook, message));
    expect(error.kind).toBe('rate_limited');
    expect(error.code).toBe('bucket_exhausted');
    expect(error.retryAfterMs).toBe(30_000);
    expect(requests).toHaveLength(1);
  });

  it('keeps buckets per webhook: one webhook being limited does not hold another', async () => {
    const other = DiscordWebhook.parse(randomWebhookParts().url);
    const { transport, requests } = transportFor([
      created({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '30' }),
      created(),
    ]);
    await transport.execute(webhook, message);
    await expect(transport.execute(other, message)).resolves.toMatchObject({ delivered: true });
    expect(requests).toHaveLength(2);
  });

  it('a global 429 holds every webhook until it passes', async () => {
    const other = DiscordWebhook.parse(randomWebhookParts().url);
    const { transport, requests } = transportFor([
      jsonResponse(
        429,
        { retry_after: 60, global: true },
        { 'retry-after': '60', 'x-ratelimit-global': 'true', 'x-ratelimit-scope': 'global' },
      ),
    ]);
    await failureOf(transport.execute(webhook, message));
    const error = await failureOf(transport.execute(other, message));
    expect(error.code).toBe('bucket_exhausted');
    expect(requests).toHaveLength(1);
  });
});
