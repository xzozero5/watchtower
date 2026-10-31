import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createReplayFetch, forbiddenFetch } from '../testing/replay-fetch.js';
import { buildLlmRequest } from '../testing/requests.js';
import { createAnthropicProvider } from './anthropic.js';
import { ProviderConfigError, ProviderError } from './sdk.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/anthropic-messages.json', import.meta.url), 'utf8'),
) as unknown;

// A made-up value that only has to be non-empty. It is not a credential.
const FAKE_KEY = 'test-key-not-a-secret';

describe('anthropic adapter', () => {
  it('refuses to construct without explicit config', () => {
    const build = (config: object) => () =>
      createAnthropicProvider(config as Parameters<typeof createAnthropicProvider>[0]);
    expect(build({ fetch: forbiddenFetch })).toThrow(ProviderConfigError);
    expect(build({ apiKey: '', fetch: forbiddenFetch })).toThrow(ProviderConfigError);
    expect(build({ apiKey: '  ', fetch: forbiddenFetch })).toThrow(ProviderConfigError);
    expect(build({ apiKey: FAKE_KEY })).toThrow(ProviderConfigError);
  });

  it('does not fall back to the environment for key or base URL', () => {
    const previous = { key: process.env.ANTHROPIC_API_KEY, url: process.env.ANTHROPIC_BASE_URL };
    process.env.ANTHROPIC_API_KEY = 'env-key-must-not-be-used';
    process.env.ANTHROPIC_BASE_URL = 'https://env.invalid/v1';
    try {
      expect(() => createAnthropicProvider({ apiKey: '', fetch: forbiddenFetch })).toThrow(
        ProviderConfigError,
      );
    } finally {
      if (previous.key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous.key;
      if (previous.url === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = previous.url;
    }
  });

  it('maps a request and replays the fixture through the injected fetch only', async () => {
    const replay = createReplayFetch(() => ({ json: fixture }));
    const provider = createAnthropicProvider({ apiKey: FAKE_KEY, fetch: replay.fetch });
    const { request, restore } = buildLlmRequest(undefined, {
      maxOutputTokens: 256,
      temperature: 0,
    });

    const response = await provider.generate(request);

    expect(provider.kind).toBe('anthropic');
    expect(response).toEqual({
      text: 'Category: access_issue. Reply to [NAME_1] at [EMAIL_1].',
      finishReason: 'stop',
      usage: { inputTokens: 42, outputTokens: 17 },
      model: 'fixture-model-standard',
    });
    expect(restore(response.text)).toBe(
      'Category: access_issue. Reply to Somchai at somchai@example.com.',
    );

    expect(replay.requests).toHaveLength(1);
    const sent = replay.requests[0];
    expect(sent?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent?.method).toBe('POST');
    expect(sent?.headers['x-api-key']).toBe(FAKE_KEY);
    const body = sent?.body as Record<string, unknown>;
    expect(body.model).toBe('fixture-model-standard');
    expect(body.max_tokens).toBe(256);
    // The provider saw redacted text only.
    const wire = JSON.stringify(body);
    expect(wire).toContain('[NAME_1]');
    expect(wire).toContain('[EMAIL_1]');
    expect(wire).not.toContain('somchai@example.com');
    expect(wire).not.toContain('Somchai');
    // No telemetry or tracing payload rides along.
    expect(wire).not.toMatch(/telemetry|otel|trace/i);
  });

  it('bounds output tokens even when the request sets no limit', async () => {
    const replay = createReplayFetch(() => ({ json: fixture }));
    const provider = createAnthropicProvider({ apiKey: FAKE_KEY, fetch: replay.fetch });
    await provider.generate(buildLlmRequest().request);
    expect((replay.requests[0]?.body as Record<string, unknown>).max_tokens).toBe(1024);
  });

  it('maps error responses to ProviderError without leaking the payload', async () => {
    const replay = createReplayFetch(() => ({
      status: 429,
      json: {
        type: 'error',
        error: { type: 'rate_limit_error', message: 'echo: somchai@example.com' },
      },
    }));
    const provider = createAnthropicProvider({
      apiKey: FAKE_KEY,
      fetch: replay.fetch,
      maxRetries: 0,
    });
    const { request } = buildLlmRequest();

    const error = await provider.generate(request).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.statusCode).toBe(429);
    expect(providerError.retryable).toBe(true);
    expect(providerError.message).not.toContain('somchai');
    expect(replay.requests).toHaveLength(1);
  });

  it('never uses the global fetch', async () => {
    const original = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = (...args: unknown[]) => {
      calls.push(args);
      throw new Error('global fetch must not be used');
    };
    try {
      const replay = createReplayFetch(() => ({ json: fixture }));
      const provider = createAnthropicProvider({ apiKey: FAKE_KEY, fetch: replay.fetch });
      await provider.generate(buildLlmRequest().request);
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toHaveLength(0);
  });
});
