import { z } from 'zod';

import { ChannelError, type ChannelFailureKind } from '../common/errors.js';
import {
  HttpClient,
  parseRetryAfter,
  type FetchLike,
  type HttpClientOptions,
} from '../common/http.js';
import {
  buildPayload,
  discordWebhookMessageSchema,
  type DiscordWebhookMessage,
} from './message.js';
import { DiscordRateLimiter } from './rate-limit.js';
import type { DiscordSendResult, DiscordTransport } from './transport.js';
import { DISCORD_WEBHOOK_HOST, type DiscordWebhook } from './webhook.js';

/**
 * Discord's Execute Webhook endpoint over HTTP, with an injected `fetch`. Nothing in this
 * repository runs it against Discord; unit tests drive it with a scripted `fetch` and the contract
 * suite reaches it only with `CONTRACT_LIVE=1` (`[ASK-HUMAN]`).
 *
 * Safety properties, each with a test:
 * - the destination is `discord.com` only: the URL is rebuilt from a parsed `DiscordWebhook`, and
 *   `redirect: 'manual'` means a 3xx answer cannot move the request (or the token) elsewhere;
 * - the webhook token never appears in an error, a log field or a thrown message;
 * - rate limits come from response headers (`LiveDiscordTransport` keeps a per-webhook bucket
 *   tracker and honours `Retry-After`); a wait longer than `maxInlineWaitMs` is not slept inside
 *   the request, it is returned as a `rate_limited` error with `retryAfterMs` for the caller's
 *   queue to schedule;
 * - a webhook that answers 401, 403, 404 or 410 is dead (Discord asks clients to stop using a
 *   deleted webhook, repeated attempts lead to a temporary ban): further posts to it fail locally
 *   for `deadWebhookMs` without touching the network.
 */

export interface LiveDiscordOptions {
  readonly fetch: FetchLike;
  readonly http?: Pick<HttpClientOptions, 'timeoutMs' | 'retry' | 'sleep' | 'random' | 'now'>;
  /** Longest wait that is slept inside one `execute`. Default 5,000 ms. */
  readonly maxInlineWaitMs?: number;
  /** How long a webhook that answered "gone" is left alone. Default 10 minutes. */
  readonly deadWebhookMs?: number;
}

const DEFAULT_MAX_INLINE_WAIT_MS = 5000;
const DEFAULT_DEAD_WEBHOOK_MS = 10 * 60 * 1000;

const createdMessageSchema = z.looseObject({ id: z.string().optional() });
const rateLimitedBodySchema = z.looseObject({ retry_after: z.number().optional() });

function failureKind(status: number): ChannelFailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  if (status >= 300 && status < 400) return 'invalid_response';
  return 'client';
}

export class LiveDiscordTransport implements DiscordTransport {
  readonly kind = 'live';

  readonly #http: HttpClient;
  readonly #limiter: DiscordRateLimiter;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #maxInlineWaitMs: number;
  readonly #deadWebhookMs: number;
  readonly #dead = new Map<string, number>();

