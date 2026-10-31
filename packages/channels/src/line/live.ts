import { z } from 'zod';

import { ChannelError, type ChannelFailureKind } from '../common/errors.js';
import {
  HttpClient,
  parseRetryAfter,
  type FetchLike,
  type HttpClientOptions,
  type RetryMode,
  type TokenProvider,
} from '../common/http.js';
import {
  lineConsumptionResponseSchema,
  lineQuotaResponseSchema,
  type LineConsumptionResponse,
  type LineQuotaResponse,
} from './quota.js';
import {
  lineOutboundMessagesSchema,
  lineSendResponseSchema,
  loadingAnimationSchema,
  retryKeySchema,
  type LineContentResult,
  type LinePushRequest,
  type LineReplyRequest,
  type LineSendResult,
  type LineTransport,
} from './transport.js';

/**
 * LINE Messaging API over HTTP, with an injected `fetch` and channel access token provider.
 * Nothing in this repository runs it against LINE; unit tests drive it with a scripted `fetch` and
 * the contract suite reaches it only with `CONTRACT_LIVE=1` (`[ASK-HUMAN]`).
 *
 * Hosts are the PRD section 11 egress allow-list: `api.line.me` and `api-data.line.me`
 * (media download). Endpoints verified against the Messaging API reference, 2026-10-31.
 */

export const LINE_API_BASE_URL = 'https://api.line.me';
export const LINE_DATA_BASE_URL = 'https://api-data.line.me';

export interface LiveLineOptions {
  readonly fetch: FetchLike;
  /** Channel access token for this Official Account, from the credential store (ADR-004). */
  readonly getChannelAccessToken: TokenProvider;
  readonly baseUrl?: string;
  readonly dataBaseUrl?: string;
  readonly http?: Pick<HttpClientOptions, 'timeoutMs' | 'retry' | 'sleep' | 'random' | 'now'>;
}

const errorBodySchema = z.looseObject({ message: z.string().optional() });

function failureKind(status: number): ChannelFailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'client';
}

/**
 * Maps the provider's message text to a stable code and drops the text itself (it can echo user
 * ids). The phrases come from the Messaging API reference error examples `[VERIFY]` wording.
 */
function errorCode(status: number, message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  if (status === 400 && /reply token/i.test(message)) return 'invalid_reply_token';
  if (status === 400 && /read token/i.test(message)) return 'invalid_read_token';
  if (status === 429 && /monthly limit/i.test(message)) return 'monthly_limit';
  return undefined;
}

export class LiveLineTransport implements LineTransport {
  readonly #http: HttpClient;
  readonly #getToken: TokenProvider;
  readonly #base: string;
  readonly #dataBase: string;
  readonly #now: () => number;

  constructor(options: LiveLineOptions) {
    this.#http = new HttpClient({ provider: 'line', fetch: options.fetch, ...options.http });
    this.#getToken = options.getChannelAccessToken;
    this.#base = (options.baseUrl ?? LINE_API_BASE_URL).replace(/\/+$/, '');
    this.#dataBase = (options.dataBaseUrl ?? LINE_DATA_BASE_URL).replace(/\/+$/, '');
    this.#now = options.http?.now ?? Date.now;
  }

