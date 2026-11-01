import type { DiscordWebhookMessage } from './message.js';
import type { DiscordWebhook } from './webhook.js';

/**
 * The seam between Watchtower and Discord's Execute Webhook endpoint. `FakeDiscordTransport` (in
 * memory) and `LiveDiscordTransport` (HTTP) both satisfy it and one contract suite runs against
 * both (`transport.contract.ts`).
 *
 * One transport serves many webhooks: the webhook is an argument, because rate limits are kept per
 * webhook and a deployment may have several channels (the channel map).
 */

export interface DiscordSendResult {
  /**
   * True only when Discord accepted the message and created it. A fake always says false: it
   * recorded the message in memory and nothing left this process. Callers must record "sent" from
   * this value and never from "no error was thrown" (the silent-mock bug class, T-102 P1-1).
   */
  readonly delivered: boolean;
  /** Snowflake id of the created message (`wait=true`), when Discord returned one. */
  readonly messageId: string | null;
}

export interface DiscordTransport {
  /** `live` reaches discord.com; `fake` never leaves the process. */
  readonly kind: 'live' | 'fake';
  /**
   * Posts one message. Rejects with a `ChannelError` (provider `discord`):
   * `client` for a message Discord (or the local schema) refuses, `not_found` / `auth` for a webhook
   * that was deleted or is wrong (permanent: stop using it), `rate_limited` with `retryAfterMs`,
   * `server` / `timeout` / `network` when the outcome is unknown. No idempotency key exists, so an
   * unknown outcome may or may not have posted.
   */
  execute(webhook: DiscordWebhook, message: DiscordWebhookMessage): Promise<DiscordSendResult>;
}
