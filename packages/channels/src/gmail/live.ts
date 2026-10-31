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
  gmailHistoryPageSchema,
  gmailMessageListSchema,
  gmailMessageSchema,
  gmailSendResponseSchema,
  gmailWatchResponseSchema,
  type GetMessageRequest,
  type GmailHistoryPage,
  type GmailMessage,
  type GmailMessageList,
  type GmailSendResponse,
  type GmailTransport,
  type GmailWatchResponse,
  type ListHistoryRequest,
  type ListMessagesRequest,
  type SendMessageRequest,
  type WatchRequest,
} from './transport.js';

/**
 * Gmail REST transport. A stub in the sense that nothing in this repository runs it against Google:
 * unit tests drive it with a scripted `fetch`, and the contract suite reaches it only with
 * `CONTRACT_LIVE=1` (`[ASK-HUMAN]`).
 *
 * It never builds a Google auth client. The caller supplies `fetch` and a `getAccessToken`
 * (service-account domain-wide delegation or OAuth, wired from the credential store, ADR-004), so
 * no Application Default Credentials probe can happen from here.
 *
 * Endpoints (users.* reference, read 2026-10-31):
 *   GET  /gmail/v1/users/{userId}/history        GET /gmail/v1/users/{userId}/messages
 *   GET  /gmail/v1/users/{userId}/messages/{id}  POST /gmail/v1/users/{userId}/messages/send
 *   POST /gmail/v1/users/{userId}/watch          POST /gmail/v1/users/{userId}/stop
 */

export const GMAIL_API_BASE_URL = 'https://gmail.googleapis.com';

export interface LiveGmailOptions {
  readonly fetch: FetchLike;
  readonly getAccessToken: TokenProvider;
  /** Default `me`: the mailbox the token belongs to. */
  readonly userId?: string;
  /** Default `https://gmail.googleapis.com`; override only for a local emulator. */
  readonly baseUrl?: string;
  readonly http?: Pick<HttpClientOptions, 'timeoutMs' | 'retry' | 'sleep' | 'random' | 'now'>;
}

const errorBodySchema = z.object({
  error: z
    .object({
      status: z.string().optional(),
      errors: z.array(z.object({ reason: z.string().optional() })).optional(),
    })
    .optional(),
});

function failureKind(status: number, reason: string | undefined): ChannelFailureKind {
  if (status === 401) return 'auth';
  if (status === 403) {
    return reason !== undefined && /ratelimit|quota/i.test(reason) ? 'rate_limited' : 'auth';
  }
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'client';
}

export class LiveGmailTransport implements GmailTransport {
  readonly #http: HttpClient;
  readonly #getAccessToken: TokenProvider;
  readonly #base: string;
  readonly #now: () => number;

  constructor(options: LiveGmailOptions) {
    this.#http = new HttpClient({ provider: 'gmail', fetch: options.fetch, ...options.http });
    this.#getAccessToken = options.getAccessToken;
    const user = encodeURIComponent(options.userId ?? 'me');
    this.#base = `${(options.baseUrl ?? GMAIL_API_BASE_URL).replace(/\/+$/, '')}/gmail/v1/users/${user}`;
    this.#now = options.http?.now ?? Date.now;
  }

