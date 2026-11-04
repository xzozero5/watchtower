import { randomUUID } from 'node:crypto';

import type {
  GoldenAnswer,
  GoldenAnswerList,
  GoldenPreview,
  TicketGradeResponse,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import {
  apiIntent,
  apiOrg,
  fileTicket,
  signIn,
  type ApiErrorBody,
  type Persona,
} from '../testing/ticketing.js';

// T-302a (golden answers) and T-301d (the grade of one ticket) on the real application: roles, redaction,
// soft delete, the audit row, and what a developer and a client may read.
let h: Harness;
let lead: Persona;
let agent: Persona;
let dev: Persona;
let client: Persona;
let orgId: string;
let intentId: string;
let intentKey: string;
let ticketId: string;
let ticketKey: string;
let sentId: string;
let internalId: string;
let inboundId: string;
let requesterEmail: string;

const pool = () => h.db.owner.pool;

async function message(
  direction: 'inbound' | 'outbound' | 'internal',
  text: string,
  delivery = 'delivered',
): Promise<string> {
  const row = await pool().query<{ id: string }>(
    `INSERT INTO message (ticket_id, direction, visibility, body_text, delivery_status)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [ticketId, direction, direction === 'internal' ? 'internal' : 'public', text, delivery],
  );
  return row.rows[0]?.id ?? '';
}

beforeAll(async () => {
  h = await startHarness();
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  dev = await signIn(h, 'dev');
  orgId = (await apiOrg(lead, { name: 'Golden Org' })).id;
  client = await signIn(h, 'client', orgId);
  intentKey = `golden_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
  intentId = (await apiIntent(lead, { key: intentKey, name: 'Golden probe' })).id;
  requesterEmail = `somsri.${randomUUID().slice(0, 6)}@customer.example`;
  const ticket = await fileTicket(lead, orgId, {
    requester: { email: requesterEmail, name: 'Somsri Jaidee' },
  });
  ticketId = ticket.id;
  ticketKey = ticket.key;
  await pool().query(`UPDATE ticket SET intent_id = $2 WHERE id = $1`, [ticketId, intentId]);
  inboundId = await message('inbound', 'Please help me sign in.');
  sentId = await message(
    'outbound',
    `Hello Somsri Jaidee, we reset your password. Write to ${requesterEmail} if it fails again.`,
  );
  internalId = await message('internal', 'Internal note');
});

afterAll(async () => {
  await h.close();
});

describe('POST /v1/tickets/:id/golden', () => {
  it('is for lead and head only', async () => {
    const path = `/v1/tickets/${ticketKey}/golden`;
    expect((await h.client().post(path, { messageId: sentId })).status).toBe(401);
    expect((await client.client.post(path, { messageId: sentId })).status).toBe(403);
    expect((await agent.client.post(path, { messageId: sentId })).status).toBe(403);
    expect((await dev.client.post(path, { messageId: sentId })).status).toBe(403);
  });

  it('refuses a message that was not sent to the customer', async () => {
    const path = `/v1/tickets/${ticketKey}/golden`;
    expect((await lead.client.post(path, { messageId: inboundId })).status).toBe(400);
    expect((await lead.client.post(path, { messageId: internalId })).status).toBe(400);
    const failed = await message('outbound', 'This never left', 'failed');
    expect((await lead.client.post(path, { messageId: failed })).status).toBe(400);
    expect((await lead.client.post(path, { messageId: randomUUID() })).status).toBe(404);
  });

  it('keeps the reply redacted, never the original, and writes an audit row', async () => {
    const response = await lead.client.post<GoldenAnswer>(`/v1/tickets/${ticketKey}/golden`, {
      messageId: sentId,
    });
    expect(response.status).toBe(201);
    expect(response.body.intent.key).toBe(intentKey);
    expect(response.body.text).not.toContain(requesterEmail);
    expect(response.body.text).not.toContain('Somsri');
    expect(response.body.text).toMatch(/\[EMAIL_\d+\]/);
    const stored = await pool().query<{ body_redacted: string; created_by: string }>(
      `SELECT body_redacted, created_by FROM golden_answer WHERE id = $1`,
      [response.body.id],
    );
    expect(stored.rows[0]?.body_redacted).not.toContain(requesterEmail);
    expect(stored.rows[0]?.created_by).toBe(lead.userId);
    const audit = await pool().query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'ai.golden_mark' AND target_id = $1`,
      [ticketId],
    );
    expect(Number(audit.rows[0]?.n)).toBeGreaterThanOrEqual(1);
  });

  it('says 409 when the reply is already marked', async () => {
    const again = await lead.client.post<ApiErrorBody>(`/v1/tickets/${ticketKey}/golden`, {
      messageId: sentId,
    });
    expect(again.status).toBe(409);
  });

  it("takes the organization's name, contract numbers and amounts out too, and keeps the shareable tick (C-8)", async () => {
    const reply = await pool().query<{ id: string }>(
      `INSERT INTO message (ticket_id, direction, visibility, body_text, delivery_status)
       VALUES ($1, 'outbound', 'public', $2, 'delivered') RETURNING id`,
      [
        ticketId,
        'Dear Golden Org, under contract no. CT-2024-0091 the refund of 12,500 baht is approved.',
      ],
    );
    const marked = await lead.client.post<GoldenAnswer>(`/v1/tickets/${ticketKey}/golden`, {
      messageId: reply.rows[0]?.id,
      shareable: true,
    });
    expect(marked.status).toBe(201);
    expect(marked.body.text).not.toMatch(/Golden Org|CT-2024|0091|12,500/);
    expect(marked.body.text).toContain('[CONTRACT_ID]');
    expect(marked.body.text).toContain('[AMOUNT]');
    expect(marked.body.shareable).toBe(true);
    const stored = await pool().query<{ shareable: boolean }>(
      `SELECT shareable FROM golden_answer WHERE id = $1`,
      [marked.body.id],
    );
    expect(stored.rows[0]?.shareable).toBe(true);
    // The first one, marked without the tick, stays private to its organization.
    const plain = await pool().query<{ shareable: boolean }>(
      `SELECT shareable FROM golden_answer WHERE message_id = $1`,
      [sentId],
    );
    expect(plain.rows[0]?.shareable).toBe(false);
    // Taken away again: the list tests below count the golden answers of this ticket.
    await pool().query(
      `UPDATE golden_answer SET deleted_at = now(), deleted_by = $2 WHERE id = $1`,
      [marked.body.id, lead.userId],
    );
  });

  it('says 409 for a ticket with no intent', async () => {
    const bare = await fileTicket(lead, orgId);
    const reply = await pool().query<{ id: string }>(
      `INSERT INTO message (ticket_id, direction, visibility, body_text, delivery_status)
       VALUES ($1, 'outbound', 'public', 'Hello', 'delivered') RETURNING id`,
      [bare.id],
    );
    const response = await lead.client.post(`/v1/tickets/${bare.key}/golden`, {
      messageId: reply.rows[0]?.id,
    });
    expect(response.status).toBe(409);
  });
});

describe('GET /v1/tickets/:id/golden/preview', () => {
  it('is for lead and head only', async () => {
    const path = `/v1/tickets/${ticketKey}/golden/preview?messageId=${sentId}`;
    expect((await h.client().get(path)).status).toBe(401);
    expect((await client.client.get(path)).status).toBe(403);
    expect((await agent.client.get(path)).status).toBe(403);
    expect((await dev.client.get(path)).status).toBe(403);
    expect((await lead.client.get(path)).status).toBe(200);
  });

  it('shows the scrubbed text of a reply, stores nothing and writes no mark audit row', async () => {
    const reply = await pool().query<{ id: string }>(
      `INSERT INTO message (ticket_id, direction, visibility, body_text, delivery_status)
       VALUES ($1, 'outbound', 'public', $2, 'delivered') RETURNING id`,
      [
        ticketId,
        'Dear Golden Org, under contract no. CT-2024-0091 the refund of 12,500 baht is approved.',
      ],
    );
    const messageId = reply.rows[0]?.id ?? '';
    const before = await pool().query<{ n: string }>(`SELECT count(*) AS n FROM golden_answer`);
    const response = await lead.client.get<GoldenPreview>(
      `/v1/tickets/${ticketKey}/golden/preview?messageId=${messageId}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.messageId).toBe(messageId);
    expect(response.body.text).not.toMatch(/Golden Org|CT-2024|0091|12,500/);
    expect(response.body.text).toContain('[CONTRACT_ID]');
    expect(response.body.text).toContain('[AMOUNT]');
    const after = await pool().query<{ n: string }>(`SELECT count(*) AS n FROM golden_answer`);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('keeps PII redaction and refuses what mark would refuse', async () => {
    const base = `/v1/tickets/${ticketKey}/golden/preview?messageId=`;
    const redacted = await lead.client.get<GoldenPreview>(`${base}${sentId}`);
    expect(redacted.body.text).not.toContain(requesterEmail);
    expect(redacted.body.text).toMatch(/\[EMAIL_\d+\]/);
    expect((await lead.client.get(`${base}${inboundId}`)).status).toBe(400);
    expect((await lead.client.get(`${base}${internalId}`)).status).toBe(400);
    expect((await lead.client.get(`${base}${randomUUID()}`)).status).toBe(404);
    expect((await lead.client.get(`/v1/tickets/${ticketKey}/golden/preview`)).status).toBe(400);
  });
});

describe('golden answers: list and remove', () => {
  it('lists them for a lead, filtered by intent, and shows the mark on the ticket', async () => {
    const all = await lead.client.get<GoldenAnswerList>(`/v1/ai/golden?intent=${intentKey}`);
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(1);
    expect(all.body.items[0]?.ticketKey).toBe(ticketKey);
    expect(all.body.items[0]?.shareable).toBe(false);
    const none = await lead.client.get<GoldenAnswerList>('/v1/ai/golden?intent=nothing_here');
    expect(none.body.items).toEqual([]);
    const ofTicket = await lead.client.get<GoldenAnswerList>(`/v1/tickets/${ticketKey}/golden`);
    expect(ofTicket.body.items.map((item) => item.messageId)).toEqual([sentId]);
    expect(ofTicket.body.items[0]?.shareable).toBe(false);
    expect((await agent.client.get('/v1/ai/golden')).status).toBe(403);
    expect((await client.client.get('/v1/ai/golden')).status).toBe(403);
  });

  it('soft deletes: the row stays, the list drops it, and the reply can be marked again', async () => {
    const listed = await lead.client.get<GoldenAnswerList>(`/v1/ai/golden?intent=${intentKey}`);
    const id = listed.body.items[0]?.id ?? '';
    expect((await agent.client.delete(`/v1/ai/golden/${id}`)).status).toBe(403);
    expect((await lead.client.delete(`/v1/ai/golden/${id}`)).status).toBe(200);
    expect((await lead.client.delete(`/v1/ai/golden/${id}`)).status).toBe(404);
    const row = await pool().query<{ deleted_by: string | null }>(
      `SELECT deleted_by FROM golden_answer WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]?.deleted_by).toBe(lead.userId);
    const after = await lead.client.get<GoldenAnswerList>(`/v1/ai/golden?intent=${intentKey}`);
    expect(after.body.items).toEqual([]);
    const again = await lead.client.post(`/v1/tickets/${ticketKey}/golden`, { messageId: sentId });
    expect(again.status).toBe(201);
  });
});

describe('GET /v1/tickets/:id/ai/grade', () => {
  it('is null until the grader has looked, then the verdict as claims', async () => {
    const path = `/v1/tickets/${ticketKey}/ai/grade`;
    const empty = await lead.client.get<TicketGradeResponse>(path);
    expect(empty.status).toBe(200);
    expect(empty.body.grade).toBeNull();

    const claim = {
      text: `Customer ${requesterEmail} confirmed it works`,
      evidence: [{ kind: 'ticket', label: ticketKey, href: `/?ticket=${ticketKey}` }],
      uncited: false,
    };
    await pool().query(
      `INSERT INTO ai_resolution_grade (ticket_id, cycle, intent_key, resolution_class, draft_verdict, draft_quality,
                                        policy_violations, violation_count, kb_gap, reasoning, prompt_version, mock)
       VALUES ($1, 0, $2, 'verified', 'partial', 0.6, $3::jsonb, 1, true, $4::jsonb, 1, true)`,
      [
        ticketId,
        intentKey,
        JSON.stringify([
          { code: 'promise', text: 'Promised a date', evidence: [], uncited: true },
          { code: 'not_a_code', text: 'dropped', evidence: [], uncited: true },
        ]),
        JSON.stringify([claim, { broken: true }]),
      ],
    );
    const graded = await lead.client.get<TicketGradeResponse>(path);
    expect(graded.status).toBe(200);
    expect(graded.body.grade).toMatchObject({
      resolutionClass: 'verified',
      draftVerdict: 'partial',
      draftQuality: 0.6,
      kbGap: true,
      mock: true,
      intentKey,
    });
    expect(graded.body.grade?.reasons).toHaveLength(1);
    expect(graded.body.grade?.reasons[0]?.evidence[0]?.href).toBe(`/?ticket=${ticketKey}`);
    expect(graded.body.grade?.violations).toHaveLength(1);
    expect(graded.body.grade?.violations[0]).toMatchObject({ code: 'promise', uncited: true });
  });

  it('is redacted for a developer, and closed to a client and anonymous callers', async () => {
    const path = `/v1/tickets/${ticketKey}/ai/grade`;
    const masked = await dev.client.get<TicketGradeResponse>(path);
    expect(masked.status).toBe(200);
    expect(JSON.stringify(masked.body)).not.toContain(requesterEmail);
    expect(masked.body.grade?.reasons[0]?.text).toMatch(/\[EMAIL_\d+\]/);
    expect((await client.client.get(path)).status).toBe(403);
    expect((await h.client().get(path)).status).toBe(401);
    expect((await agent.client.get(path)).status).toBe(200);
  });
});
