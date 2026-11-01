import type {
  AutonomyHistoryPage,
  AutonomyState,
  Intent,
  IntentAutonomyChange,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import {
  apiIntent,
  apiOrg,
  signIn,
  type ApiErrorBody,
  type Persona,
} from '../testing/ticketing.js';

// T-127: who flipped a switch (first name only, for every staff reader) and the per-intent
// autonomy history for lead and head.

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let client: Persona;
let intent: Intent;

beforeAll(async () => {
  h = await startHarness();
  head = await signIn(h, 'head', undefined, 'Mana Kittisak');
  lead = await signIn(h, 'lead', undefined, 'Pim Suwan');
  agent = await signIn(h, 'agent', undefined, 'Dao Nakorn');
  const org = await apiOrg(lead, { name: 'Autonomy history org' });
  client = await signIn(h, 'client', org.id);
  intent = await apiIntent(lead, { key: 'history_intent', name: 'History intent' });
});
afterAll(async () => {
  await h.close();
});

describe('changedByName on the AI switches', () => {
  it('is null for a switch nobody has flipped', async () => {
    const state = await agent.client.get<AutonomyState>('/v1/autonomy');
    expect(state.body.switches).toHaveLength(2);
    for (const row of state.body.switches) {
      expect(row.changedBy).toBeNull();
      expect(row.changedByName).toBeNull();
    }
  });

  it('shows the first name of whoever flipped it, to an agent who cannot list users', async () => {
    expect((await agent.client.get('/v1/users')).status).toBe(403);
    const flip = await head.client.post<{ switches: AutonomyState['switches'] }>(
      '/v1/autonomy/switches',
      { switch: 'ai_kill_switch', on: true, reason: 'provider outage' },
    );
    expect(flip.status).toBe(200);
    expect(flip.body.switches.find((row) => row.key === 'ai_kill_switch')?.changedByName).toBe(
      'Mana',
    );

    for (const who of [agent, lead, head]) {
      const state = await who.client.get<AutonomyState>('/v1/autonomy');
      const row = state.body.switches.find((candidate) => candidate.key === 'ai_kill_switch');
      expect(row).toMatchObject({ on: true, changedBy: head.userId, changedByName: 'Mana' });
      // First name only: not the surname, and never the address.
      expect(JSON.stringify(state.body)).not.toContain('Kittisak');
      expect(JSON.stringify(state.body)).not.toContain(head.email);
    }
    expect(
      (await agent.client.get<AutonomyState>('/v1/autonomy')).body.switches.find(
        (row) => row.key === 'ai_stage_cap_pinned',
      )?.changedByName,
    ).toBeNull();

    await head.client.post('/v1/autonomy/switches', {
      switch: 'ai_kill_switch',
      on: false,
      reason: 'provider is back',
    });
  });
});

describe('GET /v1/intents/:id/autonomy/history', () => {
  const change = (who: Persona, body: Record<string, unknown>) =>
    who.client.post<IntentAutonomyChange & ApiErrorBody>(`/v1/intents/${intent.id}/autonomy`, body);
  const history = (who: Persona, query = '') =>
    who.client.get<AutonomyHistoryPage & ApiErrorBody>(
      `/v1/intents/${intent.id}/autonomy/history${query}`,
    );

  it('is empty for an intent whose stage never changed', async () => {
    const response = await history(lead);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [], nextCursor: null });
  });

  it('lists stage and pin changes newest first with who, from, to and why', async () => {
    expect((await change(lead, { stage: 1, reason: 'eval regression on billing' })).status).toBe(
      200,
    );
    expect((await change(head, { pinned: true, reason: 'freeze until review' })).status).toBe(200);
    expect((await change(head, { pinned: false, reason: 'review done' })).status).toBe(200);
    expect((await change(lead, { stage: 0, reason: 'still noisy' })).status).toBe(200);

    for (const who of [lead, head]) {
      const response = await history(who);
      expect(response.status).toBe(200);
      expect(
        response.body.items.map((item) => [item.change, item.fromStage, item.toStage, item.pinned]),
      ).toEqual([
        ['stage', 1, 0, false],
        ['unpin', 1, 1, false],
        ['pin', 1, 1, true],
        ['stage', 2, 1, false],
      ]);
      expect(response.body.items[0]).toMatchObject({
        intentId: intent.id,
        reason: 'still noisy',
        changedBy: lead.userId,
        changedByName: 'Pim Suwan',
      });
      expect(response.body.items[1]?.changedByName).toBe('Mana Kittisak');
      expect(JSON.stringify(response.body)).not.toContain(lead.email);
    }
  });

  it('pages with a cursor without skipping or repeating', async () => {
    const first = await history(lead, '?limit=3');
    expect(first.body.items).toHaveLength(3);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await history(lead, `?limit=3&cursor=${first.body.nextCursor ?? ''}`);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.items, ...second.body.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(4);
    expect((await history(lead, '?cursor=nonsense')).status).toBe(400);
    expect((await history(lead, '?limit=0')).status).toBe(400);
  });

  it('is for lead and head: an agent and a client are refused, and nobody signed in gets 401', async () => {
    expect((await history(agent)).status).toBe(403);
    expect((await history(client)).status).toBe(403);
    expect((await h.client().get(`/v1/intents/${intent.id}/autonomy/history`)).status).toBe(401);
  });

  it('answers 404 for an intent that does not exist and 400 for a malformed id', async () => {
    expect(
      (await lead.client.get('/v1/intents/00000000-0000-4000-8000-000000000000/autonomy/history'))
        .status,
    ).toBe(404);
    expect((await lead.client.get('/v1/intents/not-an-id/autonomy/history')).status).toBe(400);
  });

  it('keeps the row, with a null name, when the account that made the change is gone', async () => {
    const gone = await signIn(h, 'lead', undefined, 'Temporary Lead');
    await gone.client.post(`/v1/intents/${intent.id}/autonomy`, {
      stage: 1,
      reason: 'one more change',
    });
    await h.db.owner.pool.query(`DELETE FROM users WHERE id = $1`, [gone.userId]);
    const response = await history(head, '?limit=1');
    expect(response.body.items[0]).toMatchObject({
      changedBy: gone.userId,
      changedByName: null,
      reason: 'one more change',
    });
  });
});
