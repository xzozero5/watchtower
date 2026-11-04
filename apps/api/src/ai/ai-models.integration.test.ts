import type { AiModelMapping } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { signIn, type Persona } from '../testing/ticketing.js';

// T-301c: GET /v1/ai/models, the read-only mapping of agent to model behind the Admin > AI card.

let h: Harness;
let lead: Persona;
let agent: Persona;
let client: Persona;

beforeAll(async () => {
  h = await startHarness();
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  const org = await lead.client.post<{ id: string }>('/v1/orgs', { name: 'Acme Models' });
  client = await signIn(h, 'client', org.body.id);
});
afterAll(async () => {
  await h.close();
});

describe('GET /v1/ai/models', () => {
  it('is for a lead or head: an agent and a client are refused, nobody anonymous', async () => {
    expect((await agent.client.get('/v1/ai/models')).status).toBe(403);
    expect((await client.client.get('/v1/ai/models')).status).toBe(403);
    expect((await h.client().get('/v1/ai/models')).status).toBe(401);
  });

  it('lists every configurable agent with its tier, model and source (mock provider)', async () => {
    const response = await lead.client.get<AiModelMapping>('/v1/ai/models');
    expect(response.status).toBe(200);
    expect(response.body.provider).toBe('mock');
    const names = response.body.agents.map((row) => row.agent);
    expect(names).toContain('grader');
    expect(names).toContain('drafter');
    expect(names).not.toContain('embedder');
    expect(response.body.agents.find((row) => row.agent === 'grader')).toMatchObject({
      tier: 'standard',
      model: 'mock-standard',
      source: 'default',
      priced: true,
    });
    // the mock gives the grader and the drafter different tiers, so they are different models
    expect(response.body.graderIndependent).toBe(true);
  });
});
