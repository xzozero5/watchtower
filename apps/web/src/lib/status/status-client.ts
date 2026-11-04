import {
  apiErrorSchema,
  humanChallengeSchema,
  publicHistorySchema,
  publicStatusSchema,
  subscribeResultSchema,
  subscriptionResultSchema,
  type HumanChallenge,
  type PublicHistory,
  type PublicStatus,
  type Subscribe,
} from '@watchtower/shared';
import type { z } from 'zod';

import { parseRetryAfter } from '@/lib/portal/portal-client';

/** What went wrong, in the terms the public status pages have copy for. */
export type StatusFailureKind =
  'closed' | 'invalidLink' | 'rateLimited' | 'validation' | 'verification' | 'network' | 'server';

export class StatusApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly retryAfterSeconds: number | null,
  ) {
    super(`status request failed (${status === 0 ? 'network' : String(status)})`);
    this.name = 'StatusApiError';
  }
}

export interface StatusFailure {
  kind: StatusFailureKind;
  retryAfterSeconds: number | null;
}

/**
 * Status and `code` decide, never the message text. A 404 means the page is switched off on this
 * instance (`STATUS_PAGE_PUBLIC` is off): the pages render the same not-found page as any other
 * address that does not exist.
 */
export function classifyStatusError(error: unknown): StatusFailure {
  if (!(error instanceof StatusApiError)) return { kind: 'server', retryAfterSeconds: null };
  if (error.status === 0) return { kind: 'network', retryAfterSeconds: null };
  if (error.status === 404) return { kind: 'closed', retryAfterSeconds: null };
  if (error.status === 429 || error.code === 'rate_limited') {
    return { kind: 'rateLimited', retryAfterSeconds: error.retryAfterSeconds };
  }
  if (error.code === 'invalid_or_expired_link') {
    return { kind: 'invalidLink', retryAfterSeconds: null };
  }
  if (error.code === 'verification_failed') {
    return { kind: 'verification', retryAfterSeconds: null };
  }
  if (error.status === 400) return { kind: 'validation', retryAfterSeconds: null };
  return { kind: 'server', retryAfterSeconds: null };
}

export interface StatusClientOptions {
  /** Base URL of the api as the browser reaches it, no trailing slash. */
  baseUrl: string;
  /** Resolved on every call so tests can stub the global. */
  fetchImpl?: () => typeof fetch;
}

interface Call<Output> {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  schema: z.ZodType<Output>;
  signal?: AbortSignal;
}

/**
 * Client of the public status page api (`/v1/status`). No session: no cookie is sent
 * (`credentials: 'omit'`), no CSRF token exists, and a signed link travels in the body of a POST,
 * never in a URL. Responses are validated with the shared strict schemas, so a field the api adds to
 * the public answer by mistake fails here instead of being drawn.
 */
export class StatusClient {
  constructor(private readonly options: StatusClientOptions) {}

  current(signal?: AbortSignal): Promise<PublicStatus> {
    return this.call({
      method: 'GET',
      path: '/v1/status',
      schema: publicStatusSchema,
      ...(signal ? { signal } : {}),
    });
  }

  history(signal?: AbortSignal): Promise<PublicHistory> {
    return this.call({
      method: 'GET',
      path: '/v1/status/history',
      schema: publicHistorySchema,
      ...(signal ? { signal } : {}),
    });
  }

  /** The proof-of-work challenge a subscribe request carries (ADR-007), the portal's provider. */
  challenge(signal?: AbortSignal): Promise<HumanChallenge> {
    return this.call({
      method: 'GET',
      path: '/v1/status/subscriptions/challenge',
      schema: humanChallengeSchema,
      ...(signal ? { signal } : {}),
    });
  }

  async subscribe(body: Subscribe, signal?: AbortSignal): Promise<void> {
    await this.call({
      method: 'POST',
      path: '/v1/status/subscriptions',
      body,
      schema: subscribeResultSchema,
      ...(signal ? { signal } : {}),
    });
  }

  async confirm(token: string, signal?: AbortSignal): Promise<void> {
    await this.call({
      method: 'POST',
      path: '/v1/status/subscriptions/confirm',
      body: { token },
      schema: subscriptionResultSchema,
      ...(signal ? { signal } : {}),
    });
  }

  async unsubscribe(token: string, signal?: AbortSignal): Promise<void> {
    await this.call({
      method: 'POST',
      path: '/v1/status/subscriptions/unsubscribe',
      body: { token },
      schema: subscriptionResultSchema,
      ...(signal ? { signal } : {}),
    });
  }

  private async call<Output>(call: Call<Output>): Promise<Output> {
    const doFetch = this.options.fetchImpl?.() ?? fetch;
    let response: Response;
    try {
      response = await doFetch(new URL(call.path, `${this.options.baseUrl}/`).toString(), {
        method: call.method,
        headers: {
          accept: 'application/json',
          ...(call.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        ...(call.signal ? { signal: call.signal } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new StatusApiError(0, null, null);
    }

    if (!response.ok) {
      let code: string | null = null;
      try {
        const parsed = apiErrorSchema.safeParse(await response.json());
        if (parsed.success) code = parsed.data.code;
      } catch {
        // A body that is not JSON (a proxy page) is classified by status alone.
      }
      const retryAfter =
        response.status === 429
          ? (parseRetryAfter(response.headers.get('retry-after')) ?? 60)
          : null;
      throw new StatusApiError(response.status, code, retryAfter);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new StatusApiError(response.status, 'invalid_response', null);
    }
    const parsed = call.schema.safeParse(json);
    if (!parsed.success) throw new StatusApiError(response.status, 'invalid_response', null);
    return parsed.data;
  }
}
