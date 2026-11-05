import { randomBytes } from 'node:crypto';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import {
  createConcurrencyLimiter,
  isAssistantRequest,
  type LlmProvider,
  type LlmRequest,
} from '@watchtower/ai';
import {
  CSRF_HEADER,
  assistantPhaseEventSchema,
  assistantReplySchema,
  type AssistantPhaseEvent,
  type AssistantReply,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_LLM } from '../ai/ai-runtime.js';
import { startHarness, type Harness } from '../testing/harness.js';
import { apiOrg, signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';

// T-408: the SSE transport of POST /v1/assistant/messages on the real module graph, Postgres and Redis. The model is a fake
// provider behind the same limiter the live provider gets (one slot for the assistant, a queue of two), whose calls a test
// can hold and release, so the order of the events, the queue, the abort and the audit-before-reply rule are seen for real.
const net = disableNetConnect();

const limiter = createConcurrencyLimiter({
  maxConcurrent: 2,
  reservedSlots: 1,
  maxQueued: 2,
  isLowPriority: isAssistantRequest,
});

interface Held {
  readonly prompt: string;
  aborted: boolean;
  release(): void;
}
const held: Held[] = [];
/** How long a call takes when `auto` is on, ms. */
let delayMs = 0;
let auto = true;
/** What the plan step asks for: one cheap read tool, so a `tool` phase is seen. */
const PLAN = JSON.stringify({
  calls: [{ tool: 'search_tickets', input: { query: 'zzzz-no-such' } }],
});
const ANSWER = JSON.stringify({
  claims: [{ text: 'Nothing matches that search.', evidenceIds: [] }],
  proposals: [],
});

const fake: LlmProvider = {
  kind: 'mock',
  generate(request: LlmRequest) {
    return new Promise((resolve, reject) => {
      const call: Held = {
        prompt: request.prompt.id,
        aborted: false,
        release: () => {
          resolve({
            text: request.prompt.id === 'assistant_plan' ? PLAN : ANSWER,
            finishReason: 'stop',
            usage: { inputTokens: 30, outputTokens: 10 },
            model: request.model,
          });
        },
      };
      held.push(call);
      request.abortSignal?.addEventListener(
        'abort',
        () => {
          call.aborted = true;
          reject(new Error('aborted'));
        },
        { once: true },
      );
      if (auto) {
        setTimeout(() => {
          call.release();
        }, delayMs);
      }
    });
  },
};

let h: Harness;
const suffix = `x${randomBytes(3).toString('hex')}`;
const owner = () => h.db.owner.pool;

interface Seen {
  readonly event: AssistantPhaseEvent;
  /** ms since the request was sent. */
  readonly at: number;
}

interface Stream {
  readonly status: number;
  readonly contentType: string | null;
  readonly events: Seen[];
  readonly finished: Promise<void>;
  readonly abort: () => void;
}

/** POST with `Accept: text/event-stream`, reading the body as it arrives. */
async function stream(
  who: Persona,
  body: Record<string, unknown>,
  accept = 'text/event-stream',
): Promise<Stream> {
  const controller = new AbortController();
  const startedAt = performance.now();
  const headers: Record<string, string> = {
    'x-forwarded-for': who.client.ip,
    'content-type': 'application/json',
    accept,
    origin: new URL(h.config.APP_URL).origin,
    cookie: [...who.client.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
  };
  if (who.client.csrfToken !== undefined) headers[CSRF_HEADER] = who.client.csrfToken;
  const response = await fetch(`${h.base}/v1/assistant/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  const events: Seen[] = [];
  const finished = (async () => {
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      await response.arrayBuffer().catch(() => undefined);
      return;
    }
    const body = response.body as unknown as NodeReadableStream<Uint8Array> | null;
    if (body === null) return;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice(6);
          if (data === undefined) continue; // a keep-alive comment
          events.push({
            event: assistantPhaseEventSchema.parse(JSON.parse(data)),
            at: performance.now() - startedAt,
          });
        }
      }
    } catch {
      // The test aborted the read.
    }
  })();
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    events,
    finished,
    abort: () => {
      controller.abort();
    },
  };
}

const phases = (s: Stream): string[] => s.events.map((seen) => seen.event.phase);

const until = async (done: () => boolean, ms = 8000): Promise<void> => {
  const stop = Date.now() + ms;
  while (!done() && Date.now() < stop) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(done()).toBe(true);
};

const auditRows = async (conversationId: string) =>
  (
    await owner().query<{ action: string; metadata: Record<string, unknown>; created_at: Date }>(
      `SELECT action, metadata, created_at FROM audit_log
        WHERE target_id = $1 AND action = 'assistant.message'`,
      [conversationId],
    )
  ).rows;

beforeAll(async () => {
  h = await startHarness({ overrides: [{ token: API_LLM, value: limiter.limit(fake) }] });
});

afterAll(async () => {
  await h.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

describe('SSE phases', () => {
  it('sends queued, context, tool, answering, reply in that order, as they happen', async () => {
    auto = true;
    delayMs = 150;
    const agent = await signIn(h, 'agent');
    const s = await stream(agent, { text: 'find nothing please', locale: 'en' });
    expect(s.status).toBe(200);
    expect(s.contentType).toContain('text/event-stream');
    await s.finished;

    const order = phases(s);
    expect(order[0]).toBe('queued');
    expect(order[1]).toBe('context');
    expect(order.slice(2)).toEqual(['tool', 'tool', 'answering', 'reply']);
    const [running, ok] = s.events.filter((seen) => seen.event.phase === 'tool');
    expect(running?.event).toMatchObject({ name: 'search_tickets', status: 'running' });
    expect(ok?.event).toMatchObject({ name: 'search_tickets', status: 'ok' });

    // The first event reaches the person at once; the reply comes after the two model calls (2 x 150 ms).
    const first = s.events[0];
    const last = s.events[s.events.length - 1];
    expect(first?.at).toBeLessThan(300);
    expect(last?.at ?? 0).toBeGreaterThan(first?.at ?? 0 + 250);
    // The phases were not buffered until the end: `answering` arrived well before `reply`.
    const answering = s.events.find((seen) => seen.event.phase === 'answering');
    expect((last?.at ?? 0) - (answering?.at ?? 0)).toBeGreaterThan(100);

    const reply = last?.event;
    if (reply?.phase !== 'reply') throw new Error('no reply event');
    expect(assistantReplySchema.parse(reply.reply)).toEqual(reply.reply);
    expect(reply.reply.state).toBe('ok');
    expect(reply.reply.tools).toEqual([{ name: 'search_tickets', status: 'ok', mock: false }]);
  });

  it('keeps JSON the default, with the same audit row and no second one from the interceptor', async () => {
    auto = true;
    delayMs = 0;
    const agent = await signIn(h, 'agent');
    const json = await agent.client.post<AssistantReply>('/v1/assistant/messages', {
      text: 'one in json',
    });
    expect(json.status).toBe(200);
    expect(json.headers.get('content-type')).toContain('application/json');
    expect(assistantReplySchema.parse(json.body).state).toBe('ok');
    const jsonRows = await auditRows(json.body.conversationId);
    expect(jsonRows).toHaveLength(1);

    const s = await stream(agent, { text: 'one over the stream' });
    await s.finished;
    const last = s.events[s.events.length - 1]?.event;
    if (last?.phase !== 'reply') throw new Error('no reply');
    const rows = await auditRows(last.reply.conversationId);
    expect(rows).toHaveLength(1);
    // The same `Accept` that names JSON stays JSON.
    const accept = await stream(agent, { text: 'accept json' }, 'application/json');
    expect(accept.contentType).toContain('application/json');
  });

  it('writes the audit row (with the phase timings) before the reply is sent, and never a reply without one (C-4)', async () => {
    auto = true;
    delayMs = 50;
    const agent = await signIn(h, 'agent');
    const s = await stream(agent, { text: 'audit me' });
    await s.finished;
    const reply = s.events[s.events.length - 1]?.event;
    if (reply?.phase !== 'reply') throw new Error('no reply');
    const rows = await auditRows(reply.reply.conversationId);
    expect(rows).toHaveLength(1);
    const latency = rows[0]?.metadata.latencyMs as Record<string, number>;
    expect(Object.keys(latency).sort()).toEqual(
      ['answerMs', 'contextMs', 'firstEventMs', 'planMs', 'queueMs', 'toolsMs', 'totalMs'].sort(),
    );
    expect(latency.totalMs).toBeGreaterThanOrEqual(100);
    expect(latency.firstEventMs).toBeLessThan(300);
    expect(latency.answerMs).toBeGreaterThanOrEqual(40);

    // Now make the audit write fail for this person: no `reply` leaves, only an error event; JSON is a 503.
    await owner().query(
      `CREATE OR REPLACE FUNCTION wt_a4_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.action = 'assistant.message' AND NEW.actor_id = '${agent.userId}'::uuid THEN
           RAISE EXCEPTION 'audit refused for the test';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await owner().query(
      `CREATE TRIGGER wt_a4_refuse BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION wt_a4_refuse()`,
    );
    try {
      const refused = await stream(agent, { text: 'no record, no answer' });
      await refused.finished;
      expect(phases(refused)).not.toContain('reply');
      const end = refused.events[refused.events.length - 1]?.event;
      expect(end).toEqual({
        phase: 'error',
        state: 'unavailable',
        reason: 'assistant_audit_failed',
      });
      const json = await agent.client.post<ApiErrorBody>('/v1/assistant/messages', {
        text: 'no record, no answer, json',
      });
      expect(json.status).toBe(503);
      expect(json.body.code).toBe('assistant_audit_failed');
    } finally {
      await owner().query(`DROP TRIGGER wt_a4_refuse ON audit_log`);
      await owner().query(`DROP FUNCTION wt_a4_refuse()`);
    }
  });

  it('turns a state that is not ok into an error event after the audit row, not a reply', async () => {
    auto = true;
    delayMs = 0;
    const agent = await signIn(h, 'agent');
    await owner().query(`UPDATE ai_switch SET is_on = true WHERE key = 'ai_kill_switch'`);
    try {
      const before = held.length;
      const s = await stream(agent, { text: 'are you there' });
      await s.finished;
      expect(s.status).toBe(200);
      expect(phases(s)).not.toContain('reply');
      const end = s.events[s.events.length - 1]?.event;
      expect(end).toEqual({ phase: 'error', state: 'paused', reason: 'kill_switch_on' });
      // No model call was made, and the turn is on the log all the same.
      expect(held.length).toBe(before);
      const rows = await owner().query(
        `SELECT 1 FROM audit_log WHERE action = 'assistant.message' AND actor_id = $1
            AND metadata->>'reason' = 'kill_switch_on'`,
        [agent.userId],
      );
      expect(rows.rowCount).toBe(1);
    } finally {
      await owner().query(`UPDATE ai_switch SET is_on = false WHERE key = 'ai_kill_switch'`);
    }
  });

  it('answers a conversation that is not yours with a 404, before any stream opens', async () => {
    const agent = await signIn(h, 'agent');
    const s = await stream(agent, {
      text: 'whose is this',
      conversationId: '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11',
    });
    expect(s.status).toBe(404);
    expect(s.contentType).not.toContain('text/event-stream');
    const lead = await signIn(h, 'lead');
    const org = await apiOrg(lead, { name: `Stream Org ${suffix}` });
    const customer = await signIn(h, 'client', org.id);
    expect((await stream(customer, { text: 'hello' })).status).toBe(403);
  });
});

