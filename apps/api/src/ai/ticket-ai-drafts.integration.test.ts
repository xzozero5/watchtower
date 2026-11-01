import { randomUUID } from 'node:crypto';

import {
  AI_REJECT_REASONS,
  AI_REQUEST_LIMITS,
  aiReportSchema,
  ticketAiInsightSchema,
  type CancelSendResult,
  type Message,
  type TicketAiInsight,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
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

// What a person does with an AI draft, and how they ask for one (T-108c, T-108d): the contract of
// GET /v1/tickets/:id/ai with a draft, a report and progress; approve (the ordinary reply with
// aiDraftId), edit (editedFromDraftId), reject with a reason code, undo, and the request route.
// The worker is not running: the rows the investigator would write are inserted by the test.
const net = disableNetConnect();

let h: Harness;
let lead: Persona;
let agent: Persona;
let client: Persona;
let orgId: string;
let gmailId: string;
let stageTwoIntent: string;
let stageOneIntent: string;
let stageZeroIntent: string;

const pool = () => h.db.owner.pool;

beforeAll(async () => {
  h = await startHarness();
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent', undefined, 'Agent One');
  orgId = (await apiOrg(lead, { name: 'Draft Org' })).id;
  client = await signIn(h, 'client', orgId, 'Client');
  const account = await pool().query<{ id: string }>(
    `INSERT INTO channel_account (type, name) VALUES ('gmail', 'Support mailbox') RETURNING id`,
  );
  gmailId = account.rows[0]?.id ?? '';
  const make = async (name: string, stage: number): Promise<string> => {
    const intent = await apiIntent(lead, {
      key: `drafts_${randomUUID().slice(0, 8).replace(/-/g, '')}`,
      name,
    });
    await pool().query(`UPDATE intent SET autonomy_stage = $2 WHERE id = $1`, [intent.id, stage]);
    return intent.id;
  };
  stageTwoIntent = await make('Stage two', 2);
  stageOneIntent = await make('Stage one', 1);
  stageZeroIntent = await make('Stage zero', 0);
});

afterAll(async () => {
  await h.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

async function ticketWith(
  intentId: string | null,
  channel: 'gmail' | 'portal' = 'gmail',
): Promise<string> {
  const ticket = await fileTicket(agent, orgId, intentId === null ? {} : { intentId });
  if (channel === 'gmail') {
    await pool().query(
      `UPDATE ticket SET channel = 'gmail', channel_account_id = $2 WHERE id = $1`,
      [ticket.id, gmailId],
    );
  }
  return ticket.id;
}

const EVIDENCE = [
  { id: 'ev-1', kind: 'kb', title: 'Webhook not received', snippet: 'Check the endpoint', confidence: 0.9 },
];

/** What the worker leaves after an investigation and a draft: a brief that points at a waiting draft. */
async function draftReady(
  ticketId: string,
  body = 'Hello. Please check the endpoint.',
  extra: Record<string, unknown> = {},
): Promise<string> {
  const draft = await pool().query<{ id: string }>(
    `INSERT INTO ai_draft (ticket_id, body_text, language, customer_language, citations, uncited_claims,
                           prompt_id, prompt_version, disclosure_level, disclosure_removed, needs_review)
     VALUES ($1, $2, 'en', 'en', $3, 1, 'drafter', 2, 'restricted', 2, $4) RETURNING id`,
    [ticketId, body, JSON.stringify([{ evidenceId: 'ev-1', sentence: 1, kind: 'kb' }]), extra.needsReview === true],
  );
  const id = draft.rows[0]?.id ?? '';
  await pool().query(
    `INSERT INTO ai_ticket_insight (ticket_id, state, stage, generated_at, draft_id, evidence, report,
                                    next_step_kind, next_step_label, summary)
     VALUES ($1, 'draft_ready', 2, now(), $2, $3, $4, 'approve_draft', 'Review the draft reply', 'Webhook not received')
     ON CONFLICT (ticket_id) DO UPDATE SET state = 'draft_ready', draft_id = $2, evidence = $3, report = $4`,
    [
      ticketId,
      id,
      JSON.stringify(EVIDENCE),
      JSON.stringify({
        findings: [{ text: 'The endpoint answers slowly', evidenceIds: ['ev-1'] }],
        likelyCause: null,
        confidence: 0.6,
        openQuestions: ['Since when?'],
        tools: [{ name: 'kb_search', status: 'ok', mock: false }],
        promptVersion: 'v1',
        scope: { intent: null, basis: 'none' },
      }),
    ],
  );
  return id;
}

const getInsight = (who: Persona, ticketId: string) =>
  who.client.get<TicketAiInsight>(`/v1/tickets/${ticketId}/ai`);
const reject = (who: Persona, ticketId: string, draftId: string, body: unknown) =>
  who.client.post<{ draftId?: string } & Partial<ApiErrorBody>>(
    `/v1/tickets/${ticketId}/ai/drafts/${draftId}/reject`,
    body,
  );
const reply = (who: Persona, ticketId: string, body: string, extra: Record<string, unknown> = {}) =>
  who.client.post<{ message: Message }>(`/v1/tickets/${ticketId}/replies`, { body, ...extra });

const draftRow = async (draftId: string) =>
  (await pool().query(`SELECT * FROM ai_draft WHERE id = $1`, [draftId])).rows[0] as Record<string, unknown>;

describe('GET /v1/tickets/:id/ai with a draft, a report and progress', () => {
  it('returns the draft, the report and the evidence in the contract', async () => {
    const ticketId = await ticketWith(stageTwoIntent);
    const draftId = await draftReady(ticketId);
    const response = await getInsight(agent, ticketId);
    expect(response.status).toBe(200);
    expect(ticketAiInsightSchema.parse(response.body)).toEqual(response.body);
    expect(response.body).toMatchObject({
      state: 'draft_ready',
      evidence: [{ id: 'ev-1', kind: 'kb' }],
      draft: {
        id: draftId,
        body: 'Hello. Please check the endpoint.',
        citations: ['ev-1'],
        uncitedClaims: 1,
        promptVersion: 'v2',
        language: 'en',
        disclosure: { level: 'restricted', removedSentences: 2 },
      },
      report: { confidence: 0.6, openQuestions: ['Since when?'] },
    });
    expect(aiReportSchema.safeParse(response.body.report).success).toBe(true);
    expect(response.body.draft?.needsReview).toBeUndefined();
    // The extra keys the worker keeps on a card do not leave the api.
    expect(JSON.stringify(response.body)).not.toContain('customerSafe');
  });

  it('shows progress only while the job runs', async () => {
    const ticketId = await ticketWith(stageTwoIntent);
    await pool().query(
      `INSERT INTO ai_ticket_insight (ticket_id, state, stage, generated_at, progress)
       VALUES ($1, 'investigating', 2, now(), '{"phase":"investigating","step":1,"steps":4}')`,
      [ticketId],
    );
    const running = await getInsight(agent, ticketId);
    expect(running.body).toMatchObject({
      state: 'investigating',
      progress: { phase: 'investigating', step: 1, steps: 4 },
    });
    await pool().query(`UPDATE ai_ticket_insight SET state = 'classified' WHERE ticket_id = $1`, [ticketId]);
    expect((await getInsight(agent, ticketId)).body.progress).toBeUndefined();
  });

  it('never gives a customer any of it', async () => {
    const ticketId = await ticketWith(stageTwoIntent);
    await draftReady(ticketId);
    const response = await client.client.get<ApiErrorBody>(`/v1/tickets/${ticketId}/ai`);
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain('Please check the endpoint');
  });
});

describe('approve, edit and undo (N3)', () => {
  it('approving is the reply with the draft: the person is the approver, the brief stops offering it, undo brings it back', async () => {
    const ticketId = await ticketWith(stageTwoIntent);
    const draftId = await draftReady(ticketId);
    const sent = await reply(agent, ticketId, 'Hello. Please check the endpoint.', {
      aiDraftId: draftId,
    });
    expect(sent.status).toBe(201);
    expect(await draftRow(draftId)).toMatchObject({
      status: 'approved',
      approved_by: agent.userId,
      disposition: 'approved',
      edit_distance: 0,
    });
    const after = await getInsight(agent, ticketId);
    expect(after.body.state).toBe('classified');
    expect(after.body.draft).toBeUndefined();
    // The suggestion to review the draft is stale once it went out.
    expect(after.body.nextStep).toMatchObject({ kind: 'wait_customer' });

    const deliveryId = sent.body.message.delivery?.id ?? '';
    const undone = await agent.client.post<CancelSendResult>(
      `/v1/tickets/${ticketId}/deliveries/${deliveryId}/cancel`,
      {},
    );
    expect(undone.status).toBe(200);
    expect(await draftRow(draftId)).toMatchObject({ status: 'draft', disposition: null, approved_by: null });
    const back = await getInsight(agent, ticketId);
    expect(back.body).toMatchObject({
      state: 'draft_ready',
      draft: { id: draftId },
      nextStep: { kind: 'approve_draft' },
    });
  });

  it('sending an edited version keeps the draft, the distance and an audit row, and sends as the person’s own text', async () => {
    const ticketId = await ticketWith(stageTwoIntent);
    const draftId = await draftReady(ticketId, 'we fixed the bug today');
    const sent = await reply(agent, ticketId, 'we fixed the issue today', {
      editedFromDraftId: draftId,
    });
    expect(sent.status).toBe(201);
    expect(sent.body.message.delivery).toMatchObject({ origin: 'human' });
    const row = await draftRow(draftId);
    expect(row).toMatchObject({
      status: 'sent',
      disposition: 'edited',
      approved_by: agent.userId,
      final_message_id: sent.body.message.id,
    });
    expect(row.edit_distance).toBeGreaterThan(0);
    expect(row.edit_distance).toBeLessThan(1);
    const audit = await pool().query(
      `SELECT metadata FROM audit_log WHERE action = 'ai.draft_edited' AND target_id = $1`,
      [ticketId],
    );
    expect(audit.rows).toHaveLength(1);
    expect((await getInsight(agent, ticketId)).body.draft).toBeUndefined();
    // The draft is used up: it cannot be edited again, sent as it was, or rejected.
    expect((await reply(agent, ticketId, 'again', { editedFromDraftId: draftId })).status).toBe(409);
    expect((await reject(agent, ticketId, draftId, { reason: 'tone_style' })).status).toBe(409);
  });

  it('refuses to name a draft twice, a draft of another ticket, and a customer naming one', async () => {
    const ticketId = await ticketWith(stageTwoIntent);
    const draftId = await draftReady(ticketId);
    const both = await reply(agent, ticketId, 'x', { aiDraftId: draftId, editedFromDraftId: draftId });
    expect(both.status).toBe(400);
    const other = await ticketWith(stageTwoIntent);
    const foreign = await draftReady(other, 'foreign');
    expect((await reply(agent, ticketId, 'y', { editedFromDraftId: foreign })).status).toBe(404);
    const mine = await client.client.post(`/v1/tickets/${ticketId}/replies`, {
      body: 'z',
      editedFromDraftId: draftId,
    });
    // Refused before it gets that far: a client has no right to review drafts.
    expect(mine.status).toBe(403);
  });
});

describe('POST /v1/tickets/:id/ai/drafts/:draftId/reject', () => {
  it('stores one of the nine reasons, and the brief goes back to the person', async () => {
    expect(AI_REJECT_REASONS).toHaveLength(new Set(AI_REJECT_REASONS).size);
    for (const reason of AI_REJECT_REASONS.filter((code) => code !== 'other')) {
      const ticketId = await ticketWith(stageTwoIntent, 'portal');
      const draftId = await draftReady(ticketId);
      const response = await reject(agent, ticketId, draftId, { reason });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ draftId });
      expect(await draftRow(draftId)).toMatchObject({
        status: 'rejected',
        disposition: 'rejected',
        reject_reason: reason,
        resolved_by: agent.userId,
      });
      const brief = await getInsight(agent, ticketId);
      expect(brief.body).toMatchObject({ state: 'needs_human', nextStep: { kind: 'reply' } });
      expect(brief.body.draft).toBeUndefined();
    }
  });

  it('needs a comment for "other", refuses an unknown reason, and is 409 the second time', async () => {
    const ticketId = await ticketWith(stageTwoIntent);
    const draftId = await draftReady(ticketId);
    expect((await reject(agent, ticketId, draftId, { reason: 'other' })).status).toBe(400);
    expect((await reject(agent, ticketId, draftId, { reason: 'because' })).status).toBe(400);
    expect((await reject(agent, ticketId, draftId, {})).status).toBe(400);
    const ok = await reject(agent, ticketId, draftId, { reason: 'other', comment: 'wrong customer' });
    expect(ok.status).toBe(200);
    expect(await draftRow(draftId)).toMatchObject({ reject_comment: 'wrong customer' });
    expect((await reject(agent, ticketId, draftId, { reason: 'other', comment: 'again' })).status).toBe(409);
  });

  it('is for staff with ai.draft.review, on a ticket they can see, with a draft of that ticket', async () => {
    const ticketId = await ticketWith(stageTwoIntent);
    const draftId = await draftReady(ticketId);
    expect((await reject(client, ticketId, draftId, { reason: 'tone_style' })).status).toBe(403);
    expect((await h.client().post(`/v1/tickets/${ticketId}/ai/drafts/${draftId}/reject`, { reason: 'tone_style' })).status).toBe(401);
    const other = await ticketWith(stageTwoIntent);
    expect((await reject(agent, other, draftId, { reason: 'tone_style' })).status).toBe(404);
    expect((await reject(agent, ticketId, randomUUID(), { reason: 'tone_style' })).status).toBe(404);
    expect((await reject(agent, ticketId, 'not-a-uuid', { reason: 'tone_style' })).status).toBe(400);
    expect((await draftRow(draftId)).status).toBe('draft');
    expect((await reject(lead, ticketId, draftId, { reason: 'tone_style' })).status).toBe(200);
    const audit = await pool().query(
      `SELECT actor_id, metadata FROM audit_log WHERE action = 'ai.draft_reject' AND target_id = $1`,
      [ticketId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_id: lead.userId });
  });
});

describe('who may use a draft, and how (SR108 P1/P2)', () => {
  it('a client cannot put an intent on the ticket it files: it would pick the stage and the tools', async () => {
    for (const field of [{ intentId: stageTwoIntent }, { intentKey: 'anything' }]) {
      const response = await client.client.post<ApiErrorBody>('/v1/tickets', {
        subject: 'Hello',
        body: 'A question',
        ...field,
      });
      expect(response.status).toBe(403);
    }
    const plain = await client.client.post('/v1/tickets', { subject: 'Hello', body: 'A question' });
    expect(plain.status).toBe(201);
  });

  it('approving or editing needs ai.draft.review, not only ticket.reply', async () => {
    const head = await signIn(h, 'head');
    const setAgent = async (change: (current: string[]) => string[]): Promise<void> => {
      const roles = await head.client.get<{ roles: { role: string; permissions: string[] }[] }>(
        '/v1/rbac/roles',
      );
      const current = roles.body.roles.find((entry) => entry.role === 'agent')?.permissions ?? [];
      const put = await head.client.put('/v1/rbac/roles/agent/permissions', {
        permissions: change(current),
      });
      expect(put.status).toBe(200);
    };
    const ticketId = await ticketWith(stageTwoIntent);
    const draftId = await draftReady(ticketId, 'Hello there');
    await setAgent((current) => current.filter((key) => key !== 'ai.draft.review'));
    try {
      expect((await reply(agent, ticketId, 'Hello there', { aiDraftId: draftId })).status).toBe(403);
      expect((await reply(agent, ticketId, 'Hello!', { editedFromDraftId: draftId })).status).toBe(403);
      expect((await reject(agent, ticketId, draftId, { reason: 'tone_style' })).status).toBe(403);
      // Their own words are still a reply.
      expect((await reply(agent, ticketId, 'My own words')).status).toBe(201);
      expect((await draftRow(draftId)).status).toBe('draft');
    } finally {
      await setAgent((current) => [...new Set([...current, 'ai.draft.review'])]);
    }
    expect((await reply(agent, ticketId, 'Hello there', { aiDraftId: draftId })).status).toBe(201);
  });

  it('"edited" with the draft’s own words is an approval and meets the gate', async () => {
    // Stage 0: nothing the AI wrote may be sent as an AI draft, and naming it "edited" does not change that.
    const zero = await ticketWith(stageZeroIntent);
    const stuck = await draftReady(zero, 'Same words');
    const refused = await reply(agent, zero, 'Same words', { editedFromDraftId: stuck });
    expect(refused.status).toBe(403);
    expect((await draftRow(stuck)).status).toBe('draft');

    // Stage 2: it goes as an approval, with no pretend edit of distance 0.
    const ok = await ticketWith(stageTwoIntent);
    const draftId = await draftReady(ok, 'Same words');
    const sent = await reply(agent, ok, 'Same words', { editedFromDraftId: draftId });
    expect(sent.status).toBe(201);
    expect(sent.body.message.delivery).toMatchObject({ origin: 'ai_approved' });
    expect(await draftRow(draftId)).toMatchObject({ disposition: 'approved', status: 'approved' });
  });

  it('an undone approval with a newer draft written meanwhile leaves one draft waiting', async () => {
    const ticketId = await ticketWith(stageTwoIntent);
    const first = await draftReady(ticketId, 'First draft');
    const sent = await reply(agent, ticketId, 'First draft', { aiDraftId: first });
    const second = await draftReady(ticketId, 'Second draft');
    const undone = await agent.client.post<CancelSendResult>(
      `/v1/tickets/${ticketId}/deliveries/${sent.body.message.delivery?.id ?? ''}/cancel`,
      {},
    );
    expect(undone.status).toBe(200);
    const rows = await pool().query<{ id: string; status: string }>(
      `SELECT id, status FROM ai_draft WHERE ticket_id = $1`,
      [ticketId],
    );
    expect(Object.fromEntries(rows.rows.map((row) => [row.id, row.status]))).toEqual({
      [first]: 'superseded',
      [second]: 'draft',
    });
    expect((await getInsight(agent, ticketId)).body.draft?.id).toBe(second);
  });
});

describe('POST /v1/tickets/:id/ai/requests', () => {
  const request = (who: Persona, ticketId: string, body: unknown) =>
    who.client.post<{ accepted?: boolean } & Partial<ApiErrorBody>>(
      `/v1/tickets/${ticketId}/ai/requests`,
      body,
    );
  const jobsFor = async (ticketId: string, name: string) =>
    (
      await pool().query<{ payload: { requestedBy: string; note?: string } }>(
        `SELECT payload FROM outbox WHERE queue = 'ai' AND job_name = $1 AND payload->>'ticketId' = $2`,
        [name, ticketId],
      )
    ).rows;

  it('queues a draft at once (202), shows the job as running, and refuses a second one while it runs', async () => {
    const ticketId = await ticketWith(stageOneIntent);
    const accepted = await request(agent, ticketId, { kind: 'draft', note: 'shorter please' });
    expect(accepted.status).toBe(202);
    expect(accepted.body).toEqual({ accepted: true });
    expect(await jobsFor(ticketId, 'draft')).toEqual([
      { payload: { ticketId, requestedBy: agent.userId, note: 'shorter please' } },
    ]);
    const brief = await getInsight(agent, ticketId);
    expect(brief.body).toMatchObject({ state: 'investigating', progress: { phase: 'queued' } });
    expect((await request(agent, ticketId, { kind: 'investigate' })).status).toBe(409);
    expect(await jobsFor(ticketId, 'investigate')).toEqual([]);
    const audit = await pool().query(
      `SELECT actor_id FROM audit_log WHERE action = 'ai.request' AND target_id = $1 AND outcome = 'success'`,
      [ticketId],
    );
    expect(audit.rows).toEqual([{ actor_id: agent.userId }]);
  });

  it('asks for a new investigation without needing an intent', async () => {
    const ticketId = await ticketWith(null);
    expect((await request(agent, ticketId, { kind: 'investigate' })).status).toBe(202);
    expect(await jobsFor(ticketId, 'investigate')).toHaveLength(1);
  });

  it('refuses a draft the gate would refuse to send: no intent, or stage 0', async () => {
    const bare = await ticketWith(null);
    expect((await request(agent, bare, { kind: 'draft' })).status).toBe(409);
    const zero = await ticketWith(stageZeroIntent);
    const refused = await request(agent, zero, { kind: 'draft' });
    expect(refused.status).toBe(409);
    expect(await jobsFor(zero, 'draft')).toEqual([]);
    expect((await getInsight(agent, zero)).status).toBe(404);
  });

  it('caps the requests for one ticket per hour, and for one person per hour', async () => {
    const ticketId = await ticketWith(stageOneIntent);
    for (let index = 0; index < AI_REQUEST_LIMITS.perTicketPerHour; index += 1) {
      // The brief is out of the working state between requests, as when each job has finished.
      await pool().query(`UPDATE ai_ticket_insight SET state = 'classified', progress = NULL WHERE ticket_id = $1`, [ticketId]);
      expect((await request(agent, ticketId, { kind: 'investigate' })).status).toBe(202);
    }
    await pool().query(`UPDATE ai_ticket_insight SET state = 'classified', progress = NULL WHERE ticket_id = $1`, [ticketId]);
    expect((await request(agent, ticketId, { kind: 'draft' })).status).toBe(409);

    // One person across tickets: the next one after the cap is 429.
    const person = await signIn(h, 'agent', undefined, 'Busy Agent');
    let last = 0;
    for (let index = 0; index <= AI_REQUEST_LIMITS.perUserPerHour; index += 1) {
      last = (await request(person, await ticketWith(null), { kind: 'investigate' })).status;
    }
    expect(last).toBe(429);
  });

  it('is for staff who handle tickets, validates the body, and hides a ticket the person cannot see', async () => {
    const ticketId = await ticketWith(stageOneIntent);
    expect((await request(client, ticketId, { kind: 'draft' })).status).toBe(403);
    expect((await h.client().post(`/v1/tickets/${ticketId}/ai/requests`, { kind: 'draft' })).status).toBe(401);
    expect((await request(agent, ticketId, { kind: 'delete' })).status).toBe(400);
    expect((await request(agent, ticketId, { kind: 'draft', note: 'x'.repeat(501) })).status).toBe(400);
    expect((await request(agent, 'OPS-999999999', { kind: 'draft' })).status).toBe(404);
  });
});
