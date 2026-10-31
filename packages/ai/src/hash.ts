import { createHash } from 'node:crypto';

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
 * Hash of what the model would see. It leaves out the model id and the tier, so changing the
 * settings does not change which canned answer a test gets.
 */
export function hashLlmInput(request: Pick<LlmRequest, 'system' | 'messages'>): string {
  return hashJson({
    system: request.system,
    messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
  });
}