describe('queue, busy and abort', () => {
  it('shows the place in the queue, refuses past it with assistant_queue_full, and one turn per person', async () => {
    auto = false;
    held.length = 0;
    const [a, b, c, d, e] = await Promise.all([
      signIn(h, 'agent'),
      signIn(h, 'agent'),
      signIn(h, 'agent'),
      signIn(h, 'agent'),
      signIn(h, 'agent'),
    ]);

    // A takes the one slot of the assistant and holds it.
    const sa = await stream(a, { text: 'a asks' });
    await until(() => held.length === 1);
    // B and C wait behind it, in order.
    const sb = await stream(b, { text: 'b asks' });
    await until(() =>
      sb.events.some((seen) => seen.event.phase === 'queued' && seen.event.position === 1),
    );
    const sc = await stream(c, { text: 'c asks' });
    await until(() =>
      sc.events.some((seen) => seen.event.phase === 'queued' && seen.event.position === 2),
    );
    expect(limiter.snapshot()).toMatchObject({ active: 1, queued: 2 });

    // A second message from A while the first is unanswered: 429 before any stream.
    const again = await stream(a, { text: 'a asks again' });
    expect(again.status).toBe(429);

    // D finds the queue full: an error event with a stable reason, and nothing was sent to the model for it.
    const sd = await stream(d, { text: 'd asks' });
    await sd.finished;
    expect(sd.events[sd.events.length - 1]?.event).toEqual({
      phase: 'error',
      state: 'unavailable',
      reason: 'assistant_queue_full',
    });
    // Same over JSON: 200 with a state, never a hang.
    const je = await e.client.post<AssistantReply>('/v1/assistant/messages', { text: 'e asks' });
    expect(je.status).toBe(200);
    expect(je.body).toMatchObject({ state: 'unavailable', reason: 'assistant_queue_full' });

    // Let everything finish: B moves up to the front (position 0), and everybody answers.
    auto = true;
    for (const call of held.splice(0)) call.release();
    await Promise.all([sa.finished, sb.finished, sc.finished]);
    for (const s of [sa, sb, sc]) {
      expect(s.events[s.events.length - 1]?.event.phase).toBe('reply');
    }
    const bPositions = sb.events.flatMap((seen) =>
      seen.event.phase === 'queued' ? [seen.event.position] : [],
    );
    expect(bPositions[0]).toBe(0);
    expect(bPositions).toContain(1);
    expect(bPositions[bPositions.length - 1]).toBe(0);
    expect(limiter.snapshot()).toMatchObject({ active: 0, queued: 0 });
  }, 30_000);

  it('frees the slot when the person goes away, mid-call and in the queue, and lets them ask again', async () => {
    auto = false;
    held.length = 0;
    const a = await signIn(h, 'agent');
    const b = await signIn(h, 'agent');
    const sa = await stream(a, { text: 'a asks and leaves' });
    await until(() => held.length === 1);
    const sb = await stream(b, { text: 'b waits and leaves' });
    await until(() => limiter.snapshot().queued === 1);

    // B leaves the queue first: the queue is empty again, A still holds the slot.
    sb.abort();
    await until(() => limiter.snapshot().queued === 0);
    expect(limiter.snapshot().active).toBe(1);

    // A closes the page: the call to the model is cancelled and the slot is free.
    sa.abort();
    await until(() => held[0]?.aborted === true);
    await until(() => limiter.snapshot().active === 0);
    await Promise.all([sa.finished, sb.finished]);

    // Nothing is left behind: A may ask again, and gets an answer.
    auto = true;
    delayMs = 0;
    let retry = await stream(a, { text: 'a is back' });
    for (let i = 0; i < 50 && retry.status === 429; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      retry = await stream(a, { text: 'a is back' });
    }
    await retry.finished;
    expect(retry.status).toBe(200);
    expect(retry.events[retry.events.length - 1]?.event.phase).toBe('reply');
  }, 30_000);
});
