import { beforeEach, describe, expect, it } from 'vitest';

import { createAuditedEmbedder } from '../audited-embedding.js';
import { mockSettings, embeddingSettings } from '../models.js';
import type { AiRunRecord } from '../contract.js';
import { createRedactor } from '../redaction/redactor.js';
import { assertLocalEmbeddingUrl, createLocalEmbeddingProvider } from './local.js';
import { ProviderConfigError, ProviderError, type FetchLike } from './sdk.js';

/**
 * A fake Ollama behind the injected `fetch`: it answers `POST /api/embed` the way the documented API
 * does (no model, no network; packages/ai does not import node:http). The adapter is the real one.
 */
interface Seen {
  readonly body: { model: string; input: string[]; truncate?: boolean };
  readonly path: string;
}

const DIMENSIONS = 4;
const base = 'http://127.0.0.1:11434';
let seen: Seen[] = [];
/** What to answer with, one entry per request; once empty the fake behaves. */
let script: (number | 'hang' | 'garbage' | 'short')[] = [];

const vectorFor = (text: string): number[] =>
  Array.from({ length: DIMENSIONS }, (_, at) => ((text.length + at) % 7) / 10);

const json = (status: number, body: unknown): globalThis.Response =>
  new globalThis.Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const fakeOllama: FetchLike = (input, init) => {
  const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Seen['body'];
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  seen.push({ body, path: new URL(target).pathname });
  const next = script.shift();
  if (next === 'hang') {
    // Never answers: only the abort of the adapter's timeout ends it.
    return new Promise<globalThis.Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation timed out', 'TimeoutError'));
      });
    });
  }
  if (typeof next === 'number') return Promise.resolve(json(next, { error: 'busy' }));
  if (next === 'garbage') return Promise.resolve(json(200, 'not json'));
  const inputs = next === 'short' ? body.input.slice(1) : body.input;
  return Promise.resolve(
    json(200, {
      model: body.model,
      embeddings: inputs.map(vectorFor),
      prompt_eval_count: body.input.length * 3,
    }),
  );
};

beforeEach(() => {
  seen = [];
  script = [];
});

const noSleep = (): Promise<void> => Promise.resolve();
const provider = (extra: Partial<Parameters<typeof createLocalEmbeddingProvider>[0]> = {}) =>
  createLocalEmbeddingProvider({
    url: base,
    fetch: fakeOllama,
    sleep: noSleep,
    ...extra,
  });
/** Text only the redactor can brand as redacted (N4), so the tests go through it too. */
const values = (...texts: string[]) => {
  const session = createRedactor().session({ scope: 'test:local' });
  return texts.map((text) => session.redact(text));
};

describe('createLocalEmbeddingProvider (fake Ollama behind fetch)', () => {
  it('posts the documented request shape and returns one vector per text with the token count', async () => {
    const result = await provider().embed({ model: 'bge-m3', values: values('alpha', 'สวัสดี') });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('/api/embed');
    expect(seen[0]?.body).toEqual({ model: 'bge-m3', input: ['alpha', 'สวัสดี'], truncate: true });
    expect(result.embeddings).toEqual([vectorFor('alpha'), vectorFor('สวัสดี')]);
    expect(result.usage.tokens).toBe(6);
    expect(result.model).toBe('bge-m3');
  });

  it('splits a call larger than the batch cap and keeps the order', async () => {
    const texts = ['a', 'bb', 'ccc', 'dddd', 'eeeee'];
    const result = await provider({ batchSize: 2 }).embed({ model: 'm', values: values(...texts) });
    expect(seen.map((call) => call.body.input)).toEqual([['a', 'bb'], ['ccc', 'dddd'], ['eeeee']]);
    expect(result.embeddings).toEqual(texts.map(vectorFor));
  });

  it('retries a 503 and then succeeds', async () => {
    script = [503, 429];
    const result = await provider().embed({ model: 'm', values: values('x') });
    expect(seen).toHaveLength(3);
    expect(result.embeddings).toHaveLength(1);
  });

  it('gives up after the retries and reports a retryable ProviderError', async () => {
    script = [500, 500, 500, 500];
    const error = await provider({ maxRetries: 1 })
      .embed({ model: 'm', values: values('x') })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'http_error', statusCode: 500, retryable: true });
    expect(seen).toHaveLength(2);
  });

  it('does not retry a 4xx (a missing model is a 404)', async () => {
    script = [404];
    const error = await provider()
      .embed({ model: 'm', values: values('x') })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'http_error', statusCode: 404, retryable: false });
    expect(seen).toHaveLength(1);
  });

  it('times out a server that never answers', async () => {
    script = ['hang'];
    const error = await provider({ timeoutMs: 80, maxRetries: 0 })
      .embed({ model: 'm', values: values('x') })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'network_error', retryable: true });
  });

  it('refuses a body that is not JSON, or has the wrong number of vectors', async () => {
    script = ['garbage'];
    await expect(provider().embed({ model: 'm', values: values('x') })).rejects.toMatchObject({
      code: 'bad_response',
    });
    script = ['short'];
    await expect(provider().embed({ model: 'm', values: values('x', 'y') })).rejects.toMatchObject({
      code: 'bad_response',
    });
  });

  it('stops at once when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider().embed({ model: 'm', values: values('x'), abortSignal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(seen).toHaveLength(0);
  });
});

