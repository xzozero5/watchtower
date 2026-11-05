import { randomBytes, randomUUID } from 'node:crypto';

import type { LlmProvider } from '@watchtower/ai';
import { purgeExpired } from '@watchtower/db';
import {
  assistantConversationListSchema,
  assistantFeedbackSchema,
  assistantMemoryListSchema,
  assistantMemorySchema,
  type AssistantConversationList,
  type AssistantMemory,
  type AssistantMemoryList,
  type AssistantReply,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_LLM } from '../ai/ai-runtime.js';
import { startHarness, type Harness } from '../testing/harness.js';
import { apiOrg, signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';

// T-408 on the real application module and Postgres: the conversations list, the pinned facts ("remember this") and
// the feedback of the assistant. The model says whatever `say` holds, so the sentences to pin are known.
const net = disableNetConnect();

let say: string[] = ['The queue looks calm today.'];
const model: LlmProvider = {
  kind: 'mock',
  generate(request) {
    const text =
      request.prompt.id === 'assistant_plan'
        ? JSON.stringify({ calls: [] })
        : JSON.stringify({
            claims: say.map((sentence) => ({ text: sentence, evidenceIds: [] })),
            proposals: [],
          });
    return Promise.resolve({
      text,
      finishReason: 'stop' as const,
      usage: { inputTokens: 20, outputTokens: 10 },
      model: request.model,
    });
  },
};

let h: Harness;
let agent: Persona;
let other: Persona;
let dev: Persona;
let client: Persona;
const suffix = `x${randomBytes(3).toString('hex')}`;
const owner = () => h.db.owner.pool;

async function ask(who: Persona, text: string, sentences: string[]): Promise<AssistantReply> {
  say = sentences;
  const response = await who.client.post<AssistantReply>('/v1/assistant/messages', { text });
  if (response.status !== 200 || response.body.state !== 'ok') {
    throw new Error(`message: ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

const remember = (who: Persona, messageId: string, claim: number) =>
  who.client.post<AssistantMemory & ApiErrorBody>('/v1/assistant/memory', { messageId, claim });

beforeAll(async () => {
  h = await startHarness({ overrides: [{ token: API_LLM, value: model }] });
  agent = await signIn(h, 'agent');
  other = await signIn(h, 'agent');
  dev = await signIn(h, 'dev');
  const lead = await signIn(h, 'lead');
  client = await signIn(h, 'client', (await apiOrg(lead, { name: `Memory Org ${suffix}` })).id);
});

afterAll(async () => {
  await h.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

describe('who can reach the new routes', () => {
  it('refuses a customer on every one, and a person who is not signed in', async () => {
    const id = randomUUID();
    const anonymous = h.client();
    for (const who of [client.client, anonymous]) {
      const denied = who === client.client ? 403 : 401;
      expect((await who.get('/v1/assistant/conversations')).status).toBe(denied);
      expect((await who.get('/v1/assistant/memory')).status).toBe(denied);
      expect((await who.post('/v1/assistant/memory', { messageId: id, claim: 0 })).status).toBe(
        denied,
      );
      expect((await who.delete('/v1/assistant/memory')).status).toBe(denied);
      expect((await who.delete(`/v1/assistant/memory/${id}`)).status).toBe(denied);
      expect(
        (
          await who.post('/v1/assistant/feedback', {
            target: { kind: 'message', id },
            rating: 'up',
          })
        ).status,
      ).toBe(denied);
    }
  });
});

describe('conversations (own only)', () => {
  it('lists mine, newest first, with a redacted preview, and nobody else’s', async () => {
    const mine = await signIn(h, 'agent');
    const first = await ask(mine, 'first: mail jane.doe@customer.example please', ['One.']);
    const second = await ask(mine, 'second question', ['Two.']);
    await ask(other, 'somebody else asked this', ['Other.']);

    const list = await mine.client.get<AssistantConversationList>('/v1/assistant/conversations');
    expect(list.status).toBe(200);
    expect(assistantConversationListSchema.parse(list.body)).toEqual(list.body);
    expect(list.body.items.map((item) => item.id)).toEqual([
      second.conversationId,
      first.conversationId,
    ]);
    const entry = list.body.items.find((item) => item.id === first.conversationId);
    expect(entry?.messageCount).toBe(2);
    // The preview is what is stored: the address is a placeholder.
    expect(entry?.preview).not.toContain('jane.doe@customer.example');
    expect(entry?.preview?.length).toBeLessThanOrEqual(120);

    const theirs = await other.client.get<AssistantConversationList>('/v1/assistant/conversations');
    const ids = theirs.body.items.map((item) => item.id);
    expect(ids).not.toContain(first.conversationId);
    expect(ids).not.toContain(second.conversationId);

    // Deleting removes it from the list.
    expect(
      (await mine.client.delete(`/v1/assistant/conversations/${first.conversationId}`)).status,
    ).toBe(200);
    const after = await mine.client.get<AssistantConversationList>('/v1/assistant/conversations');
    expect(after.body.items.map((item) => item.id)).not.toContain(first.conversationId);
  });
});

describe('memory', () => {
  it('pins one sentence of an answer from its redacted text, never from the request, for 90 days', async () => {
    const who = await signIn(h, 'agent');
    const reply = await ask(who, 'tell me two things', [
      'Write to jane.doe@customer.example about the refund.',
      'The second sentence stays.',
    ]);
    // What the screen shows is restored; what is stored is redacted.
    const stored = await owner().query<{ body: string }>(
      `SELECT body FROM assistant_message WHERE id = $1`,
      [reply.messageId],
    );
    const lines = (stored.rows[0]?.body ?? '').split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toContain('jane.doe@customer.example');

    // A `body` in the request is not read: only the message and the sentence number are.
    const created = await who.client.post<AssistantMemory>('/v1/assistant/memory', {
      messageId: reply.messageId,
      claim: 0,
      body: 'my own words with jane.doe@customer.example',
    });
    expect(created.status).toBe(201);
    expect(assistantMemorySchema.parse(created.body)).toEqual(created.body);
    expect(created.body.body).toBe(lines[0]);
    expect(created.body.body).not.toContain('jane.doe@customer.example');
    expect(created.body.sourceMessageId).toBe(reply.messageId);
    // Ninety days from the day it was made.
    const days =
      (Date.parse(created.body.expiresAt) - Date.parse(created.body.createdAt)) / 86_400_000;
    expect(days).toBe(90);

    // Pressing again on the same sentence gives the same one back, not a second.
    const again = await remember(who, reply.messageId, 0);
    expect(again.body.id).toBe(created.body.id);
    expect(again.body.createdAt).toBe(created.body.createdAt);
    const second = await remember(who, reply.messageId, 1);
    expect(second.status).toBe(201);
    expect(second.body.body).toBe(lines[1]);

    const list = await who.client.get<AssistantMemoryList>('/v1/assistant/memory');
    expect(assistantMemoryListSchema.parse(list.body)).toEqual(list.body);
    expect(list.body.items.map((item) => item.id)).toEqual([second.body.id, created.body.id]);

    // The log has ids and counts, never the text.
    const log = await owner().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE action = 'assistant.memory.create' AND actor_id = $1 AND outcome = 'success'`,
      [who.userId],
    );
    expect(log.rowCount).toBe(3);
    expect(JSON.stringify(log.rows)).not.toContain('refund');
  });

  it('knows no sentence that is not there, and no answer that is not yours', async () => {
    const who = await signIn(h, 'agent');
    const reply = await ask(who, 'just one', ['Only one.']);
    expect((await remember(who, reply.messageId, 3)).status).toBe(404);
    expect((await remember(other, reply.messageId, 0)).status).toBe(404);
    expect((await remember(who, randomUUID(), 0)).status).toBe(404);
    // The question of the person is not an answer of the assistant.
    const asked = await owner().query<{ id: string }>(
      `SELECT id FROM assistant_message WHERE conversation_id = $1 AND role = 'user'`,
      [reply.conversationId],
    );
    expect((await remember(who, asked.rows[0]?.id ?? randomUUID(), 0)).status).toBe(404);
    // An answer that said nothing (`[budget_stop]`) has nothing to keep.
    const empty = randomUUID();
    await owner().query(
      `INSERT INTO assistant_message (id, conversation_id, user_id, role, body)
         VALUES ($1, $2, $3, 'assistant', '[budget_stop]')`,
      [empty, reply.conversationId, who.userId],
    );
    const nothing = await remember(who, empty, 0);
    expect(nothing.status).toBe(409);
    expect(nothing.body.code).toBe('assistant_nothing_to_remember');
  });

  it('keeps 20 at most, and answers 409 for the 21st', async () => {
    const who = await signIn(h, 'agent');
    for (let batch = 0; batch < 4; batch += 1) {
      const reply = await ask(
        who,
        `batch ${String(batch)}`,
        [0, 1, 2, 3, 4].map((n) => `Fact number ${String(batch * 5 + n)} of the shift.`),
      );
      for (let claim = 0; claim < 5; claim += 1) {
        expect((await remember(who, reply.messageId, claim)).status).toBe(201);
      }
    }
    const extra = await ask(who, 'one more', ['A twenty-first fact.']);
    const full = await remember(who, extra.messageId, 0);
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('assistant_memory_full');
    expect(
      (await who.client.get<AssistantMemoryList>('/v1/assistant/memory')).body.items,
    ).toHaveLength(20);
    // Pressing on one that is kept already is not a 21st.
    const first = await owner().query<{ source_message_id: string }>(
      `SELECT source_message_id FROM assistant_memory WHERE user_id = $1 ORDER BY created_at LIMIT 1`,
      [who.userId],
    );
    expect((await remember(who, first.rows[0]?.source_message_id ?? '', 0)).status).toBe(201);

    // Forget all of mine: 20 go, and then there is room again.
    const cleared = await who.client.delete<{ deleted: number }>('/v1/assistant/memory');
    expect(cleared.body).toEqual({ deleted: 20 });
    expect((await remember(who, extra.messageId, 0)).status).toBe(201);
  }, 60_000);

  it('is the person’s own: another person’s rows do not exist (404), and delete-all touches only mine', async () => {
    const mine = await signIn(h, 'agent');
    const theirs = await signIn(h, 'agent');
    const m = await ask(mine, 'mine', ['Mine to keep.']);
    const t = await ask(theirs, 'theirs', ['Theirs to keep.']);
    const mm = (await remember(mine, m.messageId, 0)).body;
    const tm = (await remember(theirs, t.messageId, 0)).body;

    expect((await mine.client.get<AssistantMemoryList>('/v1/assistant/memory')).body.items).toEqual(
      [mm],
    );
    const stranger = await theirs.client.delete<ApiErrorBody>(`/v1/assistant/memory/${mm.id}`);
    expect(stranger.status).toBe(404);
    const missing = await theirs.client.delete<ApiErrorBody>(
      `/v1/assistant/memory/${randomUUID()}`,
    );
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe(stranger.body.message);

    expect((await mine.client.delete(`/v1/assistant/memory/${mm.id}`)).status).toBe(200);
    expect((await mine.client.delete(`/v1/assistant/memory/${mm.id}`)).status).toBe(404);
    expect((await theirs.client.delete('/v1/assistant/memory')).status).toBe(200);
    expect((await mine.client.get<AssistantMemoryList>('/v1/assistant/memory')).body.items).toEqual(
      [],
    );
    expect(
      (await owner().query(`SELECT 1 FROM assistant_memory WHERE id = $1`, [tm.id])).rowCount,
    ).toBe(0);
    const log = await owner().query(
      `SELECT 1 FROM audit_log WHERE action = 'assistant.memory.delete' AND actor_id = $1 AND outcome = 'success'`,
      [mine.userId],
    );
    expect(log.rowCount).toBe(1);
  });

  it('does not return an expired one, and the purge removes it', async () => {
    const who = await signIn(h, 'agent');
    const reply = await ask(who, 'expiring', ['This will expire.', 'This will stay.']);
    const old = (await remember(who, reply.messageId, 0)).body;
    const fresh = (await remember(who, reply.messageId, 1)).body;
    await owner().query(
      `UPDATE assistant_memory SET expires_at = now() - interval '1 hour' WHERE id = $1`,
      [old.id],
    );
    const list = await who.client.get<AssistantMemoryList>('/v1/assistant/memory');
    expect(list.body.items.map((item) => item.id)).toEqual([fresh.id]);
    // An expired one does not count against the 20 either: the purge has not run yet and the person is not blocked.
    const purged = await purgeExpired(h.db.owner);
    expect(purged.assistant_memory).toBeGreaterThanOrEqual(1);
    expect(
      (await owner().query(`SELECT 1 FROM assistant_memory WHERE id = $1`, [old.id])).rowCount,
    ).toBe(0);
    expect(
      (await owner().query(`SELECT 1 FROM assistant_memory WHERE id = $1`, [fresh.id])).rowCount,
    ).toBe(1);
  });
});

