import { vi } from 'vitest';

export interface MockRequest {
  method: string;
  url: URL;
  body: unknown;
  headers: Headers;
  params: Record<string, string>;
}

export interface MockResult {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}

export type MockHandler = ((request: MockRequest) => MockResult | Promise<MockResult>) | MockResult;

export interface RecordedCall {
  method: string;
  path: string;
  search: string;
  body: unknown;
  headers: Headers;
}

/**
 * A JSON body parsed; a multipart body (portal uploads) as `{ payload, files }`, where `payload` is
 * the parsed JSON field and `files` lists the name, size and type of each file part.
 */
function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body === 'string') return JSON.parse(body) as unknown;
  if (body instanceof FormData) {
    const payload = body.get('payload');
    return {
      payload: typeof payload === 'string' ? (JSON.parse(payload) as unknown) : undefined,
      files: body
        .getAll('files')
        .concat(body.getAll('file'))
        .filter((part): part is File => part instanceof File)
        .map((file) => ({ name: file.name, size: file.size, type: file.type })),
    };
  }
  return undefined;
}

function compile(pattern: string): { method: string; regex: RegExp; names: string[] } {
  const [method = 'GET', path = '/'] = pattern.split(' ');
  const names: string[] = [];
  const source = path.replace(/:([a-zA-Z]+)/g, (_whole, name: string) => {
    names.push(name);
    return '([^/]+)';
  });
  return { method, regex: new RegExp(`^${source}$`), names };
}

/**
 * Stubs the global `fetch` with a small router, so components are tested against the real API
 * client (CSRF header, refresh, schema validation) without a network. Routes are written as
 * `'GET /v1/tickets/:id'`; a handler returns `{ status, json }`. Anything unmatched answers 404.
 */
export function mockApi(routes: Record<string, MockHandler>) {
  const compiled = Object.entries(routes).map(([pattern, handler]) => ({
    ...compile(pattern),
    handler,
  }));
  const calls: RecordedCall[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = parseBody(init?.body);
    calls.push({ method, path: url.pathname, search: url.search, body, headers });

    for (const route of compiled) {
      if (route.method !== method) continue;
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      const params = Object.fromEntries(
        route.names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? '')]),
      );
      const result =
        typeof route.handler === 'function'
          ? await route.handler({ method, url, body, headers, params })
          : route.handler;
      const status = result.status ?? 200;
      if (status === 204 || result.json === undefined) return new Response(null, { status });
      return new Response(JSON.stringify(result.json), {
        status,
        headers: { 'content-type': 'application/json', ...result.headers },
      });
    }
    return new Response(
      JSON.stringify({
        statusCode: 404,
        error: 'Not Found',
        code: 'not_found',
        message: 'no mock',
      }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  });

  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    calls,
    /** Calls to a path, optionally narrowed by method. */
    callsTo: (path: string, method?: string) =>
      calls.filter(
        (call) => call.path === path && (method === undefined || call.method === method),
      ),
  };
}

export function apiError(statusCode: number, code: string, message = code): MockResult {
  return { status: statusCode, json: { statusCode, error: 'Error', code, message } };
}
