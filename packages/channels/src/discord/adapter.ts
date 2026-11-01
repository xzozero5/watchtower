import { unsupportedOperation } from '../common/errors.js';
import type { ChannelAdapter, ChannelCapabilities } from '../common/adapter.js';
import { DISCORD_MAX_CONTENT, type DiscordWebhookMessage } from './message.js';
import type { DiscordSendResult, DiscordTransport } from './transport.js';
import type { DiscordWebhook } from './webhook.js';

/**
 * The Discord `ChannelAdapter` for Phase 1 (T-104): a one-way notification channel. `send` posts a
 * webhook message; `ingest` and `markRead` are unsupported, as `capabilities()` says. Receiving
 * (interactions endpoint, `/ack`, buttons) is T-202.
 */

export const DISCORD_CAPABILITIES: ChannelCapabilities = {
  channel: 'discord',
  receive: false,
  send: true,
  threading: 'none',
  markRead: false,
  replyToken: false,
  attachments: false,
  html: false,
  maxTextLength: DISCORD_MAX_CONTENT,
};

export interface DiscordSendInput {
  readonly webhook: DiscordWebhook;
  readonly message: DiscordWebhookMessage;
}

export interface DiscordAdapterOptions {
  readonly transport: DiscordTransport;
}

export class DiscordAdapter implements ChannelAdapter<
  never,
  never,
  DiscordSendInput,
  DiscordSendResult,
  never
> {
  readonly #transport: DiscordTransport;

  constructor(options: DiscordAdapterOptions) {
    this.#transport = options.transport;
  }

  /** `live` or `fake`: what a caller must check before it says a notification was delivered. */
  get transportKind(): DiscordTransport['kind'] {
    return this.#transport.kind;
  }

  capabilities(): ChannelCapabilities {
    return DISCORD_CAPABILITIES;
  }

  ingest(): Promise<readonly never[]> {
    return Promise.reject(unsupportedOperation('discord', 'ingest'));
  }

  send(input: DiscordSendInput): Promise<DiscordSendResult> {
    return this.#transport.execute(input.webhook, input.message);
  }

  markRead(): Promise<void> {
    return Promise.reject(unsupportedOperation('discord', 'markRead'));
  }
}
