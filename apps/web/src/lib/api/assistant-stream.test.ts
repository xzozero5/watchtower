import type { AssistantReply } from '@watchtower/shared';
import { describe, expect, it, vi } from 'vitest';

import { makeSession } from '@/test/fixtures';

import { ApiClient } from './client';
import { createAssistantEndpoints } from './assistant-endpoints';
import {
  ASSISTANT_STREAM_LIMITS,
  AssistantStreamError,
  readAssistantStream,
} from './assistant-stream';

const reply: AssistantReply = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  messageId: '22222222-2222-4222-8222-222222222222',
  state: 'ok',
  reason: null,
  locale: 'th',
  claims: [],
  proposals: [],
  tools: [],
};
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
function response(text: string, split = false) {
  const bytes = new TextEncoder().encode(text);
  const cancel = vi.fn();
  return {
    cancel,
    response: new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (split) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          else controller.enqueue(bytes);
          controller.close();
        },
        cancel,
      }),
      { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
    ),
  };
}

describe('assistant SSE transport', () => {
  it('decodes split UTF-8/CRLF, comments, multiline data and all checked phases', async () => {
    const events = [
      { phase: 'queued', position: 2 },
      { phase: 'context', chips: [{ kind: 'ticket', label: 'ทดสอบ', status: 'resolved' }] },
      { phase: 'tool', name: 'ticket_get', status: 'running' },
      { phase: 'answering' },
      { phase: 'reply', reply },
    ];
    const text =
      ': keep-alive\r\n\r\n' +
      events
        .map((event) => `event: ${event.phase}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`)
        .join('');
    const seen = vi.fn();
    expect(await readAssistantStream(response(text, true).response, seen)).toEqual(reply);
    expect(seen.mock.calls.map(([event]) => event as unknown)).toEqual(events);
    const multi = 'data: {"phase":\n' + 'data: "reply","reply":' + JSON.stringify(reply) + '}\n\n';
    expect(await readAssistantStream(response(multi).response, vi.fn())).toEqual(reply);
  });

  it.each([
    'data: not-json\n\n',
    'data: {"phase":"queued","position":-1}\n\n',
    'event: reply\ndata: {"phase":"answering"}\n\n',
    frame({ phase: 'answering' }),
    'data: ' + 'x'.repeat(ASSISTANT_STREAM_LIMITS.frame + 1),
    frame({ phase: 'answering' }).repeat(ASSISTANT_STREAM_LIMITS.events + 1),
    ':'.repeat(ASSISTANT_STREAM_LIMITS.total + 1),
  ])('rejects malformed, truncated or oversized input (%#)', async (text) => {
    await expect(readAssistantStream(response(text).response, vi.fn())).rejects.toThrow();
  });

  it('reports a terminal error and cancels an open reader after reply', async () => {
    const seen = vi.fn();
    await expect(
      readAssistantStream(
        response(frame({ phase: 'error', state: 'budget', reason: 'budget_stop' })).response,
        seen,
      ),
    ).rejects.toBeInstanceOf(AssistantStreamError);
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(frame({ phase: 'reply', reply })));
      },
      cancel,
    });
    await readAssistantStream(
      new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
      vi.fn(),
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('aborts a blocked read and ignores anything after cancellation', async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const seen = vi.fn();
    const pending = readAssistantStream(
      new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
      seen,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(seen).not.toHaveBeenCalled();
  });

  it('accepts old JSON on the same POST and sends cookies, CSRF and SSE Accept', async () => {
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toMatchObject({ method: 'POST', credentials: 'include', cache: 'no-store' });
      expect(new Headers(init?.headers).get('accept')).toBe('text/event-stream');
      expect(new Headers(init?.headers).get('x-csrf-token')).toBe(makeSession('agent').csrfToken);
      return Promise.resolve(
        new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } }),
      );
    });
    const client = new ApiClient({ baseUrl: 'http://api.test', fetchImpl: () => fetcher });
    client.acceptSession(makeSession('agent'));
    expect(
      await createAssistantEndpoints(client).assistantMessage({ text: 'hello', locale: 'en' }),
    ).toEqual(reply);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 429, 500])(
    'never replays the turn after HTTP %i (repairs auth for explicit retry)',
    async (status) => {
      let posts = 0;
      const fetcher = vi.fn((url: RequestInfo | URL) => {
        const path = url instanceof Request ? url.url : url.toString();
        if (path.endsWith('/auth/session') || path.endsWith('/auth/refresh'))
          return Promise.resolve(
            new Response(JSON.stringify(makeSession('agent')), {
              headers: { 'content-type': 'application/json' },
            }),
          );
        posts++;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              statusCode: status,
              error: 'Error',
              code: status === 403 ? 'csrf_invalid' : 'internal_error',
              message: 'refused',
            }),
            { status },
          ),
        );
      });
      const client = new ApiClient({ baseUrl: 'http://api.test', fetchImpl: () => fetcher });
      await expect(
        createAssistantEndpoints(client).assistantMessage({ text: 'hello', locale: 'en' }),
      ).rejects.toThrow();
      expect(posts).toBe(1);
      if (status === 401 || status === 403) expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
});
