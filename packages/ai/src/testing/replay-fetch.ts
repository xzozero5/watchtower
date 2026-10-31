/**
 * Test double for the injected `fetch`: answers from fixtures, records what was asked, and never
 * touches the network. Not part of the build (`tsconfig.build.json` excludes `src/testing`).
 *
 * `globalThis.Response` is used on purpose: the lint rule that bans the bare `Response` global in
 * this package exists to keep production code off the network, and this file is test-only.
 */
import type { FetchLike } from '../providers/sdk.js';

export interface RecordedRequest {
  url: string;
  method: string;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  body: unknown;
}

export interface ReplayReply {
  status?: number;
  json: unknown;
}

export function createReplayFetch(handler: (request: RecordedRequest) => ReplayReply): {
  fetch: FetchLike;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const replay: FetchLike = (input, init) => {
    const headers: Record<string, string> = {};
    new globalThis.Headers(init?.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    const request: RecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    requests.push(request);
    const reply = handler(request);
    return Promise.resolve(
      new globalThis.Response(JSON.stringify(reply.json), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch: replay, requests };
}

/** A fetch that fails the test if anything calls it. */
export const forbiddenFetch: FetchLike = () => {
  throw new Error('This test must not reach the network');
};
