import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createReplayFetch, forbiddenFetch } from '../testing/replay-fetch.js';
import { buildEmbeddingRequest, buildLlmRequest } from '../testing/requests.js';
import { ProviderConfigError } from './sdk.js';
import {
  createVertexClaudeProvider,
  createVertexEmbeddingProvider,
  createVertexProvider,
  type VertexProviderConfig,
} from './vertex.js';

const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
const gemini = readFixture('vertex-gemini-generate.json');
const embeddings = readFixture('vertex-embeddings.json');
const claude = readFixture('anthropic-messages.json');

// Made-up values; none of these is a credential.
const FAKE_KEY = 'test-key-not-a-secret';
const FAKE_TOKEN = 'test-token-not-a-secret';

const oauth = (fetchFn: VertexProviderConfig['fetch']): VertexProviderConfig => ({
  auth: {
    kind: 'accessToken',
    project: 'test-project-1',
    location: 'asia-southeast1',
    getAccessToken: () => Promise.resolve(FAKE_TOKEN),
  },
  fetch: fetchFn,
});

describe('vertex adapters: construction', () => {
  it('refuse to construct without explicit config (no ADC probing)', () => {
    const bad = (config: unknown) => () => createVertexProvider(config as VertexProviderConfig);
    expect(bad({ fetch: forbiddenFetch })).toThrow(ProviderConfigError);
    expect(bad({ auth: { kind: 'apiKey', apiKey: '' }, fetch: forbiddenFetch })).toThrow(
      ProviderConfigError,
    );
    expect(bad({ auth: { kind: 'apiKey', apiKey: FAKE_KEY } })).toThrow(ProviderConfigError);
    expect(bad({ auth: { kind: 'adc' }, fetch: forbiddenFetch })).toThrow(ProviderConfigError);
    expect(
      bad({
        auth: { kind: 'accessToken', project: '', location: 'x', getAccessToken: () => '' },
        fetch: forbiddenFetch,
      }),
    ).toThrow(ProviderConfigError);
    expect(
      bad({
        auth: {
          kind: 'accessToken',
          project: 'test-project-1',
          location: 'a/b',
          getAccessToken: () => Promise.resolve('t'),
        },
        fetch: forbiddenFetch,
      }),
    ).toThrow(ProviderConfigError);
    expect(() =>
      createVertexEmbeddingProvider({
        auth: { kind: 'apiKey', apiKey: '' },
        fetch: forbiddenFetch,
      }),
    ).toThrow(ProviderConfigError);
    expect(() =>
      createVertexClaudeProvider({
        project: '',
        location: 'asia-southeast1',
        getAccessToken: () => Promise.resolve('t'),
        fetch: forbiddenFetch,
      }),
    ).toThrow(ProviderConfigError);
  });

  it('constructing does not call fetch or the token source', () => {
    let tokenCalls = 0;
    createVertexProvider({
      auth: {
        kind: 'accessToken',
        project: 'test-project-1',
        location: 'asia-southeast1',
        getAccessToken: () => {
          tokenCalls += 1;
          return Promise.resolve(FAKE_TOKEN);
        },
      },
      fetch: forbiddenFetch,
    });
    expect(tokenCalls).toBe(0);
  });
});

describe('vertex Gemini adapter', () => {
  it('sends a Bearer token to the regional endpoint through the injected fetch', async () => {
    const replay = createReplayFetch(() => ({ json: gemini }));
    const provider = createVertexProvider(oauth(replay.fetch));
    const { request, restore } = buildLlmRequest(undefined, {
      model: 'fixture-model-light',
      tier: 'light',
      maxOutputTokens: 128,
    });

    const response = await provider.generate(request);

    expect(provider.kind).toBe('vertex');
    expect(response).toEqual({
      text: 'Summary for [NAME_1].',
      finishReason: 'stop',
      usage: { inputTokens: 30, outputTokens: 9 },
      model: 'fixture-model-light',
    });
    expect(restore(response.text)).toBe('Summary for Somchai.');

    expect(replay.requests).toHaveLength(1);
    const sent = replay.requests[0];
    expect(sent?.url).toBe(
      'https://asia-southeast1-aiplatform.googleapis.com/v1beta1/projects/test-project-1/locations/asia-southeast1/publishers/google/models/fixture-model-light:generateContent',
    );
    expect(sent?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(sent?.headers['x-goog-api-key']).toBeUndefined();
    const wire = JSON.stringify(sent?.body);
    expect(wire).toContain('[EMAIL_1]');
    expect(wire).not.toContain('somchai@example.com');
    expect(wire).not.toContain('Somchai');
  });

  it('supports express mode with an API key header', async () => {
    const replay = createReplayFetch(() => ({ json: gemini }));
    const provider = createVertexProvider({
      auth: { kind: 'apiKey', apiKey: FAKE_KEY },
      fetch: replay.fetch,
    });
    await provider.generate(buildLlmRequest().request);
    const sent = replay.requests[0];
    expect(sent?.url).toMatch(/^https:\/\/aiplatform\.googleapis\.com\//);
    expect(sent?.headers['x-goog-api-key']).toBe(FAKE_KEY);
    expect(sent?.headers.authorization).toBeUndefined();
  });

  it('never uses the global fetch or the Google metadata server', async () => {
    const original = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = (...args: unknown[]) => {
      calls.push(args);
      throw new Error('global fetch must not be used');
    };
    try {
      const replay = createReplayFetch(() => ({ json: gemini }));
      await createVertexProvider(oauth(replay.fetch)).generate(buildLlmRequest().request);
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toHaveLength(0);
  });
});

describe('vertex embedding adapter', () => {
  it('embeds redacted values and returns vectors and token usage', async () => {
    const replay = createReplayFetch(() => ({ json: embeddings }));
    const provider = createVertexEmbeddingProvider(oauth(replay.fetch));

    const response = await provider.embed(
      buildEmbeddingRequest(['reset password for a@b.com', 'billing question']),
    );

    expect(response.embeddings).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    expect(response.usage.tokens).toBe(10);
    const sent = replay.requests[0];
    expect(sent?.url).toContain(':predict');
    expect(sent?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(JSON.stringify(sent?.body)).not.toContain('a@b.com');
    expect(JSON.stringify(sent?.body)).toContain('[EMAIL_1]');
  });
});

describe('Claude on Vertex adapter', () => {
  it('uses rawPredict with the injected token and reports kind anthropic', async () => {
    const replay = createReplayFetch(() => ({ json: claude }));
    const provider = createVertexClaudeProvider({
      project: 'test-project-1',
      location: 'asia-southeast1',
      getAccessToken: () => Promise.resolve(FAKE_TOKEN),
      fetch: replay.fetch,
    });

    const response = await provider.generate(buildLlmRequest().request);

    expect(provider.kind).toBe('anthropic');
    expect(response.text).toContain('[NAME_1]');
    const sent = replay.requests[0];
    expect(sent?.url).toBe(
      'https://asia-southeast1-aiplatform.googleapis.com/v1/projects/test-project-1/locations/asia-southeast1/publishers/anthropic/models/fixture-model-standard:rawPredict',
    );
    expect(sent?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect((sent?.body as Record<string, unknown>).anthropic_version).toBe('vertex-2023-10-16');
    expect(JSON.stringify(sent?.body)).not.toContain('somchai@example.com');
  });
});
