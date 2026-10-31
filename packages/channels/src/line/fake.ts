import { randomBytes, randomUUID } from 'node:crypto';

import { ChannelError } from '../common/errors.js';
import type { LineConsumptionResponse, LineQuotaResponse } from './quota.js';
import {
  lineOutboundMessagesSchema,
  loadingAnimationSchema,
  retryKeySchema,
  type LineContentResult,
  type LinePushRequest,
  type LineReplyRequest,
  type LineSendResult,
  type LineTransport,
} from './transport.js';

/**
 * In-memory LINE Messaging API. It enforces the rules the adapter depends on, so a bug that would
 * burn a reply token or double-send shows up as a test failure instead of a customer complaint:
 *
 * - a reply token works once and expires (LINE: one minute, not guaranteed beyond; the fake uses
 *   `replyTokenTtlMs`, default 60 s, so the router's shorter default is exercised against a
 *   stricter-than-needed provider);
 * - push needs a UUID `X-Line-Retry-Key`; a repeat within 24 h is answered as "already accepted"
 *   and does not count twice;
 * - push counts against the monthly limit and fails with a 429 `monthly_limit` when it is spent;
 *   reply never counts.
 */

export interface FakeLineOptions {
  readonly now?: () => Date;
  /** How long an issued reply token stays valid. Default 60,000 ms. */
  readonly replyTokenTtlMs?: number;
  /** Monthly limit reported by `getQuota`. `null` = no target limit set (`type: none`). Default 300. */
  readonly monthlyLimit?: number | null;
}

export interface RecordedReply {
  readonly replyToken: string;
  readonly texts: readonly string[];
  readonly requestId: string;
}

export interface RecordedPush {
  readonly to: string;
  readonly texts: readonly string[];
  readonly retryKey: string;
  readonly requestId: string;
}

export type FakeLineOperation =
  | 'message.reply'
  | 'message.push'
  | 'message.quota'
  | 'message.quota.consumption'
  | 'message.content'
  | 'chat.markAsRead'
  | 'chat.loading.start';

const RETRY_KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;

function reject(
  operation: FakeLineOperation,
  kind: 'client' | 'not_found' | 'rate_limited',
  status: number,
  code: string,
): never {
  throw new ChannelError({ provider: 'line', operation, kind, status, code });
}

export class FakeLineTransport implements LineTransport {
  readonly replies: RecordedReply[] = [];
  readonly pushes: RecordedPush[] = [];
  readonly readMarks: string[] = [];
  readonly loadingAnimations: { chatId: string; loadingSeconds: number }[] = [];

  readonly #now: () => Date;
  readonly #ttlMs: number;
  readonly #monthlyLimit: number | null;
  readonly #tokens = new Map<string, { issuedAt: number; used: boolean }>();
  readonly #readTokens = new Set<string>();
  readonly #retryKeys = new Map<string, { at: number; requestId: string }>();
  readonly #content = new Map<string, { bytes: Uint8Array; contentType: string | null }>();
  readonly #preparing = new Set<string>();
  readonly #failures: { operation: FakeLineOperation; error: ChannelError }[] = [];
  #consumption = 0;

  constructor(options: FakeLineOptions = {}) {
    this.#now = options.now ?? ((): Date => new Date());
    this.#ttlMs = options.replyTokenTtlMs ?? 60_000;
    this.#monthlyLimit = options.monthlyLimit === undefined ? 300 : options.monthlyLimit;
  }

  // -- test controls --------------------------------------------------------------------------

  /** Simulates a webhook delivering a reply token now. */
  issueReplyToken(): string {
    const token = randomBytes(16).toString('hex');
    this.#tokens.set(token, { issuedAt: this.#now().getTime(), used: false });
    return token;
  }

  issueMarkAsReadToken(): string {
    const token = randomBytes(16).toString('hex');
    this.#readTokens.add(token);
    return token;
  }

  setContent(messageId: string, bytes: Uint8Array, contentType: string | null = null): void {
    this.#content.set(messageId, { bytes, contentType });
  }

  /** The next `getContent` for this id answers 202 until `setContent` is called. */
  setContentPreparing(messageId: string): void {
    this.#preparing.add(messageId);
  }

  /** Counts messages as if they were sent from LINE Official Account Manager. */
  addExternalConsumption(count: number): void {
    this.#consumption += count;
  }

  failNext(operation: FakeLineOperation, error: ChannelError): void {
    this.#failures.push({ operation, error });
  }

  get totalUsage(): number {
    return this.#consumption;
  }

  // -- LineTransport --------------------------------------------------------------------------

