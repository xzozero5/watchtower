import {
  apiErrorSchema,
  CSAT_TOKEN_HEADER,
  csatResponseResultSchema,
  csatSurveyViewSchema,
  humanChallengeSchema,
  PORTAL_MULTIPART_FILES_FIELD,
  PORTAL_MULTIPART_PAYLOAD_FIELD,
  PORTAL_TOKEN_HEADER,
  portalAcceptedSchema,
  portalReplyResultSchema,
  portalSubmittedSchema,
  portalTicketViewSchema,
  type CsatResponseInput,
  type CsatResponseResult,
  type CsatSurveyView,
  type HumanChallenge,
  type PortalReply,
  type PortalReplyResult,
  type PortalResend,
  type PortalSubmit,
  type PortalSubmitted,
  type PortalTicketView,
} from '@watchtower/shared';
import type { z } from 'zod';

/** What went wrong, in the terms the pages talk about. */
export type PortalFailureKind =
  | 'verification'
  | 'rateLimited'
  | 'invalidLink'
  | 'notOpen'
  | 'attachment'
  | 'validation'
  | 'network'
  | 'server';

export class PortalApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    /** Seconds from the `Retry-After` header of a 429, when there was one. */
    readonly retryAfterSeconds: number | null,
  ) {
    super(`portal request failed (${status === 0 ? 'network' : String(status)})`);
    this.name = 'PortalApiError';
  }
}

export interface PortalFailure {
  kind: PortalFailureKind;
  retryAfterSeconds: number | null;
}

/** Used when a 429 carries no usable `Retry-After`. `[ASSUMED]` */
export const DEFAULT_RETRY_AFTER_SECONDS = 60;

/**
 * Maps any error to a failure kind the UI has copy for. Status and `code` decide, never the
 * message text.
 */
export function classifyPortalError(error: unknown): PortalFailure {
  if (!(error instanceof PortalApiError)) return { kind: 'server', retryAfterSeconds: null };
  const none = null;
  if (error.status === 0) return { kind: 'network', retryAfterSeconds: none };
  if (error.status === 429 || error.code === 'rate_limited') {
    return { kind: 'rateLimited', retryAfterSeconds: error.retryAfterSeconds };
  }
  if (error.code === 'verification_failed')
    return { kind: 'verification', retryAfterSeconds: none };
  // A file the api would not take (type, content, size, count): the person removes it and retries.
  if (
    error.code === 'attachment_rejected' ||
    error.code === 'archive_not_accepted' ||
    error.status === 413
  ) {
    return { kind: 'attachment', retryAfterSeconds: none };
  }
  if (error.status === 401 || error.code === 'invalid_or_expired_link') {
    return { kind: 'invalidLink', retryAfterSeconds: none };
  }
  if (error.status === 409 || error.code === 'ticket_not_open') {
    return { kind: 'notOpen', retryAfterSeconds: none };
  }
  if (error.status === 400 || error.code === 'validation_failed') {
    return { kind: 'validation', retryAfterSeconds: none };
  }
  return { kind: 'server', retryAfterSeconds: none };
}

/** `Retry-After` is a number of seconds (the api sends that); an HTTP date is also allowed. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d{1,7}$/.test(trimmed)) return Math.max(1, Number(trimmed));
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(1, Math.ceil((date - now) / 1000));
}

/** The JSON body as it is, or multipart (`payload` + `files`) when there are files to send. */
export function multipartBody(payload: unknown, files: readonly File[]): unknown {
  if (files.length === 0) return payload;
  const form = new FormData();
  form.append(PORTAL_MULTIPART_PAYLOAD_FIELD, JSON.stringify(payload));
  for (const file of files) form.append(PORTAL_MULTIPART_FILES_FIELD, file, file.name);
  return form;
}

export interface PortalClientOptions {
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
  /** The tracking token for this ticket (or survey link). Goes in a header only. */
  token?: string;
  /** The header that carries it. Default: the portal tracking header. */
  tokenHeader?: string;
  signal?: AbortSignal;
}

/**
 * Client of the public portal api (`/v1/portal/*`). There is no session: no cookies are sent
 * (`credentials: 'omit'`), no CSRF token exists, and the tracking token travels in the
 * `X-Portal-Token` header, never in a URL. Responses are validated with the shared Zod schemas.
 */
