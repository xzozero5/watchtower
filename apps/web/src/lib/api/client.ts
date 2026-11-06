import { CSRF_HEADER, sessionInfoSchema, type SessionInfo } from '@watchtower/shared';
import type { z } from 'zod';

import { ApiRequestError, errorFromResponse } from './errors';
import { createRefreshCoordinator, type RefreshCoordinator } from './refresh-coordinator';

export type QueryValue = string | number | boolean | readonly string[] | undefined | null;
export type QueryParams = Readonly<Record<string, QueryValue>>;

export interface RequestOptions<Output> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: QueryParams;
  body?: unknown;
  /** Validates the JSON body. Pass `null` for an endpoint that answers 204. */
  schema: z.ZodType<Output> | null;
  /** Binary downloads use the same authentication and retry path as JSON requests. */
  responseType?: 'blob';
  /** A checked streaming response, using the same cookies/CSRF/error handling. */
  readResponse?: (response: Response, signal?: AbortSignal) => Promise<Output>;
  accept?: string;
  /** A conversational POST must never be replayed implicitly, even after auth repair. */
  replayAfterAuth?: boolean;
  signal?: AbortSignal;
  /**
   * `false` for the sign-in and refresh endpoints: a 401 there is an answer, not a reason to
   * refresh and retry.
   */
  retryOnUnauthenticated?: boolean;
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Resolved on every call so tests can stub the global. */
  fetchImpl?: () => typeof fetch;
  coordinator?: RefreshCoordinator;
  /** Called after a refresh or a session read with the fresh session. */
  onSession?: (session: SessionInfo) => void;
  /** Called when a 401 could not be recovered: the user must sign in again. */
  onSessionExpired?: () => void;
}

/** Appends `query` to `path`. Arrays become `a,b`; empty values are left out. */
export function buildUrl(baseUrl: string, path: string, query?: QueryParams): string {
  const url = new URL(path, `${baseUrl}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      if (typeof value === 'object') {
        if (value.length > 0) url.searchParams.set(key, value.join(','));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Browser client for the REST API. Cookies carry the session (`credentials: 'include'`), the CSRF
 * token goes in a header on every unsafe request, and a 401 triggers one coordinated refresh and
 * one retry (see refresh-coordinator.ts). Responses are validated with the shared Zod schemas, so
 * a contract drift shows up as a clear error instead of `undefined` deep in a component.
 */
export class ApiClient {
  private csrfToken: string | null = null;
  private readonly coordinator: RefreshCoordinator;

  constructor(private readonly options: ApiClientOptions) {
    this.coordinator =
      options.coordinator ??
      createRefreshCoordinator({
        run: async () => {
          const session = await this.send({
            method: 'POST',
            path: '/v1/auth/refresh',
            schema: sessionInfoSchema,
            retryOnUnauthenticated: false,
          });
          this.acceptSession(session);
        },
      });
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  /** Remembers the session's CSRF token and tells the listener. */
  acceptSession(session: SessionInfo): void {
    this.csrfToken = session.csrfToken;
    this.options.onSession?.(session);
  }

  clearSession(): void {
    this.csrfToken = null;
  }

  async request<Output>(options: RequestOptions<Output>): Promise<Output> {
    const startedAt = Date.now();
    try {
      return await this.send(options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (error instanceof ApiRequestError && options.replayAfterAuth === false) {
        if (error.code === 'csrf_invalid') {
          this.acceptSession(
            await this.send({ path: '/v1/auth/session', schema: sessionInfoSchema }),
          );
        } else if (error.status === 401) {
          try {
            await this.coordinator.refresh(startedAt);
          } catch (refreshError) {
            if (refreshError instanceof ApiRequestError && refreshError.status === 401) {
              this.clearSession();
              this.options.onSessionExpired?.();
            }
            throw refreshError;
          }
        }
        // Auth is repaired for the person's next explicit attempt; this turn was not resent.
        throw error;
      }
      if (
        !(error instanceof ApiRequestError) ||
        error.status !== 401 ||
        options.retryOnUnauthenticated === false
      ) {
        if (error instanceof ApiRequestError && error.code === 'csrf_invalid') {
          return this.retryAfterCsrf(options);
        }
        throw error;
      }
      return this.recover(options, startedAt, error);
    }
  }

  /** An authenticated download; a refused session shares the tab's coordinated refresh. */
  download(path: string, signal?: AbortSignal): Promise<Blob> {
    return this.request<Blob>({ path, schema: null, responseType: 'blob', signal });
  }

  /** The CSRF token is tied to the session; read it again once and retry. */
  private async retryAfterCsrf<Output>(options: RequestOptions<Output>): Promise<Output> {
    const session = await this.send({
      path: '/v1/auth/session',
      schema: sessionInfoSchema,
      retryOnUnauthenticated: false,
    });
    this.acceptSession(session);
    return this.send(options);
  }

  private async recover<Output>(
    options: RequestOptions<Output>,
    startedAt: number,
    original: ApiRequestError,
  ): Promise<Output> {
    try {
      const outcome = await this.coordinator.refresh(startedAt);
      try {
        return await this.send(options);
      } catch (error) {
        // Another tab refreshed a moment ago, yet this request is still refused: force our own.
        if (
          outcome === 'already-refreshed' &&
          error instanceof ApiRequestError &&
          error.status === 401
        ) {
          await this.coordinator.refresh(Number.POSITIVE_INFINITY);
          return await this.send(options);
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        this.clearSession();
        this.options.onSessionExpired?.();
        throw error;
      }
      // A refresh that failed for another reason (network, 5xx) is not the end of the session.
      throw error instanceof ApiRequestError ? error : original;
    }
  }

  private async send<Output>(options: RequestOptions<Output>): Promise<Output> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = {
      Accept:
        options.accept ??
        (options.responseType === 'blob' ? 'application/octet-stream' : 'application/json'),
    };
    // A FormData body (an upload) sets its own multipart content type, with the boundary.
    const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
    if (options.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
    if (!SAFE_METHODS.has(method) && this.csrfToken) headers[CSRF_HEADER] = this.csrfToken;

    let response: Response;
    try {
      const doFetch = this.options.fetchImpl?.() ?? globalThis.fetch.bind(globalThis);
      response = await doFetch(buildUrl(this.options.baseUrl, options.path, options.query), {
        method,
        headers,
        credentials: 'include',
        cache: 'no-store',
        ...(options.body === undefined
          ? {}
          : { body: isForm ? (options.body as FormData) : JSON.stringify(options.body) }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new ApiRequestError(0, 'network', 'The API could not be reached');
    }

    if (!response.ok) throw await errorFromResponse(response);
    if (options.readResponse) return options.readResponse(response, options.signal);
    if (options.responseType === 'blob') return (await response.blob()) as Output;
    if (options.schema === null) return undefined as Output;

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ApiRequestError(
        response.status,
        'invalid_response',
        'The API sent an unreadable answer',
      );
    }
    const parsed = options.schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiRequestError(
        response.status,
        'invalid_response',
        'The API answer does not match the contract',
      );
    }
    return parsed.data;
  }
}
