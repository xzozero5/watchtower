import {
  ticketAiInsightSchema,
  type ClientTicket,
  type TicketAiInsight,
  type TicketDetail,
  type TicketSummary,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import {
  apiOrg,
  fileClientTicket,
  fileTicket,
  signIn,
  type ApiErrorBody,
  type Page,
  type Persona,
} from '../testing/ticketing.js';

// GET /v1/tickets/:id/ai and the `ai` field of a list row (T-106e): staff only, 404 when the AI has
// made no brief, and never a word of it to a customer.

let h: Harness;
let agent: Persona;
let lead: Persona;
let client: Persona;
let otherClient: Persona;
let orgId: string;
let withInsight: TicketDetail;
let withoutInsight: TicketDetail;
let needsHuman: TicketDetail;

const pool = () => h.db.owner.pool;

async function insight(ticketId: string, fields: Record<string, unknown>): Promise<void> {
  const columns = { state: 'classified', stage: 2, generated_at: new Date(), ...fields };
  const names = Object.keys(columns);
  await pool().query(
    `INSERT INTO ai_ticket_insight (ticket_id, ${names.join(', ')})
     VALUES ($1, ${names.map((_, index) => `$${String(index + 2)}`).join(', ')})`,
    [ticketId, ...Object.values(columns)],
  );
}

beforeAll(async () => {
  h = await startHarness();
  agent = await signIn(h, 'agent');
  lead = await signIn(h, 'lead');
  orgId = (await apiOrg(lead, { name: 'AI Org' })).id;
  const otherOrg = (await apiOrg(lead, { name: 'Other AI Org' })).id;
  client = await signIn(h, 'client', orgId, 'Client');
  otherClient = await signIn(h, 'client', otherOrg, 'Other Client');

  withInsight = await fileTicket(agent, orgId, { subject: 'Cannot login' });
  withoutInsight = await fileTicket(agent, orgId, { subject: 'No AI yet' });
  needsHuman = await fileTicket(agent, orgId, { subject: 'Kill switch case' });
  await insight(withInsight.id, {
    summary: 'Customer cannot sign in after a password reset',
    intent_key: 'access_issue',
    intent_confidence: 0.82,
    intent_reason: 'Mentions password and sign in',
    next_step_kind: 'reply',
    next_step_label: 'Reply to the customer',
  });
  await insight(needsHuman.id, {
    state: 'needs_human',
    reason_code: 'kill_switch_on',
    next_step_kind: 'other',
    next_step_label: 'AI is switched off. Read the ticket.',
  });
});

afterAll(async () => {
  await h.close();
});

describe('GET /v1/tickets/:id/ai', () => {
  it('returns the TicketAiInsight contract for staff, by id and by ticket key', async () => {
    for (const ref of [withInsight.id, withInsight.key]) {
      const response = await agent.client.get<TicketAiInsight>(`/v1/tickets/${ref}/ai`);
      expect(response.status).toBe(200);
      expect(ticketAiInsightSchema.parse(response.body)).toEqual(response.body);
      expect(response.body).toMatchObject({
        state: 'classified',
        summary: 'Customer cannot sign in after a password reset',
        intent: { key: 'access_issue', confidence: 0.82, reason: 'Mentions password and sign in' },
        nextStep: { kind: 'reply', label: 'Reply to the customer' },
        evidence: [],
        stage: 2,
      });
      expect(response.body.draft).toBeUndefined();
    }
  });

  it('says why in nextStep.label when a person is needed, with no summary and no invented intent', async () => {
    const response = await agent.client.get<TicketAiInsight>(`/v1/tickets/${needsHuman.id}/ai`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      state: 'needs_human',
      nextStep: { kind: 'other', label: 'AI is switched off. Read the ticket.' },
      evidence: [],
    });
    expect(response.body.summary).toBeUndefined();
    expect(response.body.intent).toBeUndefined();
  });

  it('answers 404 when the AI has made no brief, and for a ticket that does not exist', async () => {
    const none = await agent.client.get<ApiErrorBody>(`/v1/tickets/${withoutInsight.id}/ai`);
    expect(none.status).toBe(404);
    const missing = await agent.client.get<ApiErrorBody>('/v1/tickets/OPS-999999999/ai');
    expect(missing.status).toBe(404);
  });

  it('is refused to a customer, of the same organization or not, whether a brief exists or not (403)', async () => {
    for (const who of [client, otherClient]) {
      for (const ticket of [withInsight, withoutInsight]) {
        const response = await who.client.get<ApiErrorBody>(`/v1/tickets/${ticket.id}/ai`);
        expect(response.status).toBe(403);
        expect(JSON.stringify(response.body)).not.toContain('Customer cannot sign in');
      }
    }
  });

  it('needs a signed-in session', async () => {
    const response = await h.client().get(`/v1/tickets/${withInsight.id}/ai`);
    expect(response.status).toBe(401);
  });

  it('puts the read on the audit log with the ticket as target', async () => {
    await agent.client.get(`/v1/tickets/${withInsight.id}/ai`);
    const { rows } = await pool().query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log
        WHERE action = 'pii.read' AND target_id = $1 AND actor_id = $2`,
      [withInsight.id, agent.userId],
    );
    expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(1);
  });
});

describe('the ai field of a ticket list row', () => {
  it('carries state and summary for staff, and state none where the AI has made nothing', async () => {
    const list = await agent.client.get<Page<TicketSummary>>('/v1/tickets?limit=50');
    expect(list.status).toBe(200);
    const byId = new Map(list.body.items.map((item) => [item.id, item]));
    expect(byId.get(withInsight.id)?.ai).toEqual({
      state: 'classified',
      summary: 'Customer cannot sign in after a password reset',
    });
    expect(byId.get(needsHuman.id)?.ai).toEqual({ state: 'needs_human' });
    expect(byId.get(withoutInsight.id)?.ai).toEqual({ state: 'none' });
    // One row per ticket: the join did not multiply anything.
    expect(new Set(list.body.items.map((item) => item.id)).size).toBe(list.body.items.length);
  });

  it('is on the ticket detail for staff', async () => {
    const detail = await agent.client.get<TicketDetail>(`/v1/tickets/${withInsight.id}`);
    expect(detail.body.ai).toMatchObject({ state: 'classified' });
  });

  it('never reaches a customer: not in the list, the detail, or a ticket they file', async () => {
    const list = await client.client.get<Page<ClientTicket>>('/v1/tickets');
    const detail = await client.client.get<ClientTicket>(`/v1/tickets/${withInsight.id}`);
    const filed = await fileClientTicket(client);
    const text = JSON.stringify([list.body, detail.body, filed]);
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(text).not.toContain('"ai"');
    expect(text).not.toContain('Customer cannot sign in');
    expect(text).not.toContain('access_issue');
    expect(text).not.toContain('needs_human');
  });

  it('keeps a filed ticket in step: a new ticket has a queued AI job and no insight yet', async () => {
    const ticket = await fileTicket(agent, orgId, { subject: 'Fresh' });
    const jobs = await pool().query<{ queue: string; job_name: string }>(
      `SELECT queue, job_name FROM outbox WHERE job_id = $1`,
      [`ai-summarize-${ticket.id}`],
    );
    expect(jobs.rows).toEqual([{ queue: 'ai', job_name: 'summarize' }]);
    expect((await agent.client.get(`/v1/tickets/${ticket.id}/ai`)).status).toBe(404);
  });
});