export class PortalClient {
  constructor(private readonly options: PortalClientOptions) {}

  challenge(signal?: AbortSignal): Promise<HumanChallenge> {
    return this.call({
      method: 'GET',
      path: '/v1/portal/challenge',
      schema: humanChallengeSchema,
      ...(signal ? { signal } : {}),
    });
  }

  /** With files the request is multipart: the form as JSON in `payload`, the files in `files`. */
  submit(
    body: PortalSubmit,
    signal?: AbortSignal,
    files: readonly File[] = [],
  ): Promise<PortalSubmitted> {
    return this.call({
      method: 'POST',
      path: '/v1/portal/tickets',
      body: multipartBody(body, files),
      schema: portalSubmittedSchema,
      ...(signal ? { signal } : {}),
    });
  }

  ticket(key: string, token: string, signal?: AbortSignal): Promise<PortalTicketView> {
    return this.call({
      method: 'GET',
      path: `/v1/portal/tickets/${encodeURIComponent(key)}`,
      schema: portalTicketViewSchema,
      token,
      ...(signal ? { signal } : {}),
    });
  }

  reply(
    key: string,
    token: string,
    body: PortalReply,
    files: readonly File[] = [],
  ): Promise<PortalReplyResult> {
    return this.call({
      method: 'POST',
      path: `/v1/portal/tickets/${encodeURIComponent(key)}/replies`,
      body: multipartBody(body, files),
      schema: portalReplyResultSchema,
      token,
    });
  }

  /** The request a CSAT survey link is about (T-110b). 401: bad link. 409: already answered. */
  csatSurvey(token: string, signal?: AbortSignal): Promise<CsatSurveyView> {
    return this.call({
      method: 'GET',
      path: '/v1/csat/survey',
      schema: csatSurveyViewSchema,
      token,
      tokenHeader: CSAT_TOKEN_HEADER,
      ...(signal ? { signal } : {}),
    });
  }

  /** Answers the survey, once. 401: bad link. 409: already answered. */
  csatAnswer(token: string, body: CsatResponseInput): Promise<CsatResponseResult> {
    return this.call({
      method: 'POST',
      path: '/v1/csat/responses',
      body,
      schema: csatResponseResultSchema,
      token,
      tokenHeader: CSAT_TOKEN_HEADER,
    });
  }

  /** Always answers 202 `accepted`, whether or not the ticket and address match. */
  async resend(body: PortalResend): Promise<void> {
    await this.call({
      method: 'POST',
      path: '/v1/portal/track/resend',
      body,
      schema: portalAcceptedSchema,
    });
  }

  private async call<Output>(call: Call<Output>): Promise<Output> {
    const fetchFn = (this.options.fetchImpl ?? (() => fetch))();
    const headers: Record<string, string> = { accept: 'application/json' };
    // A FormData body gets its content type, with the boundary, from the browser.
    if (call.body !== undefined && !(call.body instanceof FormData)) {
      headers['content-type'] = 'application/json';
    }
    if (call.token !== undefined) headers[call.tokenHeader ?? PORTAL_TOKEN_HEADER] = call.token;

    let response: Response;
    try {
      response = await fetchFn(new URL(call.path, `${this.options.baseUrl}/`).toString(), {
        method: call.method,
        headers,
        ...(call.body === undefined
          ? {}
          : { body: call.body instanceof FormData ? call.body : JSON.stringify(call.body) }),
        // No ambient authority: nothing the browser stores is sent, nothing is cached.
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        ...(call.signal ? { signal: call.signal } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new PortalApiError(0, null, null);
    }

    if (!response.ok) {
      let code: string | null = null;
      try {
        const parsed = apiErrorSchema.safeParse(await response.json());
        if (parsed.success) code = parsed.data.code;
      } catch {
        // An error without a JSON body (a proxy page, for example) is classified by status alone.
      }
      const retryAfter =
        response.status === 429
          ? (parseRetryAfter(response.headers.get('retry-after')) ?? DEFAULT_RETRY_AFTER_SECONDS)
          : null;
      throw new PortalApiError(response.status, code, retryAfter);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new PortalApiError(response.status, 'invalid_response', null);
    }
    const parsed = call.schema.safeParse(json);
    if (!parsed.success) throw new PortalApiError(response.status, 'invalid_response', null);
    return parsed.data;
  }
}
