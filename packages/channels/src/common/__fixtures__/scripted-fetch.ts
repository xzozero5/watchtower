import type { FetchLike } from '../http.js';

/** A `fetch` that plays back scripted responses and records what it was asked. Test use only. */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly hasSignal: boolean;
}

export type ScriptStep =
  Response | Error | ((request: RecordedRequest) => Response | Error | Promise<Response | Error>);

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function scriptedFetch(steps: readonly ScriptStep[]): {
  readonly fetch: FetchLike;
  readonly requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  let index = 0;
  const fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const recorded: RecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
      hasSignal: init?.signal !== undefined && init.signal !== null,
    };
    requests.push(recorded);
    const step = steps[index];
    index += 1;
    if (step === undefined) throw new Error('scripted fetch: no more steps');
    const resolved = typeof step === 'function' ? await step(recorded) : step;
    if (resolved instanceof Error) throw resolved;
    return resolved;
  };
  return { fetch, requests };
}

export function timeoutError(): Error {
  const error = new Error('The operation timed out');
  error.name = 'TimeoutError';
  return error;
}

/** No waiting in tests: records the requested delays instead. */
export function recordingSleep(): {
  readonly sleep: (ms: number) => Promise<void>;
  readonly delays: number[];
} {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}
