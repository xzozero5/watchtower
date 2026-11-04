/**
 * Field paths that structured loggers must censor (pino `redact` syntax). Apps pass this to their
 * logger; the list lives here so api and worker cannot drift apart. N1: no secret in logs.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  // The Pub/Sub push carries an OIDC bearer token here (T-207a C-10). Also the capitalised and proxy forms, and
  // the headers of an HTTP client error (`err.config.headers`, `response.request.headers`), which keep their case.
  'req.headers.Authorization',
  'req.headers["proxy-authorization"]',
  '*.headers.authorization',
  '*.headers.Authorization',
  '*.headers["proxy-authorization"]',
  '*.*.headers.authorization',
  '*.*.headers.Authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  // Bearer tokens of the public pages travel in these headers (portal tracking link, CSAT survey link).
  'req.headers["x-portal-token"]',
  'req.headers["x-csat-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwd',
  '*.secret',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.api_key',
  '*.authorization',
  '*.cookie',
  '*.privateKey',
  '*.clientSecret',
  '*.databaseUrl',
  '*.redisUrl',
  // Integration credential fields (ADR-012): a stored or typed value must never reach a log line.
  '*.channelSecret',
  '*.channelAccessToken',
  '*.botToken',
  '*.serviceAccountJson',
  '*.oauthClientSecret',
  '*.oauthRefreshToken',
  '*.anthropicApiKey',
  '*.vapidPrivate',
  '*.webhookSecret',
  '*.heartbeatSecret',
  '*.deploySecret',
  '*.webhookUrl',
  '*.webhookUrlUrgent',
  '*.fields',
  '*.config',
];

export const LOG_REDACT_CENSOR = '[Redacted]';

/**
 * Reduces a request target or URL to what is safe to log: no credentials, no query string and no
 * fragment. Query strings can carry magic-link or signed tokens.
 */
export function sanitizeUrlForLog(rawUrl: string): string {
  try {
    const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(rawUrl);
    const parsed = new URL(rawUrl, 'http://placeholder.invalid');
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return isAbsolute ? parsed.toString() : parsed.pathname;
  } catch {
    return '[unparseable url]';
  }
}

/** Keys under which an error may hold another error (or the payload that caused it). */
const ERROR_CAUSE_KEYS = ['cause', 'errors', 'aggregateErrors'] as const;
const MAX_CAUSE_DEPTH = 5;
/** Fields HTTP and SDK errors use for the bodies of the request and the response. */
const PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'body',
  'data',
  'response',
  'responseBody',
  'requestBody',
  'requestBodyValues',
  'responseHeaders',
  'text',
]);

/**
 * The error serializer of the loggers (pino `serializers.err`). It logs the error's own `type`,
 * `message`, `stack` and flat fields (strings, numbers, booleans such as `code` and `statusCode`),
 * and for everything in its `cause` chain only the type names (`causeTypes`).
 *
 * Why not pino's standard serializer: it appends the cause's message and stack to the error's, and
 * a provider SDK error keeps the request and response bodies on its cause, which can hold the
 * prompt (SR106-R10). Our own errors never put a payload in their own `message`.
 */
/**
 * Drizzle's query error puts the bound values after the SQL: `Failed query: <sql>\nparams: a,b,c`.
 * Those are row values (a LINE user id, an email), so they must not reach a log line, a stack or a
 * queue's `failedReason`. Everything from `params:` on is replaced; the SQL text stays.
 */
export function stripQueryParams(text: string): string {
  return text.replace(/(^|\r?\n)params:[\s\S]*?(?=\r?\n\s+at |$)/g, '$1params: [redacted]');
}

export function serializeErrorForLog(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return typeof error === 'object' && error !== null ? { type: 'NonError' } : error;
  }
  const out: Record<string, unknown> = {
    type: error.name,
    message: stripQueryParams(error.message),
    ...(error.stack === undefined ? {} : { stack: stripQueryParams(error.stack) }),
  };
  for (const [key, value] of Object.entries(error)) {
    if (key in out || PAYLOAD_KEYS.has(key)) continue;
    if ((ERROR_CAUSE_KEYS as readonly string[]).includes(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = typeof value === 'string' ? stripQueryParams(value) : value;
    }
  }
  const causeTypes: string[] = [];
  for (const key of ERROR_CAUSE_KEYS) {
    collectCauseTypes((error as unknown as Record<string, unknown>)[key], causeTypes, 0);
  }
  if (causeTypes.length > 0) out.causeTypes = causeTypes.slice(0, 10);
  return out;
}

function collectCauseTypes(value: unknown, into: string[], depth: number): void {
  if (depth > MAX_CAUSE_DEPTH || value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) collectCauseTypes(item, into, depth + 1);
    return;
  }
  if (value instanceof Error) {
    into.push(value.name.slice(0, 100));
    for (const key of ERROR_CAUSE_KEYS) {
      collectCauseTypes((value as unknown as Record<string, unknown>)[key], into, depth + 1);
    }
    return;
  }
  into.push('NonError');
}