  reply(request: LineReplyRequest): Promise<LineSendResult> {
    return this.#run('message.reply', () => {
      this.#validateMessages('message.reply', request.messages);
      const token = this.#tokens.get(request.replyToken);
      const expired = token !== undefined && this.#now().getTime() - token.issuedAt > this.#ttlMs;
      if (token === undefined || token.used || expired) {
        // A spent or expired token is burned either way.
        if (token !== undefined) token.used = true;
        reject('message.reply', 'client', 400, 'invalid_reply_token');
      }
      token.used = true;
      const requestId = randomUUID();
      this.replies.push({
        replyToken: request.replyToken,
        texts: request.messages.map((message) => message.text),
        requestId,
      });
      return this.#sent(requestId, request.messages.length);
    });
  }

  push(request: LinePushRequest): Promise<LineSendResult> {
    return this.#run('message.push', () => {
      this.#validateMessages('message.push', request.messages);
      if (request.to.trim() === '' || !retryKeySchema.safeParse(request.retryKey).success) {
        reject('message.push', 'client', 400, 'invalid_request');
      }
      const now = this.#now().getTime();
      const seen = this.#retryKeys.get(request.retryKey);
      if (seen !== undefined && now - seen.at <= RETRY_KEY_LIFETIME_MS) {
        return {
          requestId: randomUUID(),
          sentMessageIds: [],
          alreadyAccepted: true,
          acceptedRequestId: seen.requestId,
        };
      }
      if (this.#monthlyLimit !== null && this.#consumption + 1 > this.#monthlyLimit) {
        reject('message.push', 'rate_limited', 429, 'monthly_limit');
      }
      this.#consumption += 1;
      const requestId = randomUUID();
      this.#retryKeys.set(request.retryKey, { at: now, requestId });
      this.pushes.push({
        to: request.to,
        texts: request.messages.map((message) => message.text),
        retryKey: request.retryKey,
        requestId,
      });
      return this.#sent(requestId, request.messages.length);
    });
  }

  getQuota(): Promise<LineQuotaResponse> {
    return this.#run('message.quota', () =>
      this.#monthlyLimit === null
        ? { type: 'none' as const }
        : { type: 'limited' as const, value: this.#monthlyLimit },
    );
  }

  getConsumption(): Promise<LineConsumptionResponse> {
    return this.#run('message.quota.consumption', () => ({ totalUsage: this.#consumption }));
  }

  getContent(messageId: string): Promise<LineContentResult> {
    return this.#run('message.content', (): LineContentResult => {
      if (this.#preparing.has(messageId) && !this.#content.has(messageId)) {
        return { status: 'preparing' };
      }
      const found = this.#content.get(messageId);
      if (found === undefined) reject('message.content', 'not_found', 404, 'not_found');
      return { status: 'ready', bytes: found.bytes, contentType: found.contentType };
    });
  }

  markAsRead(request: { readonly markAsReadToken: string }): Promise<void> {
    return this.#run('chat.markAsRead', () => {
      // Read tokens have no expiry and may be reused.
      if (!this.#readTokens.has(request.markAsReadToken)) {
        reject('chat.markAsRead', 'client', 400, 'invalid_read_token');
      }
      this.readMarks.push(request.markAsReadToken);
    });
  }

  showLoadingAnimation(request: { chatId: string; loadingSeconds?: number }): Promise<void> {
    return this.#run('chat.loading.start', () => {
      const parsed = loadingAnimationSchema.safeParse(request);
      if (!parsed.success) reject('chat.loading.start', 'client', 400, 'invalid_request');
      this.loadingAnimations.push({
        chatId: parsed.data.chatId,
        loadingSeconds: parsed.data.loadingSeconds ?? 20, // LINE's documented default
      });
    });
  }

  // -- internals ------------------------------------------------------------------------------

  #validateMessages(operation: FakeLineOperation, messages: readonly unknown[]): void {
    if (!lineOutboundMessagesSchema.safeParse(messages).success) {
      reject(operation, 'client', 400, 'invalid_request');
    }
  }

  #sent(requestId: string, count: number): LineSendResult {
    return {
      requestId,
      sentMessageIds: Array.from({ length: count }, () => randomUUID()),
      alreadyAccepted: false,
      acceptedRequestId: null,
    };
  }

  #run<T>(operation: FakeLineOperation, work: () => T): Promise<T> {
    const index = this.#failures.findIndex((failure) => failure.operation === operation);
    if (index >= 0) {
      const [failure] = this.#failures.splice(index, 1);
      if (failure !== undefined) return Promise.reject(failure.error);
    }
    try {
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('unknown'));
    }
  }
}
