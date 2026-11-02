/**
 * Errors every read-only client may throw (ADR-015). `code` is a stable word, safe for a log and an
 * audit row; `message` never carries a query, a filter or a result (N4).
 */
export type ConnectorErrorCode =
  'rate_limited' | 'invalid_query' | 'not_connected' | 'timeout' | 'upstream';

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;

  constructor(code: ConnectorErrorCode, message: string) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
  }
}

/** The provider answered 429: the quota of the project is used up for now. */
export class ConnectorRateLimitedError extends ConnectorError {
  /** HTTP status the provider used. */
  readonly status = 429;
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super('rate_limited', 'The provider answered 429 (quota used up)');
    this.name = 'ConnectorRateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** The request was refused before it was sent (bad filter, a statement that is not a read, a bad range). */
export class ConnectorQueryRejectedError extends ConnectorError {
  constructor(message: string) {
    super('invalid_query', message);
    this.name = 'ConnectorQueryRejectedError';
  }
}

/** No client is configured for this system. */
export class ConnectorNotConnectedError extends ConnectorError {
  constructor(system: string) {
    super('not_connected', `${system} is not connected`);
    this.name = 'ConnectorNotConnectedError';
  }
}

export class ConnectorTimeoutError extends ConnectorError {
  constructor() {
    super('timeout', 'The request took longer than the limit');
    this.name = 'ConnectorTimeoutError';
  }
}

/** A time source in milliseconds since the epoch, injected so a test can move it. */
export type Clock = () => number;

/**
 * Where an answer came from. `fake`: made up in memory. `sandbox`: a real engine over invented data
 * (the local `product_mock` database). `live`: the real system. Only `live` is not mock data.
 */
export type ClientSource = 'fake' | 'sandbox' | 'live';

export const isMockSource = (source: ClientSource): boolean => source !== 'live';

/**
 * A sliding window of one minute over an injected clock, used by the fakes to answer 429 the way a
 * provider with a per-minute quota does. `perMinute` of 0 or less means no quota.
 */
export class MinuteQuota {
  readonly #perMinute: number;
  readonly #clock: Clock;
  readonly #hits: number[] = [];

  constructor(perMinute: number, clock: Clock) {
    this.#perMinute = perMinute;
    this.#clock = clock;
  }

  /** Counts one request or throws `ConnectorRateLimitedError`. */
  take(): void {
    if (this.#perMinute <= 0) return;
    const now = this.#clock();
    while (this.#hits.length > 0 && now - (this.#hits[0] ?? now) >= 60_000) this.#hits.shift();
    if (this.#hits.length >= this.#perMinute) {
      const oldest = this.#hits[0] ?? now;
      throw new ConnectorRateLimitedError(Math.max(1, 60_000 - (now - oldest)));
    }
    this.#hits.push(now);
  }
}