  constructor(options: LiveDiscordOptions) {
    // A redirect would send the request (and the token in its path) wherever the answer says.
    const noRedirect: FetchLike = (input, init) =>
      options.fetch(input, { ...init, redirect: 'manual' });
    this.#http = new HttpClient({
      provider: 'discord',
      fetch: noRedirect,
      ...options.http,
      // Two tries at most inside one call: a 429 that fits the inline wait is retried once.
      retry: { maxAttempts: 2, baseDelayMs: 250, maxDelayMs: 10_000, ...options.http?.retry },
    });
    this.#now = options.http?.now ?? Date.now;
    this.#sleep =
      options.http?.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.#limiter = new DiscordRateLimiter(this.#now);
    this.#maxInlineWaitMs = options.maxInlineWaitMs ?? DEFAULT_MAX_INLINE_WAIT_MS;
    this.#deadWebhookMs = options.deadWebhookMs ?? DEFAULT_DEAD_WEBHOOK_MS;
  }

  async execute(
    webhook: DiscordWebhook,
    message: DiscordWebhookMessage,
  ): Promise<DiscordSendResult> {
    const operation = 'webhook.execute';
    if (!discordWebhookMessageSchema.safeParse(message).success) {
      throw new ChannelError({
        provider: 'discord',
        operation,
        kind: 'client',
        code: 'invalid_request',
      });
    }
    const url = webhook.executeUrl();
    // Defence in depth: the class already guarantees this.
    if (new URL(url).hostname !== DISCORD_WEBHOOK_HOST) {
      throw new ChannelError({ provider: 'discord', operation, kind: 'client', code: 'bad_host' });
    }

    const deadUntil = this.#dead.get(webhook.id);
    if (deadUntil !== undefined) {
      if (this.#now() < deadUntil) {
        throw new ChannelError({
          provider: 'discord',
          operation,
          kind: 'not_found',
          code: 'webhook_gone',
        });
      }
      this.#dead.delete(webhook.id);
    }

    const waitMs = this.#limiter.waitMs(webhook.id);
    if (waitMs > this.#maxInlineWaitMs) {
      throw new ChannelError({
        provider: 'discord',
        operation,
        kind: 'rate_limited',
        code: 'bucket_exhausted',
        retryAfterMs: waitMs,
      });
    }
    if (waitMs > 0) await this.#sleep(waitMs);

    const response = await this.#http.send({
      operation,
      url,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'DiscordBot (watchtower, 0.0.0)',
      },
      body: JSON.stringify(buildPayload(message)),
      // No idempotency key exists: only a 429, which means "not processed", may be repeated.
      retryMode: 'rejected_only',
      retryOn429: async (rejected) => {
        try {
          const wait = await this.#retryAfterMs(rejected);
          return wait !== undefined && wait <= this.#maxInlineWaitMs;
        } finally {
          // The client cancels the original body next, and a tee'd stream finishes cancelling only when
          // both branches are cancelled. Cancel this clone without waiting for it.
          rejected.body?.cancel().catch(() => undefined);
        }
      },
    });

    const bodyRetryAfter =
      response.status === 429 ? await this.#bodyRetryAfter(response) : undefined;
    this.#limiter.observe(webhook.id, {
      status: response.status,
      headers: response.headers,
      bodyRetryAfterSeconds: bodyRetryAfter,
    });

    if (response.status >= 200 && response.status < 300) {
      const created = createdMessageSchema.safeParse(await response.json().catch(() => null));
      return { delivered: true, messageId: created.success ? (created.data.id ?? null) : null };
    }

    const kind = failureKind(response.status);
    if (kind === 'auth' || kind === 'not_found') {
      this.#dead.set(webhook.id, this.#now() + this.#deadWebhookMs);
    }
    const retryAfterMs =
      response.status === 429
        ? (parseRetryAfter(response.headers.get('retry-after'), this.#now()) ??
          (bodyRetryAfter === undefined ? undefined : Math.ceil(bodyRetryAfter * 1000)))
        : undefined;
    throw new ChannelError({
      provider: 'discord',
      operation,
      kind,
      status: response.status,
      // Stable codes only; Discord's free-text message is not copied.
      code:
        kind === 'not_found'
          ? 'webhook_gone'
          : kind === 'auth'
            ? 'webhook_unauthorized'
            : kind === 'client'
              ? 'invalid_request'
              : kind === 'rate_limited'
                ? 'rate_limited'
                : undefined,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }

  async #bodyRetryAfter(response: Response): Promise<number | undefined> {
    const parsed = rateLimitedBodySchema.safeParse(
      await response
        .clone()
        .json()
        .catch(() => null),
    );
    return parsed.success ? parsed.data.retry_after : undefined;
  }

  async #retryAfterMs(response: Response): Promise<number | undefined> {
    const fromHeader = parseRetryAfter(response.headers.get('retry-after'), this.#now());
    if (fromHeader !== undefined) return fromHeader;
    const seconds = await this.#bodyRetryAfter(response);
    return seconds === undefined ? undefined : Math.ceil(seconds * 1000);
  }
}