describe('feedback', () => {
  it('rates my own answer, replaces an earlier rating, and takes a reason only with a thumbs-down', async () => {
    const who = await signIn(h, 'agent');
    const reply = await ask(who, 'rate me', ['Something to rate.']);
    const target = { kind: 'message', id: reply.messageId };
    const up = await who.client.post('/v1/assistant/feedback', { target, rating: 'up' });
    expect(up.status).toBe(200);
    expect(assistantFeedbackSchema.parse(up.body)).toMatchObject({ rating: 'up', reason: null });
    const down = await who.client.post('/v1/assistant/feedback', {
      target,
      rating: 'down',
      reason: 'misleading',
    });
    expect(assistantFeedbackSchema.parse(down.body)).toMatchObject({
      rating: 'down',
      reason: 'misleading',
    });
    const rows = await owner().query<{ rating: string; reason: string | null }>(
      `SELECT rating, reason FROM assistant_feedback WHERE user_id = $1 AND target_id = $2`,
      [who.userId, reply.messageId],
    );
    expect(rows.rows).toEqual([{ rating: 'down', reason: 'misleading' }]);

    expect(
      (await who.client.post('/v1/assistant/feedback', { target, rating: 'up', reason: 'other' }))
        .status,
    ).toBe(400);
    expect(
      (await who.client.post('/v1/assistant/feedback', { target, rating: 'down', reason: 'rude' }))
        .status,
    ).toBe(400);
    const log = await owner().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE action = 'assistant.feedback' AND actor_id = $1 AND outcome = 'success' ORDER BY created_at`,
      [who.userId],
    );
    expect(log.rows.map((row) => row.metadata.rating)).toEqual(['up', 'down']);
  });

  it('answers 404 for an answer that is not mine, the same as for one that does not exist', async () => {
    const mine = await signIn(h, 'agent');
    const reply = await ask(mine, 'private', ['Private answer.']);
    const stranger = await other.client.post<ApiErrorBody>('/v1/assistant/feedback', {
      target: { kind: 'message', id: reply.messageId },
      rating: 'down',
    });
    const missing = await other.client.post<ApiErrorBody>('/v1/assistant/feedback', {
      target: { kind: 'message', id: randomUUID() },
      rating: 'down',
    });
    expect(stranger.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(stranger.body.message).toBe(missing.body.message);
    expect(
      (await owner().query(`SELECT 1 FROM assistant_feedback WHERE user_id = $1`, [other.userId]))
        .rowCount,
    ).toBe(0);
  });

  describe('of an insight (C-18)', () => {
    const insight = async (element: string, scopeKey: string): Promise<string> => {
      // A fixture through the owner connection: the worker writes insights in production, a test seeds one row.
      const row = await owner().query<{ id: string }>(
        // eslint-disable-next-line watchtower/no-insight-writer -- test fixture, not a writer in the api
        `INSERT INTO ai_element_insight
           (element, scope_key, period, locale, facts, facts_fingerprint, claims, prompt_id, prompt_version, model,
            generated_at, expires_at)
         VALUES ($1, $2, '-', 'en', '[]'::jsonb, $3, '[]'::jsonb, 'element_insight', '1', 'm',
                 now(), now() + interval '1 hour')
         RETURNING id`,
        [element, scopeKey, randomUUID()],
      );
      return row.rows[0]?.id ?? '';
    };
    const rate = (who: Persona, id: string) =>
      who.client.post<ApiErrorBody>('/v1/assistant/feedback', {
        target: { kind: 'insight', id },
        rating: 'down',
        reason: 'judges_person',
      });

    it('accepts it from someone who passes the rule of the element, and not from one who does not', async () => {
      // `incidents.open` is served by a route that asks `ticket.read`: an agent has it, a developer (masked) does not.
      const id = await insight('incidents.open', 'instance');
      const ok = await rate(agent, id);
      expect(ok.status).toBe(200);
      expect(assistantFeedbackSchema.parse(ok.body)).toMatchObject({
        target: { kind: 'insight', id },
        reason: 'judges_person',
      });
      const row = await owner().query<{ element: string }>(
        `SELECT element FROM assistant_feedback WHERE user_id = $1 AND target_id = $2`,
        [agent.userId, id],
      );
      expect(row.rows[0]?.element).toBe('incidents.open');

      const denied = await rate(dev, id);
      const missing = await rate(dev, randomUUID());
      expect(denied.status).toBe(404);
      expect(missing.status).toBe(404);
      // The same answer whether it exists or not: nothing to learn about which insights there are.
      expect(denied.body).toEqual(missing.body);
      expect(
        (await owner().query(`SELECT 1 FROM assistant_feedback WHERE user_id = $1`, [dev.userId]))
          .rowCount,
      ).toBe(0);
    });

    it('checks the scope with the reader of its module, and fails closed on one it cannot read', async () => {
      const lead = await signIn(h, 'lead');
      const org = await apiOrg(lead, { name: `Feedback Org ${suffix}` });
      expect((await rate(agent, await insight('incidents.open', `org:${org.id}`))).status).toBe(
        200,
      );
      // An org that does not exist, a scope kind with no reader yet, and a scope nobody was shown: 404.
      expect(
        (await rate(agent, await insight('incidents.open', `org:${randomUUID()}`))).status,
      ).toBe(404);
      expect(
        (await rate(agent, await insight('incidents.open', `service:${randomUUID()}`))).status,
      ).toBe(404);
      expect((await rate(agent, await insight('incidents.open', 'user'))).status).toBe(404);
      // An element the registry does not know.
      expect((await rate(agent, await insight('no.such.element', 'instance'))).status).toBe(404);
    });
  });
});
