import { ChannelError, type ChannelProvider } from './errors.js';

/**
 * The only way a live transport reaches the network: an injected `fetch`. Nothing in this package
 * calls the global `fetch` and nothing constructs a client that probes for credentials (no ADC
 * metadata-server lookups, phase-1-breakdown section F item 4).
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Returns a bearer token. `forceRefresh` is set after a 401 so the provider can mint a new one. */
export type TokenProvider = (options?: { readonly forceRefresh?: boolean }) => Promise<string>;

export interface RetryPolicy {
  /** Total attempts including the first one. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * - `idempotent`: repeating the request is safe (GET, or a request carrying a provider idempotency
 *   key). Retries on 429, 5xx, timeouts and network errors.
 * - `rejected_only`: repeating is not safe when the outcome is unknown (Gmail send, LINE reply).
 *   Retries only after a 429, which means the provider refused the request.
 */
export type RetryMode = 'idempotent' | 'rejected_only';

export interface HttpClientOptions {
  readonly provider: ChannelProvider;
  readonly fetch: FetchLike;
  readonly timeoutMs?: number;
  readonly retry?: Partial<RetryPolicy>;
  /** Tests inject these; production uses real timers and `Math.random`. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
}

export interface HttpRequest {
  readonly operation: string;
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly retryMode: RetryMode;
  /** Per-call timeout override, for example for a media download. */
  readonly timeoutMs?: number;
  /**
   * Decides whether a 429 is worth retrying; it receives a clone, so it may read the body. Default:
   * always retry. A monthly-quota 429 is not transient, so a transport can say no here.
   */
  readonly retryOn429?: (response: Response) => Promise<boolean>;
}

/** `Retry-After` is either delta-seconds or an HTTP date. Returns milliseconds, or undefined. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // Discord answers with fractional seconds ("1.5"); without this the text would parse as a date.
  if (/^\d+\.\d+$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - nowMs);
}

/** Full-jitter exponential backoff: random in [0, min(maxDelay, base * 2^(attempt-1))]. */
export function backoffDelayMs(attempt: number, policy: RetryPolicy, random: () => number): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * Sends one logical request with timeout, retry and backoff. Rate limits come from the response
 * (`Retry-After`), never from constants in this package. Returns the final response whatever its
 * status; the caller maps provider error bodies. Throws `ChannelError` only for failures with no
 * response (timeout, network) once the retry budget is spent. What happens after the budget is
 * spent (outbox retry, dead-letter) belongs to the caller: the thrown error says whether the
 * outcome is unknown.
 */
export class HttpClient {
  readonly #options: HttpClientOptions;
  readonly #policy: RetryPolicy;

  constructor(options: HttpClientOptions) {
    this.#options = options;
    this.#policy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  }

  async send(request: HttpRequest): Promise<Response> {
    const { provider } = this.#options;
    const sleep = this.#options.sleep ?? defaultSleep;
    const random = this.#options.random ?? Math.random;
    const now = this.#options.now ?? Date.now;
    const timeoutMs = request.timeoutMs ?? this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    for (let attempt = 1; ; attempt += 1) {
      const lastAttempt = attempt >= this.#policy.maxAttempts;
      let response: Response;
      try {
        const init: RequestInit = {
          method: request.method,
          headers: request.headers,
          signal: AbortSignal.timeout(timeoutMs),
        };
        if (request.body !== undefined) init.body = request.body;
        response = await this.#options.fetch(request.url, init);
      } catch (error) {
        if (request.retryMode === 'idempotent' && !lastAttempt) {
          await sleep(backoffDelayMs(attempt, this.#policy, random));
          continue;
        }
        throw new ChannelError({
          provider,
          operation: request.operation,
          kind: isTimeout(error) ? 'timeout' : 'network',
          // Keep only the error class, not its message, which may echo a URL or header.
          cause: error instanceof Error ? error.name : undefined,
        });
      }

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now());
      const retryable =
        (response.status === 429 &&
          (request.retryOn429 === undefined || (await request.retryOn429(response.clone())))) ||
        (request.retryMode === 'idempotent' && response.status >= 500 && response.status <= 599);
      if (retryable && !lastAttempt) {
        await response.body?.cancel();
        const jitter = backoffDelayMs(attempt, this.#policy, random);
        const delay =
          retryAfterMs === undefined ? jitter : Math.min(this.#policy.maxDelayMs, retryAfterMs);
        await sleep(delay);
        continue;
      }
      return response;
    }
  }
}
