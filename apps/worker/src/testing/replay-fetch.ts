import { readFileSync } from 'node:fs';

import type { FetchLike } from '@watchtower/ai';

/** A request as the injected `fetch` saw it (header names lower-cased, body parsed). */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  /** The body exactly as sent, for "this text never left the process" checks. */
  readonly rawBody: string;
}

/** Hand-written from the documented response shape, not recorded from a live call (no key exists). */
export function readFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
  ) as unknown;
}

/**
 * A `fetch` that answers every request from a fixture and records it. It never touches the network.
 * `globalThis.Response` is fine here: this file is test-only (excluded from the build).
 */
export function createReplayFetch(
  json: unknown,
  status = 200,
): { fetch: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const replay: FetchLike = (input, init) => {
    const headers: Record<string, string> = {};
    new globalThis.Headers(init?.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    requests.push({
      url: input instanceof URL ? input.href : typeof input === 'string' ? input : input.url,
      method: init?.method ?? 'GET',
      headers,
      body: rawBody === '' ? undefined : (JSON.parse(rawBody) as unknown),
      rawBody,
    });
    return Promise.resolve(
      new globalThis.Response(JSON.stringify(json), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch: replay, requests };
}

/** A `fetch` that fails the test if anything calls it. */
export const forbiddenFetch: FetchLike = () => {
  throw new Error('This test must not reach the network');
};
