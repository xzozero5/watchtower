import { apiErrorSchema, type AuthErrorCode } from '@watchtower/shared';

/** Codes the api sends (`AuthErrorCode`) plus the ones only the browser can produce. */
export type ApiErrorCode = AuthErrorCode | 'network' | 'invalid_response' | 'unknown';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
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
  const parsed = apiErrorSchema.safeParse(body);
  if (parsed.success) {
    return new ApiRequestError(response.status, parsed.data.code, parsed.data.message);
  }
  return new ApiRequestError(
    response.status,
    'unknown',
    `Request failed (${String(response.status)})`,
  );
}
