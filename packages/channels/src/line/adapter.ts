import { z } from 'zod';

import type { ChannelAdapter, ChannelCapabilities } from '../common/adapter.js';
import { parseLineWebhook, type NormalizedLineEvent } from './events.js';
import { verifyLineSignature } from './signature.js';
import {
  LINE_MAX_TEXT_LENGTH,
  type LineSendResult,
  type LineTextMessage,
  type LineTransport,
} from './transport.js';

/**
 * The LINE `ChannelAdapter` (PRD section 4.2). `ingest` verifies the signature and normalises the
 * events; `send` executes a routing decision someone else made (`decideLineRoute`); `markRead`
 * calls the mark-as-read API. The channel secret comes from a provider function, never from a
 * constant (credential store, ADR-004).
 */

export class LineSignatureError extends Error {
  constructor() {
    super('LINE webhook signature is missing or does not match');
    this.name = 'LineSignatureError';
  }
}

export const lineIngestInputSchema = z.object({
  rawBody: z.union([z.string(), z.instanceof(Uint8Array)]),
  /** Value of the `x-line-signature` request header. */
  signature: z.string().nullable(),
});

export type LineIngestInput = z.infer<typeof lineIngestInputSchema>;

export type LineSendInput =
  | {
      readonly route: 'reply';
      readonly replyToken: string;
      readonly texts: readonly string[];
    }
  | {
      readonly route: 'push';
      readonly to: string;
      readonly texts: readonly string[];
      /** UUID derived from the outbound delivery id. */
      readonly retryKey: string;
    };

export interface LineMarkReadInput {
  readonly markAsReadToken: string;
}

export interface LineAdapterOptions {
  readonly transport: LineTransport;
  /** Returns this account's channel secret. Called on every webhook so rotation needs no restart. */
  readonly getChannelSecret: () => Promise<string>;
}

export const LINE_CAPABILITIES: ChannelCapabilities = {
  channel: 'line',
  receive: true,
  send: true,
  threading: 'none',
  markRead: true,
  replyToken: true,
  attachments: true,
  html: false,
  maxTextLength: LINE_MAX_TEXT_LENGTH,
};

function toMessages(texts: readonly string[]): LineTextMessage[] {
  return texts.map((text) => ({ type: 'text', text }));
}

export class LineAdapter implements ChannelAdapter<
  LineIngestInput,
  NormalizedLineEvent,
  LineSendInput,
  LineSendResult,
  LineMarkReadInput
> {
  readonly #options: LineAdapterOptions;

  constructor(options: LineAdapterOptions) {
    this.#options = options;
  }

  capabilities(): ChannelCapabilities {
    return LINE_CAPABILITIES;
  }

  /** Throws `LineSignatureError` before parsing anything when the signature is wrong (401). */
  async ingest(input: LineIngestInput): Promise<readonly NormalizedLineEvent[]> {
    const channelSecret = await this.#options.getChannelSecret();
    if (
      !verifyLineSignature({ rawBody: input.rawBody, signature: input.signature, channelSecret })
    ) {
      throw new LineSignatureError();
    }
    return parseLineWebhook(input.rawBody).events;
  }

  send(input: LineSendInput): Promise<LineSendResult> {
    const messages = toMessages(input.texts);
    return input.route === 'reply'
      ? this.#options.transport.reply({ replyToken: input.replyToken, messages })
      : this.#options.transport.push({ to: input.to, messages, retryKey: input.retryKey });
  }

  markRead(input: LineMarkReadInput): Promise<void> {
    return this.#options.transport.markAsRead({ markAsReadToken: input.markAsReadToken });
  }
}
