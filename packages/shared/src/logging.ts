/**
 * Field paths that structured loggers must censor (pino `redact` syntax). Apps pass this to their
 * logger; the list lives here so api and worker cannot drift apart. N1: no secret in logs.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
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

/** Keys under which a serialized error may hold another error (or the payload that caused it). */
const ERROR_CAUSE_KEYS = ['cause', 'errors', 'aggregateErrors'] as const;

/**
 * Makes an already serialized error (the output of pino's `err` serializer) safe to log: the
 * `cause` chain is replaced by the type names of the errors in it. A provider SDK error keeps the
 * request and response bodies on its `cause`, and those can hold the prompt, so the logger must not
 * serialise them (SR106-R10). The error's own `type`, `message`, `stack` and flat fields such as
 * `code` stay: our own errors never put a payload in `message`.
 */
export function stripErrorCauses(serialized: unknown): unknown {
  if (typeof serialized !== 'object' || serialized === null) return serialized;
  const kept: Record<string, unknown> = {};
  const causeTypes: string[] = [];
  for (const [key, value] of Object.entries(serialized as Record<string, unknown>)) {
    if ((ERROR_CAUSE_KEYS as readonly string[]).includes(key)) {
      collectCauseTypes(value, causeTypes, 0);
    } else {
      kept[key] = value;
    }
  }
  if (causeTypes.length > 0) kept.causeTypes = causeTypes.slice(0, 10);
  return kept;
}

function collectCauseTypes(value: unknown, into: string[], depth: number): void {
  if (depth > 5) return;
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) collectCauseTypes(item, into, depth + 1);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const record = value as Record<string, unknown>;
  const type = record.type ?? record.name;
  into.push(typeof type === 'string' ? type.slice(0, 100) : 'Error');
  for (const key of ERROR_CAUSE_KEYS) collectCauseTypes(record[key], into, depth + 1);
}
