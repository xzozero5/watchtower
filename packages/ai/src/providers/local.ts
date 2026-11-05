/**
 * Local embedding adapter (ADR-030): an Ollama server in this deployment (the `embedder` compose
 * service) behind `EmbeddingProvider`. Nothing leaves the machine and the call is free.
 *
 * Ollama `POST /api/embed` takes `{ model, input: string[] }` and answers
 * `{ model, embeddings: number[][], prompt_eval_count }` (checked against the Ollama API doc, see
 * ADR-030 Links). The adapter adds what the server does not: a host allow-list (a typo or a
 * poisoned setting must not send redacted text to an outside host), a timeout per attempt, a
 * bounded retry, and a cap on texts per request.
 */
import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResponse } from '../contract.js';
import { ProviderConfigError, ProviderError, type FetchLike } from './sdk.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BATCH = 16;
/** A body cap: a 1024-float vector is about 20 KB as JSON, so this holds a batch with room to spare. */
const MAX_RESPONSE_CHARS = 8 * 1024 * 1024;

export interface LocalEmbeddingConfig {
  /** Base URL of the embedder, for example `http://embedder:11434`. */
  readonly url: string;
  /** Injected network access. Tests pass a fake. */
  readonly fetch: FetchLike;
  /** Milliseconds per attempt. Default 30000. */
  readonly timeoutMs?: number;
  /** Retries after the first attempt (network error, 429, 5xx). Default 2. */
  readonly maxRetries?: number;
  /** Most texts per HTTP request; a larger call is split. Default 16. */
  readonly batchSize?: number;
  /** Waits between retries; tests pass a no-op. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Only the loopback or a bare compose service name (no dot, so never an internet host name) may be
 * called. Any other IP literal, any dotted name and any scheme but http(s) are refused.
 */
export function assertLocalEmbeddingUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderConfigError('local embedding adapter: the URL is not valid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderConfigError('local embedding adapter: the URL must be http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ProviderConfigError('local embedding adapter: the URL must not carry credentials');
  }
  const host = url.hostname.toLowerCase();
  const serviceName = /^[a-z][a-z0-9_-]*$/.test(host);
  if (!LOOPBACK.has(host) && !serviceName) {
    throw new ProviderConfigError(
      'local embedding adapter: the host must be loopback or a compose service name',
    );
  }
  return url;
}

const retryableStatus = (status: number): boolean => status === 429 || status >= 500;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function parseEmbeddings(body: unknown, expected: number): number[][] {
  const embeddings = (body as { embeddings?: unknown } | null)?.embeddings;
  if (
    !Array.isArray(embeddings) ||
    embeddings.length !== expected ||
    !embeddings.every(
      (vector: unknown) =>
        Array.isArray(vector) &&
        vector.length > 0 &&
        vector.every((item: unknown) => typeof item === 'number' && Number.isFinite(item)),
    )
  ) {
    throw new ProviderError('local', 'bad_response', null, false);
  }
  return embeddings as number[][];
}

export function createLocalEmbeddingProvider(config: LocalEmbeddingConfig): EmbeddingProvider {
  if (typeof config.fetch !== 'function') {
    throw new ProviderConfigError('local embedding adapter requires an injected fetch');
  }
  const base = assertLocalEmbeddingUrl(config.url);
  const endpoint = new URL('/api/embed', base).toString();
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = config.maxRetries ?? DEFAULT_RETRIES;
  const batchSize = Math.max(1, Math.trunc(config.batchSize ?? DEFAULT_BATCH));
  const sleep = config.sleep ?? delay;
  const isAborted = (outer: AbortSignal | undefined): boolean => outer?.aborted === true;

  const post = async (
    model: string,
    input: readonly string[],
    outer: AbortSignal | undefined,
  ): Promise<{ embeddings: number[][]; tokens: number }> => {
    let last: ProviderError | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (isAborted(outer)) throw new ProviderError('local', 'aborted', null, false);
      if (attempt > 0) await sleep(Math.min(2000, 250 * 2 ** (attempt - 1)));
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = outer === undefined ? timeout : AbortSignal.any([outer, timeout]);
      try {
        const response = await config.fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input, truncate: true }),
          redirect: 'error',
          signal,
        });
        if (!response.ok) {
          const failure = new ProviderError(
            'local',
            'http_error',
            response.status,
            retryableStatus(response.status),
          );
          if (!failure.retryable) throw failure;
          last = failure;
          continue;
        }
        const text = await response.text();
        if (text.length > MAX_RESPONSE_CHARS) {
          throw new ProviderError('local', 'response_too_large', null, false);
        }
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          throw new ProviderError('local', 'bad_response', null, false);
        }
        const count = (body as { prompt_eval_count?: unknown } | null)?.prompt_eval_count;
        return {
          embeddings: parseEmbeddings(body, input.length),
          tokens:
            typeof count === 'number' && Number.isFinite(count) && count > 0
              ? Math.trunc(count)
              : 0,
        };
      } catch (error) {
        if (error instanceof ProviderError) {
          if (!error.retryable) throw error;
          last = error;
          continue;
        }
        if (isAborted(outer)) {
          throw new ProviderError('local', 'aborted', null, false, { cause: error });
        }
        // Timeout or a network error: another attempt may work.
        last = new ProviderError('local', 'network_error', null, true, { cause: error });
      }
    }
    throw last ?? new ProviderError('local', 'network_error', null, true);
  };

  return {
    kind: 'local',
    async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
      const embeddings: number[][] = [];
      let tokens = 0;
      for (let at = 0; at < request.values.length; at += batchSize) {
        const part = await post(
          request.model,
          request.values.slice(at, at + batchSize),
          request.abortSignal,
        );
        embeddings.push(...part.embeddings);
        tokens += part.tokens;
      }
      return { embeddings, usage: { tokens }, model: request.model };
    },
  };
}
