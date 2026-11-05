import type { Database } from '@watchtower/db';
import type * as DomainModule from '@watchtower/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ACTIVE = { id: 'index-1', provider: 'local', model: 'bge-m3', dimensions: 4 };
const state = { active: ACTIVE as typeof ACTIVE | undefined, rows: [] as unknown[] };

// The domain pieces that need a database are replaced; the embedder, the redactor and the local
// adapter are the real ones, and the network is a stub of the global fetch.
vi.mock('@watchtower/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return {
    ...actual,
    createPolicyGate: () => ({}),
    createBudgetMonitor: () => ({}),
    resolveAiCaps: () => ({}),
    createAiGuard: () => ({ check: () => Promise.resolve({ allowed: true }) }),
    createAiRunRecorder: () => ({
      record: (row: unknown) => {
        state.rows.push(row);
        return Promise.resolve({ id: 'run-1' });
      },
    }),
    readActiveEmbeddingIndex: () => Promise.resolve(state.active),
  };
});

const { KbEmbeddingService, QUERY_EMBED_TIMEOUT_MS } = await import('./kb-embedding.service.js');

const build = (overrides: Record<string, unknown> = {}) =>
  new KbEmbeddingService(
    { db: {} } as unknown as Database,
    {
      EMBEDDING_PROVIDER: 'local',
      EMBEDDING_LOCAL_URL: 'http://embedder:11434',
      EMBEDDING_MODEL: 'bge-m3',
      EMBEDDING_DIMENSIONS: 4,
      ...overrides,
    } as never,
    { warn: vi.fn() } as never,
  );

afterEach(() => {
  vi.unstubAllGlobals();
  state.active = ACTIVE;
  state.rows = [];
});

describe('KbEmbeddingService with the local embedder (T-431)', () => {
  it('returns the vector and the index id when the embedder answers', async () => {
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) as unknown });
      return Promise.resolve(
        new Response(JSON.stringify({ embeddings: [[1, 0, 0, 0]], prompt_eval_count: 2 }), {
          status: 200,
        }),
      );
    });
    const result = await build().embedQuery('จอง queue ไม่ได้');
    expect(result).toEqual({ vector: [1, 0, 0, 0], indexId: 'index-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'http://embedder:11434/api/embed' });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ provider: 'local', model: 'bge-m3', costUsd: 0 });
  });

  it('falls back to keyword (undefined) when the embedder is down, without retrying', async () => {
    const fetchStub = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    vi.stubGlobal('fetch', fetchStub);
    expect(await build().embedQuery('anything')).toBeUndefined();
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('falls back to keyword when the embedder is slower than the query timeout', async () => {
    vi.stubGlobal(
      'fetch',
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'TimeoutError'));
          });
        }),
    );
    const started = Date.now();
    expect(await build().embedQuery('slow')).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(QUERY_EMBED_TIMEOUT_MS + 1500);
  });

  it('does not call the embedder while the active index is from another model', async () => {
    state.active = { ...ACTIVE, model: 'old-model' };
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    expect(await build().embedQuery('x')).toBeUndefined();
    expect(fetchStub).not.toHaveBeenCalled();
    state.active = undefined;
    expect(await build().embedQuery('x')).toBeUndefined();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('refuses at boot a URL that is not loopback or a configured service name', () => {
    expect(() => build({ EMBEDDING_LOCAL_URL: 'http://api.example.com:11434' })).toThrow(
      /loopback or a configured embedder service name/,
    );
    // A bare single-label name that is not the embedder is refused too (T-435 C-3).
    expect(() => build({ EMBEDDING_LOCAL_URL: 'http://redis:6379' })).toThrow(
      /loopback or a configured embedder service name/,
    );
  });

  it('refuses at boot a local provider without the model or size', () => {
    expect(() => build({ EMBEDDING_MODEL: '' })).toThrow(/EMBEDDING_MODEL/);
  });
});