  async reply(request: LineReplyRequest): Promise<LineSendResult> {
    this.#assertMessages('message.reply', request.messages);
    const response = await this.#request({
      operation: 'message.reply',
      method: 'POST',
      url: `${this.#base}/v2/bot/message/reply`,
      body: JSON.stringify({ replyToken: request.replyToken, messages: request.messages }),
      // A token works once: after an unknown outcome a repeat would fail or duplicate.
      retryMode: 'rejected_only',
    });
    return this.#sendResult('message.reply', response);
  }

  async push(request: LinePushRequest): Promise<LineSendResult> {
    this.#assertMessages('message.push', request.messages);
    if (!retryKeySchema.safeParse(request.retryKey).success) {
      throw new ChannelError({
        provider: 'line',
        operation: 'message.push',
        kind: 'client',
        code: 'invalid_retry_key',
      });
    }
    const response = await this.#request({
      operation: 'message.push',
      method: 'POST',
      url: `${this.#base}/v2/bot/message/push`,
      body: JSON.stringify({ to: request.to, messages: request.messages }),
      headers: { 'X-Line-Retry-Key': request.retryKey },
      // The retry key makes every repeat safe, so timeouts and 5xx may be retried.
      retryMode: 'idempotent',
    });
    if (response.status === 409) {
      // "The retry key is already accepted": an earlier attempt went through.
      await response.body?.cancel();
      return {
        requestId: response.headers.get('x-line-request-id'),
        sentMessageIds: [],
        alreadyAccepted: true,
        acceptedRequestId: response.headers.get('x-line-accepted-request-id'),
      };
    }
    return this.#sendResult('message.push', response);
  }

  async getQuota(): Promise<LineQuotaResponse> {
    const response = await this.#request({
      operation: 'message.quota',
      method: 'GET',
      url: `${this.#base}/v2/bot/message/quota`,
      retryMode: 'idempotent',
    });
    return this.#json('message.quota', response, lineQuotaResponseSchema);
  }

  async getConsumption(): Promise<LineConsumptionResponse> {
    const response = await this.#request({
      operation: 'message.quota.consumption',
      method: 'GET',
      url: `${this.#base}/v2/bot/message/quota/consumption`,
      retryMode: 'idempotent',
    });
    return this.#json('message.quota.consumption', response, lineConsumptionResponseSchema);
  }

  async getContent(messageId: string): Promise<LineContentResult> {
    const response = await this.#request({
      operation: 'message.content',
      method: 'GET',
      url: `${this.#dataBase}/v2/bot/message/${encodeURIComponent(messageId)}/content`,
      retryMode: 'idempotent',
      timeoutMs: 60_000,
    });
    if (response.status === 202) {
      await response.body?.cancel();
      return { status: 'preparing' };
    }
    if (!response.ok) throw await this.#toError('message.content', response);
    return {
      status: 'ready',
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type'),
    };
  }

  async markAsRead(request: { readonly markAsReadToken: string }): Promise<void> {
    const response = await this.#request({
      operation: 'chat.markAsRead',
      method: 'POST',
      url: `${this.#base}/v2/bot/chat/markAsRead`,
      body: JSON.stringify({ markAsReadToken: request.markAsReadToken }),
      retryMode: 'idempotent',
    });
    await this.#expectOk('chat.markAsRead', response);
  }

  async showLoadingAnimation(request: {
    readonly chatId: string;
    readonly loadingSeconds?: number;
  }): Promise<void> {
    const parsed = loadingAnimationSchema.safeParse(request);
    if (!parsed.success) {
      throw new ChannelError({
        provider: 'line',
        operation: 'chat.loading.start',
        kind: 'client',
        code: 'invalid_request',
      });
    }
    const response = await this.#request({
      operation: 'chat.loading.start',
      method: 'POST',
      url: `${this.#base}/v2/bot/chat/loading/start`,
      body: JSON.stringify(parsed.data),
      retryMode: 'idempotent',
    });
    await this.#expectOk('chat.loading.start', response);
  }

  // -- internals ------------------------------------------------------------------------------

  #assertMessages(operation: string, messages: readonly unknown[]): void {
    if (!lineOutboundMessagesSchema.safeParse(messages).success) {
      throw new ChannelError({
        provider: 'line',
        operation,
        kind: 'client',
        code: 'invalid_request',
      });
    }
  }

  async #request(input: {
    readonly operation: string;
    readonly method: 'GET' | 'POST';
    readonly url: string;
    readonly body?: string;
    readonly headers?: Record<string, string>;
    readonly retryMode: RetryMode;
    readonly timeoutMs?: number;
  }): Promise<Response> {
    for (let authAttempt = 0; ; authAttempt += 1) {
      const token = await this.#getToken(authAttempt === 0 ? undefined : { forceRefresh: true });
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        ...input.headers,
      };
      if (input.body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await this.#http.send({
        operation: input.operation,
        url: input.url,
        method: input.method,
        headers,
        retryMode: input.retryMode,
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        // A spent monthly quota will not recover within a retry: stop at the first 429 that says so.
        retryOn429: async (clone) => {
          const parsed = errorBodySchema.safeParse(await clone.json().catch(() => ({})));
          return !(parsed.success && errorCode(429, parsed.data.message) === 'monthly_limit');
        },
      });
      if (response.status === 401 && authAttempt === 0) {
        // The access token may have expired: ask the provider for a fresh one, once.
        await response.body?.cancel();
        continue;
      }
      return response;
    }
  }

  async #sendResult(operation: string, response: Response): Promise<LineSendResult> {
    if (!response.ok) throw await this.#toError(operation, response);
    const body = await this.#json(operation, response, lineSendResponseSchema);
    return {
      requestId: response.headers.get('x-line-request-id'),
      sentMessageIds: (body.sentMessages ?? []).map((sent) => sent.id),
      alreadyAccepted: false,
      acceptedRequestId: null,
    };
  }

  async #expectOk(operation: string, response: Response): Promise<void> {
    if (!response.ok) throw await this.#toError(operation, response);
    await response.body?.cancel();
  }

  async #json<T>(operation: string, response: Response, schema: z.ZodType<T>): Promise<T> {
    if (!response.ok) throw await this.#toError(operation, response);
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ChannelError({
        provider: 'line',
        operation,
        kind: 'invalid_response',
        status: response.status,
      });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ChannelError({
        provider: 'line',
        operation,
        kind: 'invalid_response',
        status: response.status,
      });
    }
    return parsed.data;
  }

  async #toError(operation: string, response: Response): Promise<ChannelError> {
    let message: string | undefined;
    try {
      const parsed = errorBodySchema.safeParse(await response.json());
      if (parsed.success) message = parsed.data.message;
    } catch {
      // Not JSON: the status alone has to do.
    }
    const code = errorCode(response.status, message);
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.#now());
    const requestId = response.headers.get('x-line-request-id');
    return new ChannelError({
      provider: 'line',
      operation,
      kind: failureKind(response.status),
      status: response.status,
      ...(code === undefined ? {} : { code }),
      ...(requestId === null ? {} : { requestId }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
}
