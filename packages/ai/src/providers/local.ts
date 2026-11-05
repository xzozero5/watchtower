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
/** A body cap in bytes: a 1024-float vector is about 20 KB as JSON, so this holds a batch with room to spare. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

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
  /** Exact service names besides the loopback that may be called. Default `['embedder']`. */
  readonly allowedHosts?: readonly string[];
  /** Waits between retries; tests pass a no-op. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The compose service of the embedder (ADR-030). */
export const DEFAULT_LOCAL_EMBEDDING_HOSTS: readonly string[] = ['embedder'];

/** A host name in `EMBEDDING_LOCAL_HOSTS`: one label, as a compose service name is. */
const SERVICE_NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * Parses `EMBEDDING_LOCAL_HOSTS` (comma separated service names). Empty or absent gives the default.
 * A name that is not a single plain label (a dotted name, an IP) stops the boot.
 */
export function parseLocalEmbeddingHosts(raw: string | undefined): readonly string[] {
  const names = (raw ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');
  if (names.length === 0) return DEFAULT_LOCAL_EMBEDDING_HOSTS;
  for (const name of names) {
    if (!SERVICE_NAME.test(name)) {
      throw new ProviderConfigError(
        'local embedding adapter: EMBEDDING_LOCAL_HOSTS holds a name that is not a single service name',
      );
    }
  }
  return names;
}

/**
 * Only the loopback or one of the exact configured service names (default: `embedder`) may be
 * called. A bare single-label name is not enough: `metadata`, `redis` or an intranet name would
 * resolve too (T-435 C-3). Any other IP literal, any dotted name and any scheme but http(s) are refused.
 */
export function assertLocalEmbeddingUrl(
  raw: string,
  allowedHosts: readonly string[] = DEFAULT_LOCAL_EMBEDDING_HOSTS,
): URL {
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
  if (!LOOPBACK.has(host) && !allowedHosts.includes(host)) {
    throw new ProviderConfigError(
      'local embedding adapter: the host must be loopback or a configured embedder service name',
    );
  }
  return url;
}

/**
 * Reads the body but stops, and cancels the stream, once it passes the cap, so a peer that answers
 * without end cannot fill memory (T-435 C-4). A `content-length` over the cap is refused unread.
 */
async function readCapped(response: globalThis.Response): Promise<string> {
  const tooLarge = (): ProviderError =>
    new ProviderError('local', 'response_too_large', null, false);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const retryableStatus =(status: number): boolean => status === 429 || status >= 500;

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
  const base = assertLocalEmbeddingUrl(config.url, config.allowedHosts);
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
        const text = await readCapped(response);
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
