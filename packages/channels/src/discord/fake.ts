import { randomUUID } from 'node:crypto';

import { ChannelError } from '../common/errors.js';
import {
  buildPayload,
  discordWebhookMessageSchema,
  type DiscordWebhookMessage,
} from './message.js';
import type { DiscordSendResult, DiscordTransport } from './transport.js';
import type { DiscordWebhook } from './webhook.js';

/**
 * In-memory Discord. It is the transport of mock mode and of every test, so it enforces what the
 * adapter depends on:
 *
 * - the same message schema as the live transport (an over-long message fails here too);
 * - a deleted webhook answers 404 (`revoke`), the way Discord does, and stays dead;
 * - an optional per-webhook rate limit (`limitRate`) that answers 429 with a `retryAfterMs`;
 * - `delivered` is always false: the message is recorded here and goes nowhere.
 *
 * Recorded messages hold the final JSON payload (with `allowed_mentions`) and the webhook's id,
 * never its token.
 */

export interface FakeDiscordOptions {
  readonly now?: () => Date;
  /** Keep at most this many recorded messages (oldest dropped). Mock mode in a long-running worker sets it. */
  readonly maxRecorded?: number;
}

export interface RecordedDiscordMessage {
  readonly webhookId: string;
  readonly payload: Record<string, unknown>;
  readonly messageId: string;
  readonly at: Date;
}

function reject(
  kind: 'client' | 'not_found' | 'rate_limited',
  status: number,
  code: string,
  retryAfterMs?: number,
): never {
  throw new ChannelError({
    provider: 'discord',
    operation: 'webhook.execute',
    kind,
    status,
    code,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

export class FakeDiscordTransport implements DiscordTransport {
  readonly kind = 'fake';
  readonly sent: RecordedDiscordMessage[] = [];

  readonly #now: () => Date;
  readonly #maxRecorded: number;
  readonly #revoked = new Set<string>();
  readonly #limits = new Map<string, { perWindow: number; windowMs: number; at: number[] }>();
  readonly #failures: ChannelError[] = [];

  constructor(options: FakeDiscordOptions = {}) {
    this.#now = options.now ?? ((): Date => new Date());
    this.#maxRecorded = options.maxRecorded ?? Number.POSITIVE_INFINITY;
  }

  // -- test controls --------------------------------------------------------------------------

  /** The webhook was deleted in Discord: every post answers 404 from now on. */
  revoke(webhookId: string): void {
    this.#revoked.add(webhookId);
  }

  /** At most `perWindow` posts per `windowMs` for this webhook; the next one gets a 429. */
  limitRate(webhookId: string, perWindow: number, windowMs: number): void {
    this.#limits.set(webhookId, { perWindow, windowMs, at: [] });
  }

  /** The next post fails with this error (once). */
  failNext(error: ChannelError): void {
    this.#failures.push(error);
  }

  // -- DiscordTransport -----------------------------------------------------------------------

  execute(webhook: DiscordWebhook, message: DiscordWebhookMessage): Promise<DiscordSendResult> {
    try {
      return Promise.resolve(this.#execute(webhook, message));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('unknown'));
    }
  }

  #execute(webhook: DiscordWebhook, message: DiscordWebhookMessage): DiscordSendResult {
    const failure = this.#failures.shift();
    if (failure !== undefined) throw failure;
    if (!discordWebhookMessageSchema.safeParse(message).success) {
      reject('client', 400, 'invalid_request');
    }
    if (this.#revoked.has(webhook.id)) reject('not_found', 404, 'webhook_gone');

    const now = this.#now().getTime();
    const limit = this.#limits.get(webhook.id);
    if (limit !== undefined) {
      limit.at = limit.at.filter((at) => now - at < limit.windowMs);
      const oldest = limit.at[0];
      if (limit.at.length >= limit.perWindow && oldest !== undefined) {
        reject('rate_limited', 429, 'rate_limited', oldest + limit.windowMs - now);
      }
      limit.at.push(now);
    }

    const messageId = randomUUID();
    this.sent.push({
      webhookId: webhook.id,
      payload: buildPayload(message),
      messageId,
      at: this.#now(),
    });
    if (this.sent.length > this.#maxRecorded)
      this.sent.splice(0, this.sent.length - this.#maxRecorded);
    return { delivered: false, messageId };
  }
}
