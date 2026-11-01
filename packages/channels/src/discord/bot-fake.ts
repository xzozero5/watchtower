import type { ChannelError } from '../common/errors.js';
import {
  parseBotMessage,
  threadName,
  toDiscordPayload,
  type BotMessage,
  type BotSendResult,
  type BotThreadResult,
  type BotTransport,
} from './bot.js';

/** What the fake recorded: the final JSON a live transport would have sent, never a token. */
export interface RecordedBotCall {
  readonly op: 'postMessage' | 'editMessage' | 'createThread' | 'postInThread';
  readonly target: string;
  readonly payload: Record<string, unknown>;
  readonly at: Date;
}

/**
 * In-memory Discord bot. It is the transport of mock mode and of every test, so it enforces what
 * callers depend on: the same message schema as a live transport would (an over-long message or a
 * label past 80 characters fails here too), `allowed_mentions` on everything it records, scripted
 * failures (`failNext`) to exercise retry and dead-letter paths, and `delivered` always false: what it
 * records goes nowhere. It never returns a message or thread id, so nothing can store a fake id as if
 * Discord had made it.
 */
export class FakeBotTransport implements BotTransport {
  readonly kind = 'fake' as const;
  readonly calls: RecordedBotCall[] = [];
  readonly #failures: ChannelError[] = [];
  readonly #now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.#now = options.now ?? ((): Date => new Date());
  }

  /** The next call (of any kind) rejects with `error`; calls after it behave normally. */
  failNext(error: ChannelError): void {
    this.#failures.push(error);
  }

  #record(op: RecordedBotCall['op'], target: string, payload: Record<string, unknown>): void {
    const failure = this.#failures.shift();
    if (failure !== undefined) throw failure;
    this.calls.push({ op, target, payload, at: this.#now() });
  }

  postMessage(channelId: string, message: BotMessage): Promise<BotSendResult> {
    try {
      this.#record('postMessage', channelId, toDiscordPayload(parseBotMessage(message)));
      return Promise.resolve({ delivered: false, channelId: null, messageId: null });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  editMessage(
    channelId: string,
    messageId: string,
    message: BotMessage,
  ): Promise<{ delivered: boolean }> {
    try {
      this.#record(
        'editMessage',
        `${channelId}/${messageId}`,
        toDiscordPayload(parseBotMessage(message)),
      );
      return Promise.resolve({ delivered: false });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  createThread(channelId: string, messageId: string, name: string): Promise<BotThreadResult> {
    try {
      this.#record('createThread', `${channelId}/${messageId}`, {
        name: threadName(name),
        type: 11,
      });
      return Promise.resolve({ delivered: false, channelId: null, threadId: null });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  postInThread(threadId: string, message: BotMessage): Promise<BotSendResult> {
    try {
      this.#record('postInThread', threadId, toDiscordPayload(parseBotMessage(message)));
      return Promise.resolve({ delivered: false, channelId: null, messageId: null });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
