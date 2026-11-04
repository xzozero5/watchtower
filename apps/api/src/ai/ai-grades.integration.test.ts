import type { IntentGradeMetricsResponse } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { apiOrg, signIn, type Persona } from '../testing/ticketing.js';

// T-301: the read side of the grader on the real application (restricted role, real guards).
let h: Harness;
let lead: Persona;
let agent: Persona;
let client: Persona;
let orgId: string;

const pool = () => h.db.owner.pool;

beforeAll(async () => {
  h = await startHarness();
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  orgId = (await apiOrg(lead, { name: 'Grades Acme' })).id;
  client = await signIn(h, 'client', orgId);
  const intent = await pool().query<{ id: string }>(
    `INSERT INTO intent (key, name) VALUES ('grade_probe', 'Grade probe') RETURNING id`,
  );
  for (const [index, cls] of (
    ['verified', 'contained', 'assumed', 'verified'] as const
  ).entries()) {
    const ticket = await pool().query<{ id: string }>(
      `INSERT INTO ticket (org_id, subject, intent_id, status) VALUES ($1, 'Probe', $2, 'resolved') RETURNING id`,
      [orgId, intent.rows[0]?.id],
    );
    await pool().query(
      `INSERT INTO ai_resolution_grade (ticket_id, cycle, intent_key, resolution_class, draft_verdict, draft_quality, prompt_version, mock)
       VALUES ($1, 0, 'grade_probe', $2, $3, $4, 1, true)`,
      [ticket.rows[0]?.id, cls, index === 0 ? 'matches' : 'no_draft', index === 0 ? 0.8 : null],
    );
  }
});
afterAll(async () => {
  await h.close();
});

describe('GET /v1/ai/grades/metrics', () => {
  it('is closed to anonymous callers, clients and agents; open to a lead', async () => {
    const path = '/v1/ai/grades/metrics';
    expect((await h.client().get(path)).status).toBe(401);
    expect((await client.client.get(path)).status).toBe(403);
    expect((await agent.client.get(path)).status).toBe(403);
    expect((await lead.client.get(path)).status).toBe(200);
  });

  it('counts the classes of an intent and says it is a demo when the mock graded', async () => {
    const response = await lead.client.get<IntentGradeMetricsResponse>(
      '/v1/ai/grades/metrics?days=7',
    );
    expect(response.status).toBe(200);
    expect(response.body.windowDays).toBe(7);
    const probe = response.body.intents.find((row) => row.intentKey === 'grade_probe');
    expect(probe).toMatchObject({
      graded: 4,
      verified: 2,
      contained: 1,
      assumed: 1,
      verifiedRate: 0.5,
      draftsCompared: 1,
      mock: true,
    });
    expect(probe?.avgDraftQuality).toBeCloseTo(0.8);
  });

  it('refuses a window that is not a number of days', async () => {
    expect((await lead.client.get('/v1/ai/grades/metrics?days=0')).status).toBe(400);
    expect((await lead.client.get('/v1/ai/grades/metrics?days=abc')).status).toBe(400);
  });
});
