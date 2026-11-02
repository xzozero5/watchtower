import { apiErrorSchema, type AuthErrorCode } from '@watchtower/shared';

/** Codes the api sends (`AuthErrorCode`) plus the ones only the browser can produce. */
export type ApiErrorCode = AuthErrorCode | 'network' | 'invalid_response' | 'unknown';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    /** The whole JSON body of the answer, for a 409 that carries more than `message` (AC-7 `blockers`). */
    readonly details?: unknown,
    /** Seconds from the `Retry-After` header, when the answer had a usable one. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }
}

export function isApiError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError;
}

/** True when the failure means "the session is over", as opposed to a transient error. */
export function isUnauthenticated(error: unknown): boolean {
  return isApiError(error) && error.status === 401;
}

/** Builds an error from a non-2xx response, reading the api's `{ code, message }` body if present. */
export async function errorFromResponse(response: Response): Promise<ApiRequestError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const header = Number(response.headers.get('Retry-After'));
  const retryAfter = Number.isFinite(header) && header > 0 ? Math.ceil(header) : undefined;
  const parsed = apiErrorSchema.safeParse(body);
  if (parsed.success) {
    return new ApiRequestError(
      response.status,
      parsed.data.code,
      parsed.data.message,
      body,
      retryAfter,
    );
  }
  return new ApiRequestError(
    response.status,
    'unknown',
    `Request failed (${String(response.status)})`,
  );
}
