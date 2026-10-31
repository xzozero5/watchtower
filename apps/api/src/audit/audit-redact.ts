/**
 * Strips secrets from anything that is about to be written to the audit log (`before`, `after`,
 * `metadata`). The log is read by people and exported, and it outlives the data it describes, so a
 * token or password must never reach it (N1). Redaction works by key name, and also by the shape
 * of the value as a second net: a JWT, an argon2 hash, a bearer header or one of our own 256-bit
 * tokens is censored even under an innocent key.
 */

export const REDACTED = '[REDACTED]';
const TRUNCATED = '[TRUNCATED]';

const SENSITIVE_KEY =
  /pass(?:word|wd|phrase)?|secret|token|authorization|cookie|credential|api[-_]?key|private[-_]?key|csrf|signature|hash|salt|otp|verifier|code[-_]?challenge/i;

const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*$/;
const BEARER_SHAPE = /^bearer\s+\S+/i;
const PASSWORD_HASH_SHAPE = /^\$(?:argon2|2[aby]|scram)/i;
/** The format of generateOpaqueToken(): 32 random bytes, base64url. */
const OPAQUE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const MAX_DEPTH = 8;
const MAX_ARRAY = 100;
const MAX_STRING = 2000;
const MAX_KEYS = 100;

function redactString(value: string): string {
  const trimmed = value.trim();
  if (
    JWT_SHAPE.test(trimmed) ||
    BEARER_SHAPE.test(trimmed) ||
    PASSWORD_HASH_SHAPE.test(trimmed) ||
    OPAQUE_TOKEN_SHAPE.test(trimmed)
  ) {
    return REDACTED;
  }
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}${TRUNCATED}` : value;
}

export function redactForAudit(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return TRUNCATED;
  if (Array.isArray(value)) {
    const items: unknown[] = value
      .slice(0, MAX_ARRAY)
      .map((item: unknown) => redactForAudit(item, depth + 1));
    if (value.length > MAX_ARRAY) items.push(TRUNCATED);
    return items;
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (count >= MAX_KEYS) {
        result['…'] = TRUNCATED;
        break;
      }
      count += 1;
      result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactForAudit(item, depth + 1);
    }
    return result;
  }
  // functions, symbols
  return TRUNCATED;
}
