import { createHash, createHmac } from 'node:crypto';

import type { LlmRequest } from './contract.js';

/** sha256 of a UTF-8 string, lowercase hex. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * JSON with object keys sorted, so equal values hash equally whatever their key order. `undefined`
 * properties are dropped, as JSON.stringify does.
 */
export function canonicalJson(value: unknown): string {
  // JSON.stringify returns undefined (despite its type) for undefined, functions and symbols.
  const json = JSON.stringify(sortKeys(value)) as string | undefined;
  return json ?? 'null';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, sortKeys(item)]));
  }
  return value;
}

export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Keyed hash of the redacted input for the audit row (R-7). Redaction has known gaps, so the
 * input may still hold PII; a plain sha256 of a short or guessable input could be reversed by
 * brute force. With a server-side key the hash only supports "same input?" lookups for whoever
 * holds the key. Not `hashLlmInput`, which is unkeyed and exists for mock-rule matching only.
 */
export function hmacInputHash(
  hmacKey: string,
  request: Pick<LlmRequest, 'system' | 'messages'>,
): string {
  const input = canonicalJson({
    system: request.system,
    messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
  });
  return createHmac('sha256', hmacKey).update(input, 'utf8').digest('hex');
}

/**
 * Keyed hash of any JSON value (parameters of a tool run, a tool's result) for an audit row or an
 * evidence card (N4): it proves "this is what was asked / found" to whoever holds the key and shows
 * nothing to anyone else. Key order does not matter.
 */
export function hmacJson(hmacKey: string, value: unknown): string {
  return createHmac('sha256', hmacKey).update(canonicalJson(value), 'utf8').digest('hex');
}

/**
 * Unkeyed hash of what the model would see, for the mock provider's rules. It leaves out the model
 * id and the tier, so changing the settings does not change which canned answer a test gets. Do
 * not store it: audit rows use `hmacInputHash`.
 */
export function hashLlmInput(request: Pick<LlmRequest, 'system' | 'messages'>): string {
  return hashJson({
    system: request.system,
    messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
  });
}