  listHistory(request: ListHistoryRequest): Promise<GmailHistoryPage> {
    const query = new URLSearchParams({ startHistoryId: request.startHistoryId });
    if (request.pageToken !== undefined) query.set('pageToken', request.pageToken);
    if (request.maxResults !== undefined) query.set('maxResults', String(request.maxResults));
    if (request.labelId !== undefined) query.set('labelId', request.labelId);
    for (const type of request.historyTypes ?? []) query.append('historyTypes', type);
    return this.#call(
      'users.history.list',
      'GET',
      `/history?${query.toString()}`,
      'idempotent',
      undefined,
      gmailHistoryPageSchema,
    );
  }

  listMessages(request: ListMessagesRequest): Promise<GmailMessageList> {
    const query = new URLSearchParams();
    if (request.query !== undefined) query.set('q', request.query);
    if (request.pageToken !== undefined) query.set('pageToken', request.pageToken);
    if (request.maxResults !== undefined) query.set('maxResults', String(request.maxResults));
    if (request.includeSpamTrash === true) query.set('includeSpamTrash', 'true');
    for (const label of request.labelIds ?? []) query.append('labelIds', label);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.#call(
      'users.messages.list',
      'GET',
      `/messages${suffix}`,
      'idempotent',
      undefined,
      gmailMessageListSchema,
    );
  }

  getMessage(request: GetMessageRequest): Promise<GmailMessage> {
    const path = `/messages/${encodeURIComponent(request.id)}?format=${request.format}`;
    return this.#call(
      'users.messages.get',
      'GET',
      path,
      'idempotent',
      undefined,
      gmailMessageSchema,
    );
  }

  sendMessage(request: SendMessageRequest): Promise<GmailSendResponse> {
    const body = JSON.stringify({
      raw: request.raw,
      ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
    });
    // Gmail has no idempotency key: only a refusal (429) may be retried (ADR-010).
    return this.#call(
      'users.messages.send',
      'POST',
      '/messages/send',
      'rejected_only',
      body,
      gmailSendResponseSchema,
    );
  }

  watch(request: WatchRequest): Promise<GmailWatchResponse> {
    const body = JSON.stringify({
      topicName: request.topicName,
      ...(request.labelIds === undefined ? {} : { labelIds: request.labelIds }),
      ...(request.labelFilterBehavior === undefined
        ? {}
        : { labelFilterBehavior: request.labelFilterBehavior.toUpperCase() }),
    });
    // Renewing a watch is idempotent: it replaces the previous watch.
    return this.#call(
      'users.watch',
      'POST',
      '/watch',
      'idempotent',
      body,
      gmailWatchResponseSchema,
    );
  }

  async stopWatch(): Promise<void> {
    await this.#call('users.stop', 'POST', '/stop', 'idempotent', '', z.unknown());
  }

  async #call<T>(
    operation: string,
    method: 'GET' | 'POST',
    path: string,
    retryMode: RetryMode,
    body: string | undefined,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let forceRefresh = false;
    for (let authAttempt = 0; ; authAttempt += 1) {
      const token = await this.#getAccessToken(forceRefresh ? { forceRefresh: true } : undefined);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      };
      if (body !== undefined && body !== '') headers['Content-Type'] = 'application/json';
      const response = await this.#http.send({
        operation,
        url: `${this.#base}${path}`,
        method,
        headers,
        retryMode,
        ...(body === undefined ? {} : { body }),
      });

      if (response.status === 401 && authAttempt === 0) {
        // The token may simply have expired: ask the provider for a fresh one, once.
        await response.body?.cancel();
        forceRefresh = true;
        continue;
      }
      if (!response.ok) throw await this.#toError(operation, response);

      const text = await response.text();
      let json: unknown;
      try {
        json = text === '' ? {} : JSON.parse(text);
      } catch {
        throw new ChannelError({
          provider: 'gmail',
          operation,
          kind: 'invalid_response',
          status: response.status,
        });
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new ChannelError({
          provider: 'gmail',
          operation,
          kind: 'invalid_response',
          status: response.status,
        });
      }
      return parsed.data;
    }
  }

  async #toError(operation: string, response: Response): Promise<ChannelError> {
    let reason: string | undefined;
    let code: string | undefined;
    try {
      const parsed = errorBodySchema.safeParse(JSON.parse(await response.text()));
      if (parsed.success) {
        reason = parsed.data.error?.errors?.[0]?.reason;
        code = reason ?? parsed.data.error?.status;
      }
    } catch {
      // Non-JSON error body: the status alone has to do.
    }
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.#now());
    return new ChannelError({
      provider: 'gmail',
      operation,
      kind: failureKind(response.status, reason),
      status: response.status,
      ...(code === undefined ? {} : { code }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
}