describe('host allow-list', () => {
  it.each([
    'http://embedder:11434',
    'http://localhost:11434',
    'http://127.0.0.1:11434',
    'http://[::1]:11434',
    'https://embedder',
  ])('accepts %s', (url) => {
    expect(() => assertLocalEmbeddingUrl(url)).not.toThrow();
  });

  it.each([
    'http://api.example.com',
    'http://embedder.example.com:11434',
    'http://10.0.0.5:11434',
    'http://169.254.169.254',
    'http://user:pass@embedder:11434',
    'ftp://embedder',
    'embedder:11434',
    '',
  ])('refuses %s', (url) => {
    expect(() => assertLocalEmbeddingUrl(url)).toThrow(ProviderConfigError);
    expect(() =>
      createLocalEmbeddingProvider({ url, fetch: () => Promise.reject(new Error('unused')) }),
    ).toThrow(ProviderConfigError);
  });
});

describe('through the audited embedder (redaction, ai_run, cost 0)', () => {
  it('redacts before the server sees the text and records a zero-cost ai_run row', async () => {
    const rows: AiRunRecord[] = [];
    const config = embeddingSettings({
      EMBEDDING_PROVIDER: 'local',
      EMBEDDING_MODEL: 'bge-m3',
      EMBEDDING_DIMENSIONS: DIMENSIONS,
    });
    const embedder = createAuditedEmbedder({
      settings: { load: () => Promise.resolve({ ...mockSettings(), ...config }) },
      providers: { local: provider() },
      sink: {
        record: (row) => {
          rows.push(row);
          return Promise.resolve({ id: 'run-1' });
        },
      },
      redactor: createRedactor(),
      guard: { check: () => Promise.resolve({ allowed: true }) },
    });
    const outcome = await embedder.embed({
      texts: ['Contact somchai@example.com about the outage'],
      scope: 'kb:test',
      action: 'kb_index',
    });
    expect(outcome.status).toBe('ok');
    const sent = seen[0]?.body.input[0] ?? '';
    expect(sent).not.toContain('somchai@example.com');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: 'embedder',
      provider: 'local',
      model: 'bge-m3',
      status: 'ok',
      costUsd: 0,
    });
    expect(rows[0]?.redaction.total).toBeGreaterThan(0);
  });
});

describe('embeddingSettings', () => {
  it('keeps the mock for EMBEDDING_PROVIDER=mock', () => {
    expect(embeddingSettings({ EMBEDDING_PROVIDER: 'mock' }).embedding.provider).toBe('mock');
  });

  it('takes model and size from the environment for local, priced at zero', () => {
    expect(
      embeddingSettings({
        EMBEDDING_PROVIDER: 'local',
        EMBEDDING_MODEL: 'x-model',
        EMBEDDING_DIMENSIONS: 768,
      }),
    ).toEqual({
      embedding: { provider: 'local', model: 'x-model', dimensions: 768 },
      prices: { 'x-model': { inputUsdPerMTok: 0, outputUsdPerMTok: 0 } },
    });
  });

  it('refuses local without a model or size', () => {
    expect(() =>
      embeddingSettings({ EMBEDDING_PROVIDER: 'local', EMBEDDING_DIMENSIONS: 8 }),
    ).toThrow(/EMBEDDING_MODEL/);
    expect(() => embeddingSettings({ EMBEDDING_PROVIDER: 'local', EMBEDDING_MODEL: 'm' })).toThrow(
      /EMBEDDING_DIMENSIONS/,
    );
  });
});
