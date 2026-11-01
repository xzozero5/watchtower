/**
 * Discord rate limits, read from response headers and never hard-coded (PRD R-3.17):
 * `X-RateLimit-Remaining`, `X-RateLimit-Reset-After` (seconds, fractional), `X-RateLimit-Bucket`,
 * and on a 429 `Retry-After`, the JSON `retry_after` and `X-RateLimit-Global` / `-Scope`.
 * Webhooks are limited per webhook (`webhook id + token`), so the tracker keys by webhook id.
 *
 * This is a polite pre-check: it avoids requests we know will be refused. The authority is still
 * the 429 from Discord, which `LiveDiscordTransport` handles.
 */

const MAX_TRACKED = 1000;

/**
 * The longest wait any header or body value can impose, in milliseconds. Discord's real values are
 * seconds to minutes; this ceiling means a corrupt or hostile answer (`99999999`, `1e308`) cannot
 * switch every webhook off until the process restarts. `[ASSUMED]` ten minutes.
 */
export const MAX_RATE_LIMIT_WAIT_MS = 10 * 60 * 1000;

/** Seconds (possibly huge, possibly fractional) to whole milliseconds, never above the ceiling. */
export function boundedWaitMs(seconds: number): number {
  return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.ceil(seconds * 1000));
}

interface BucketState {
  bucket: string | null;
  remaining: number;
  resetAtMs: number;
}

function number(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export interface RateLimitObservation {
  readonly status: number;
  readonly headers: Headers;
  /** `retry_after` (seconds) from a 429 body, when the caller read it. */
  readonly bodyRetryAfterSeconds?: number | undefined;
}

export class DiscordRateLimiter {
  readonly #now: () => number;
  readonly #buckets = new Map<string, BucketState>();
  #globalUntilMs = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Milliseconds to wait before the next request to this webhook (0 = go now). */
  waitMs(webhookId: string): number {
    const now = this.#now();
    const global = Math.max(0, this.#globalUntilMs - now);
    const state = this.#buckets.get(webhookId);
    const bucket =
      state !== undefined && state.remaining <= 0 ? Math.max(0, state.resetAtMs - now) : 0;
    return Math.max(global, bucket);
  }

  /** Learns from a response. */
  observe(webhookId: string, observation: RateLimitObservation): void {
    const now = this.#now();
    const { headers, status } = observation;
    const remaining = number(headers.get('x-ratelimit-remaining'));
    const resetAfter = number(headers.get('x-ratelimit-reset-after'));
    const retryAfter =
      number(headers.get('retry-after')) ?? observation.bodyRetryAfterSeconds ?? undefined;

    if (status === 429) {
      const waitMs = boundedWaitMs(retryAfter ?? resetAfter ?? 1);
      const scope = headers.get('x-ratelimit-scope');
      if (headers.get('x-ratelimit-global') !== null || scope === 'global') {
        this.#globalUntilMs = Math.max(this.#globalUntilMs, now + waitMs);
      } else {
        this.#buckets.set(webhookId, {
          bucket: headers.get('x-ratelimit-bucket'),
          remaining: 0,
          resetAtMs: now + waitMs,
        });
      }
    } else if (remaining !== undefined && resetAfter !== undefined) {
      this.#buckets.set(webhookId, {
        bucket: headers.get('x-ratelimit-bucket'),
        remaining,
        resetAtMs: now + boundedWaitMs(resetAfter),
      });
    }
    this.#prune(now);
  }

  /** The bucket id Discord reported for a webhook, for logs. */
  bucketOf(webhookId: string): string | null {
    return this.#buckets.get(webhookId)?.bucket ?? null;
  }

  #prune(now: number): void {
    if (this.#buckets.size <= MAX_TRACKED) return;
    for (const [key, state] of this.#buckets) {
      if (state.resetAtMs <= now) this.#buckets.delete(key);
    }
  }
}
