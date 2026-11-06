import {
  assistantPhaseEventSchema,
  assistantReplySchema,
  type AssistantPhaseEvent,
  type AssistantReply,
} from '@watchtower/shared';

import { ApiRequestError } from './errors';

// Bound untrusted input even when a proxy never terminates a frame or sends only keep-alives.
export const ASSISTANT_STREAM_LIMITS = { frame: 256 * 1024, total: 4 * 1024 * 1024, events: 256 };
const invalid = () => new ApiRequestError(200, 'invalid_response', 'Invalid assistant stream');

export class AssistantStreamError extends Error {
  constructor(readonly event: Extract<AssistantPhaseEvent, { phase: 'error' }>) {
    super('The assistant could not finish this turn');
  }
}

/** Phase-only SSE: no unchecked tokens are exposed, and an interrupted stream is never replayed. */
export async function readAssistantStream(
  response: Response,
  onPhase: (event: AssistantPhaseEvent) => void,
  signal?: AbortSignal,
): Promise<AssistantReply> {
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (mime !== 'text/event-stream' && mime !== 'application/json') throw invalid();
  if (!response.body) throw invalid();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let total = 0;
  let events = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      total += value?.byteLength ?? 0;
      if (total > ASSISTANT_STREAM_LIMITS.total) throw invalid();
      buffer += decoder.decode(value, { stream: !done });
      if (mime === 'application/json') {
        // Compatibility with the old JSON endpoint, on this same request; never a second POST.
        if (buffer.length > ASSISTANT_STREAM_LIMITS.frame) throw invalid();
        if (!done) continue;
        const reply = assistantReplySchema.parse(JSON.parse(buffer));
        onPhase({ phase: 'reply', reply });
        return reply;
      }
      for (;;) {
        const separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
        if (!separator) break;
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        if (frame.length > ASSISTANT_STREAM_LIMITS.frame) throw invalid();
        const data: string[] = [];
        let name = '';
        for (const line of frame.split(/\r\n|\n|\r/)) {
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const text = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'data') data.push(text);
          if (field === 'event') name = text;
        }
        if (data.length === 0) continue;
        if (++events > ASSISTANT_STREAM_LIMITS.events) throw invalid();
        const parsed = assistantPhaseEventSchema.safeParse(JSON.parse(data.join('\n')));
        if (!parsed.success || (name !== '' && name !== parsed.data.phase)) throw invalid();
        const event = parsed.data;
        signal?.throwIfAborted();
        onPhase(event);
        if (event.phase === 'error') throw new AssistantStreamError(event);
        if (event.phase === 'reply') return event.reply;
      }
      if (buffer.length > ASSISTANT_STREAM_LIMITS.frame || done) throw invalid();
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
