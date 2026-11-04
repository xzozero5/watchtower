import type { AiBudget } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { signIn, type Persona } from '../testing/ticketing.js';

// T-142: GET /v1/ai/budget, the numbers behind the budget card.

let h: Harness;
let lead: Persona;
let agent: Persona;
let client: Persona;

beforeAll(async () => {
  h = await startHarness();
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  const org = await lead.client.post<{ id: string }>('/v1/orgs', { name: 'Acme Budget' });
  client = await signIn(h, 'client', org.body.id);
});
afterAll(async () => {
  await h.close();
});

const insertRun = (provider: string, inputTokens: number, outputTokens: number, usd: number) =>
  h.db.owner.pool.query(
    `INSERT INTO ai_run (started_at, agent, provider, model, tier, prompt_id, prompt_version, prompt_hash, input_hmac, redaction, input_tokens, output_tokens, cost_usd, status)
     VALUES (now(), 'classifier', $1, 'm', 'light', 'classifier', 1, repeat('a', 64), repeat('b', 64), '{"total":0,"byKind":{}}', $2, $3, $4, 'ok')`,
    [provider, inputTokens, outputTokens, usd],
  );

describe('GET /v1/ai/budget', () => {
  it('is for a lead or head: an agent and a client are refused, nobody anonymous', async () => {
    expect((await agent.client.get('/v1/ai/budget')).status).toBe(403);
    expect((await client.client.get('/v1/ai/budget')).status).toBe(403);
    expect((await h.client().get('/v1/ai/budget')).status).toBe(401);
  });

  it('starts empty and ok, with the caps and the reset time', async () => {
    const response = await lead.client.get<AiBudget>('/v1/ai/budget');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      level: 'ok',
      cost: { spentUsd: 0, capUsd: 1 },
      tokens: { spent: 0, cap: 500_000 },
      assistant: { users: [] },
    });
    expect(new Date(response.body.resetsAt).getTime()).toBeGreaterThan(Date.now());
    expect(response.body.day).toBe(new Date().toISOString().slice(0, 10));
  });

  it('does not count the mock provider, alerts at 80% and stops at the cap', async () => {
    await insertRun('mock', 900_000, 0, 9);
    expect((await lead.client.get<AiBudget>('/v1/ai/budget')).body.level).toBe('ok');

    await insertRun('anthropic', 300_000, 100_000, 0.2);
    const alert = await lead.client.get<AiBudget>('/v1/ai/budget');
    expect(alert.body.level).toBe('alert');
    expect(alert.body.tokens.spent).toBe(400_000);

    await insertRun('anthropic', 50_000, 50_000, 0.9);
    const stop = await lead.client.get<AiBudget>('/v1/ai/budget');
    expect(stop.body.level).toBe('stop');
    expect(stop.body.cost.spentUsd).toBeCloseTo(1.1, 5);
  });

  it('needs ai.budget.read, not ai.autonomy.set (T-175a)', async () => {
    const pool = h.db.owner.pool;
    await pool.query(
      `DELETE FROM role_permissions WHERE role = 'lead' AND permission = 'ai.budget.read'`,
    );
    try {
      // Still holds ai.autonomy.set, but not the read permission: refused on both routes.
      expect((await lead.client.get('/v1/ai/budget')).status).toBe(403);
      expect((await lead.client.get('/v1/ai/models')).status).toBe(403);
    } finally {
      await pool.query(
        `INSERT INTO role_permissions (role, permission) VALUES ('lead', 'ai.budget.read')`,
      );
    }
    await pool.query(
      `DELETE FROM role_permissions WHERE role = 'lead' AND permission = 'ai.autonomy.set'`,
    );
    try {
      // The other way round: the read permission alone is enough.
      expect((await lead.client.get('/v1/ai/budget')).status).toBe(200);
      expect((await lead.client.get('/v1/ai/models')).status).toBe(200);
    } finally {
      await pool.query(
        `INSERT INTO role_permissions (role, permission) VALUES ('lead', 'ai.autonomy.set')`,
      );
    }
  });

  it('lists today’s assistant users, heaviest first, with the per-user cap', async () => {
    await h.db.owner.pool.query(
      `INSERT INTO assistant_usage (user_id, day, messages, input_tokens, output_tokens, cost_usd)
       VALUES ($1, current_date, 3, 1000, 500, 0.01), ($2, current_date, 9, 8000, 2000, NULL)`,
      [agent.session.user.id, lead.session.user.id],
    );
    const { body } = await lead.client.get<AiBudget>('/v1/ai/budget');
    expect(body.assistant.userDailyTokens).toBeGreaterThan(0);
    expect(body.assistant.users.map((user) => user.tokens)).toEqual([10_000, 1_500]);
    expect(body.assistant.users[0]).toMatchObject({ messages: 9, costUsd: null });
    // T-175a: a name and numbers only, no user id.
    for (const user of body.assistant.users) expect(Object.keys(user)).not.toContain('userId');
  });
});
