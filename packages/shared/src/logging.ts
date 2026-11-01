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
  // Integration credential fields (ADR-012): a stored or typed value must never reach a log line.
  '*.channelSecret',
  '*.channelAccessToken',
  '*.botToken',
  '*.serviceAccountJson',
  '*.anthropicApiKey',
  '*.vapidPrivate',
  '*.webhookUrl',
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
