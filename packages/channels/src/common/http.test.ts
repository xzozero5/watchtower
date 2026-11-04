import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import {
  jsonResponse,
  recordingSleep,
  scriptedFetch,
  timeoutError,
} from './__fixtures__/scripted-fetch.js';
import { ChannelError } from './errors.js';
import {
  HttpClient,
  MAX_RETRY_AFTER_MS,
  backoffDelayMs,
  parseRetryAfter,
  type HttpRequest,
} from './http.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const request = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({
  operation: 'test.op',
  url: 'https://api.example.com/x',
  method: 'GET',
  headers: {},
  retryMode: 'idempotent',
  ...overrides,
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds and HTTP dates', () => {
    expect(parseRetryAfter('3', 0)).toBe(3000);
    expect(
      parseRetryAfter('Wed, 21 Oct 2015 07:28:05 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')),
    ).toBe(5000);
    expect(
      parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:29:00 GMT')),
    ).toBe(0);
  });

  it('reads fractional seconds (Discord) and rounds up, never as a date', () => {
    expect(parseRetryAfter('1.5', 0)).toBe(1500);
    expect(parseRetryAfter('0.0004', 0)).toBe(1);
  });

  it('never believes more than an hour, in any of the three forms (T-125)', () => {
    expect(parseRetryAfter('86400', 0)).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter('99999999999', 0)).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter('7200.5', 0)).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter('Fri, 31 Dec 9999 23:59:59 GMT', 0)).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter('3600', 0)).toBe(3_600_000);
  });

  it('returns undefined for absent or garbage values', () => {
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter('soon', 0)).toBeUndefined();
  });
});

describe('backoffDelayMs', () => {
  const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000 };

  it('grows exponentially with full jitter and is capped', () => {
    expect(backoffDelayMs(1, policy, () => 0.999)).toBe(99);
    expect(backoffDelayMs(2, policy, () => 0.999)).toBe(199);
    expect(backoffDelayMs(3, policy, () => 0.999)).toBe(399);
    expect(backoffDelayMs(10, policy, () => 0.999)).toBe(999);
    expect(backoffDelayMs(3, policy, () => 0)).toBe(0);
  });
});

describe('HttpClient', () => {
  it('returns the response on success and passes a timeout signal', async () => {
    const { fetch, requests } = scriptedFetch([jsonResponse(200, { ok: true })]);
    const response = await new HttpClient({ provider: 'gmail', fetch }).send(request());
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.hasSignal).toBe(true);
  });

  it('retries 5xx on idempotent requests with backoff, then returns the final response', async () => {
    const { fetch, requests } = scriptedFetch([
      jsonResponse(503, {}),
      jsonResponse(500, {}),
      jsonResponse(200, {}),
    ]);
    const { sleep, delays } = recordingSleep();
    const response = await new HttpClient({
      provider: 'gmail',
      fetch,
      sleep,
      random: () => 0.5,
    }).send(request());
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(3);
    expect(delays).toEqual([250, 500]); // 0.5 * (500, 1000)
  });

  it('gives up after maxAttempts and returns the last response', async () => {
    const { fetch, requests } = scriptedFetch([
      jsonResponse(503, {}),
      jsonResponse(503, {}),
      jsonResponse(503, {}),
    ]);
    const { sleep } = recordingSleep();
    const response = await new HttpClient({
      provider: 'gmail',
      fetch,
      sleep,
      retry: { maxAttempts: 3 },
    }).send(request());
    expect(response.status).toBe(503);
    expect(requests).toHaveLength(3);
  });

  it('honours Retry-After on 429 instead of guessing, capped by maxDelayMs', async () => {
    const { fetch } = scriptedFetch([
      jsonResponse(429, {}, { 'retry-after': '7' }),
      jsonResponse(429, {}, { 'retry-after': '3600' }),
      jsonResponse(200, {}),
    ]);
    const { sleep, delays } = recordingSleep();
    await new HttpClient({ provider: 'line', fetch, sleep, retry: { maxDelayMs: 20_000 } }).send(
      request(),
    );
    expect(delays).toEqual([7000, 20_000]);
  });

  it('retries 429 but not 5xx when a repeat is not safe (rejected_only)', async () => {
    const { fetch, requests } = scriptedFetch([jsonResponse(429, {}), jsonResponse(500, {})]);
    const { sleep } = recordingSleep();
    const response = await new HttpClient({ provider: 'gmail', fetch, sleep }).send(
      request({ method: 'POST', retryMode: 'rejected_only' }),
    );
    expect(response.status).toBe(500);
    expect(requests).toHaveLength(2);
  });

  it('retries a timeout on idempotent requests', async () => {
    const { fetch, requests } = scriptedFetch([timeoutError(), jsonResponse(200, {})]);
    const { sleep } = recordingSleep();
    const response = await new HttpClient({ provider: 'gmail', fetch, sleep }).send(request());
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(2);
  });

  it('does not retry a timeout when a repeat is not safe, and reports an unknown outcome', async () => {
    const { fetch, requests } = scriptedFetch([timeoutError(), jsonResponse(200, {})]);
    const error = await new HttpClient({ provider: 'gmail', fetch })
      .send(request({ method: 'POST', retryMode: 'rejected_only' }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error).toMatchObject({ kind: 'timeout', outcomeUnknown: true, retryable: true });
    expect(requests).toHaveLength(1);
  });

  it('turns a network error into a ChannelError without echoing its message', async () => {
    const { fetch } = scriptedFetch([
      new Error('connect ECONNREFUSED 10.0.0.1:443 secret-token-in-url'),
    ]);
    const { sleep } = recordingSleep();
    const error = (await new HttpClient({
      provider: 'line',
      fetch,
      sleep,
      retry: { maxAttempts: 1 },
    })
      .send(request())
      .catch((caught: unknown) => caught)) as ChannelError;
    expect(error.kind).toBe('network');
    expect(String(error)).not.toContain('secret-token');
    expect(String(error.cause)).not.toContain('secret-token');
  });

  it('lets the caller veto a 429 retry', async () => {
    const { fetch, requests } = scriptedFetch([
      jsonResponse(429, { message: 'stop' }),
      jsonResponse(200, {}),
    ]);
    const { sleep } = recordingSleep();
    const response = await new HttpClient({ provider: 'line', fetch, sleep }).send(
      request({ retryOn429: () => Promise.resolve(false) }),
    );
    expect(response.status).toBe(429);
    expect(requests).toHaveLength(1);
  });
});
