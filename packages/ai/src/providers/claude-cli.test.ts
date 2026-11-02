import { describe, expect, it } from 'vitest';

import { forbiddenFetch } from '../testing/replay-fetch.js';
import { buildLlmRequest } from '../testing/requests.js';
import { createCliBridgeProvider } from './claude-cli.js';
import { ProviderConfigError, ProviderError, type FetchLike } from './sdk.js';

// Made-up value, not a credential.
const TOKEN = 'test-bridge-token-not-a-secret';
const URL_OK = 'http://host.docker.internal:4317';

function json(body: unknown, status = 200): globalThis.Response {
  return new globalThis.Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recorder(answer: () => globalThis.Response | Promise<globalThis.Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFake: FetchLike = (input, init) => {
    calls.push({ url: typeof input === 'string' ? input : 'non-string', init: init ?? {} });
    return Promise.resolve(answer());
  };
  return { fetchFake, calls };
}

describe('claude-cli adapter (ADR-017)', () => {
  it('refuses to construct without explicit config or with a non-local bridge', () => {
    const build = (config: object) => () =>
      createCliBridgeProvider(config as Parameters<typeof createCliBridgeProvider>[0]);
    expect(build({ bridgeUrl: URL_OK, token: '', fetch: forbiddenFetch })).toThrow(
      ProviderConfigError,
    );
    expect(build({ bridgeUrl: '', token: TOKEN, fetch: forbiddenFetch })).toThrow(
      ProviderConfigError,
    );
    expect(build({ bridgeUrl: URL_OK, token: TOKEN })).toThrow(ProviderConfigError);
    for (const bad of [
      'https://host.docker.internal:4317',
      'http://example.com:4317',
      'http://u:p@localhost:4317',
      'not a url',
    ]) {
      expect(build({ bridgeUrl: bad, token: TOKEN, fetch: forbiddenFetch }), bad).toThrow(
        ProviderConfigError,
      );
    }
    for (const good of [
      URL_OK,
      'http://localhost:4317',
      'http://127.0.0.1:4317',
      'http://[::1]:4317',
    ]) {
      expect(build({ bridgeUrl: good, token: TOKEN, fetch: forbiddenFetch }), good).not.toThrow();
    }
  });

  it('posts the redacted request with the bearer token and maps usage', async () => {
    const { request } = buildLlmRequest('Hello from Somchai, reach me at somchai@example.com');
    const { fetchFake, calls } = recorder(() =>
      json({
        text: 'ok [EMAIL_1]',
        model: 'claude-reported',
        usage: { inputTokens: 12, outputTokens: 3 },
      }),
    );
    const provider = createCliBridgeProvider({ bridgeUrl: URL_OK, token: TOKEN, fetch: fetchFake });
    expect(provider.kind).toBe('claude-cli');
    const response = await provider.generate(request);
    expect(response).toEqual({
      text: 'ok [EMAIL_1]',
      finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 3 },
      model: 'claude-reported',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://host.docker.internal:4317/v1/generate');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    const body = calls[0]?.init.body as string;
    expect(body).not.toContain('somchai@example.com');
    expect(JSON.parse(body)).toMatchObject({ model: request.model, messages: [{ role: 'user' }] });
  });

  it('falls back to the requested model when the bridge reports none', async () => {
    const { request } = buildLlmRequest();
    const { fetchFake } = recorder(() =>
      json({ text: 'x', usage: { inputTokens: 1, outputTokens: 1 } }),
    );
    const provider = createCliBridgeProvider({ bridgeUrl: URL_OK, token: TOKEN, fetch: fetchFake });
    expect((await provider.generate(request)).model).toBe(request.model);
  });

  it('turns bridge failures into ProviderError without echoing a body', async () => {
    const { request } = buildLlmRequest();
    const make = (answer: () => globalThis.Response) =>
      createCliBridgeProvider({
        bridgeUrl: URL_OK,
        token: TOKEN,
        fetch: recorder(answer).fetchFake,
      });
    const busy = await make(() => json({ error: 'busy' }, 429))
      .generate(request)
      .catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(ProviderError);
    expect(busy).toMatchObject({ code: 'busy', statusCode: 429, retryable: true });

    const denied = await make(() => json({ error: 'unauthorized' }, 401))
      .generate(request)
      .catch((e: unknown) => e);
    expect(denied).toMatchObject({ code: 'unauthorized', statusCode: 401, retryable: false });

    const garbage = await make(() => json({ nope: true }))
      .generate(request)
      .catch((e: unknown) => e);
    expect(garbage).toMatchObject({ code: 'BadBridgeResponse', retryable: false });
  });

  it('reports an unreachable bridge as a retryable ProviderError', async () => {
    const { request } = buildLlmRequest();
    const provider = createCliBridgeProvider({
      bridgeUrl: URL_OK,
      token: TOKEN,
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    const error = await provider.generate(request).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'BridgeUnreachable', retryable: true });
  });
});
