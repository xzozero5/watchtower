import type {
  Intent,
  ProcedureProposalApplied,
  ProcedureProposalList,
  ProcedureVersion,
  TeamQueue,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import {
  apiIntent,
  apiQueue,
  fileTicket,
  signIn,
  type ApiErrorBody,
  type Persona,
} from '../testing/ticketing.js';

// T-303f: the escalation cards of a ticket over HTTP: who may read and press, what a press does, that a second
// press does nothing, and when a card has expired.

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let dev: Persona;
let client: Persona;
let orgId: string;
let counter = 0;

const owner = () => h.db.owner.pool;

beforeAll(async () => {
  h = await startHarness();
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  dev = await signIn(h, 'dev');
  const org = await lead.client.post<{ id: string }>('/v1/orgs', { name: 'Acme Escalation' });
  orgId = org.body.id;
  client = await signIn(h, 'client', orgId);
});
afterAll(async () => {
  await h.close();
});

const STEPS = {
  schemaVersion: 1,
  autosend: 'never',
  steps: [{ kind: 'tool', id: 'kb', tool: 'kb_search' }],
};

/** A published procedure for a new intent, and an open ticket of that intent holding one card. */
async function cardOn(to: Record<string, string>, priority?: string) {
  counter += 1;
  const intent: Intent = await apiIntent(lead, {
    key: `esc_${String(counter)}`,
    name: `Escalation ${String(counter)}`,
  });
  const base = `/v1/intents/${intent.id}/procedure/versions`;
  const draft = await lead.client.post<ProcedureVersion>(base, { sourceMd: 'x', steps: STEPS });
  await lead.client.post(`${base}/${draft.body.id}/confirm`);
  await owner().query(
    `INSERT INTO procedure_simulation (procedure_version_id, passed, case_count) VALUES ($1, true, 4)`,
    [draft.body.id],
  );
  expect((await head.client.post(`${base}/${draft.body.id}/publish`)).status).toBe(200);
  const ticket = await fileTicket(agent, orgId);
  await owner().query(`UPDATE ticket SET intent_id = $2, assignee_id = $3 WHERE id = $1`, [
    ticket.id,
    intent.id,
    agent.userId,
  ]);
  await owner().query(
    `INSERT INTO ticket_event (ticket_id, type, actor_type, visibility, payload)
     VALUES ($1, 'procedure.escalation_proposed', 'ai', 'internal', $2::jsonb)`,
    [
      ticket.id,
      JSON.stringify({
        versionId: draft.body.id,
        stepId: 'e1',
        to,
        ...(priority === undefined ? {} : { priority }),
        note: 'Please look.',
      }),
    ],
  );
  const list = await agent.client.get<ProcedureProposalList>(
    `/v1/tickets/${ticket.id}/procedure-proposals`,
  );
  const card = list.body.items[0];
  if (card === undefined) throw new Error('no card');
  return { intent, ticket, card, versionId: draft.body.id, base };
}

const applyPath = (ticketId: string, proposalId: string) =>
  `/v1/tickets/${ticketId}/procedure-proposals/${proposalId}/apply`;

describe('reading the cards', () => {
  it('lists them for staff (ticket.read), not for a developer or a client', async () => {
    const { ticket, card } = await cardOn({ role: 'lead' });
    expect(card).toMatchObject({ status: 'pending', stepId: 'e1', note: 'Please look.' });
    for (const who of [lead, head, agent]) {
      const response = await who.client.get<ProcedureProposalList>(
        `/v1/tickets/${ticket.id}/procedure-proposals`,
      );
      expect(response.status).toBe(200);
      expect(response.body.items).toHaveLength(1);
    }
    expect((await dev.client.get(`/v1/tickets/${ticket.id}/procedure-proposals`)).status).toBe(403);
    expect((await client.client.get(`/v1/tickets/${ticket.id}/procedure-proposals`)).status).toBe(
      403,
    );
    expect((await h.client().get(`/v1/tickets/${ticket.id}/procedure-proposals`)).status).toBe(401);
  });
});

describe('pressing a card', () => {
  it('needs ticket.handle: a developer and a client are refused, nothing changes', async () => {
    const { ticket, card } = await cardOn({ role: 'lead' });
    expect((await dev.client.post(applyPath(ticket.id, card.id))).status).toBe(403);
    expect((await client.client.post(applyPath(ticket.id, card.id))).status).toBe(403);
    expect((await h.client().post(applyPath(ticket.id, card.id))).status).toBe(401);
    const list = await agent.client.get<ProcedureProposalList>(
      `/v1/tickets/${ticket.id}/procedure-proposals`,
    );
    expect(list.body.items[0]?.status).toBe('pending');
  });

  it('a queue target moves the ticket, keeps the assignee, sets the priority, audits via=procedure, and is idempotent', async () => {
    const queue: TeamQueue = await apiQueue(lead, {
      name: `Escalation queue ${String(++counter)}`,
    });
    const { ticket, card } = await cardOn({ queueKey: queue.name }, 'P2');
    const first = await agent.client.post<ProcedureProposalApplied>(applyPath(ticket.id, card.id));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      alreadyApplied: false,
      action: 'moved_queue',
      priority: 'P2',
    });
    const row = await owner().query<{ queue_id: string; assignee_id: string; priority: string }>(
      `SELECT queue_id, assignee_id, priority FROM ticket WHERE id = $1`,
      [ticket.id],
    );
    expect(row.rows[0]).toEqual({ queue_id: queue.id, assignee_id: agent.userId, priority: 'P2' });

    const second = await agent.client.post<ProcedureProposalApplied>(applyPath(ticket.id, card.id));
    expect(second.status).toBe(200);
    expect(second.body.alreadyApplied).toBe(true);

    const audit = await owner().query<{ actor_id: string; metadata: { via: string } }>(
      `SELECT actor_id, metadata FROM audit_log WHERE action = 'procedure.escalation_applied' AND target_id = $1`,
      [ticket.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_id: agent.userId, metadata: { via: 'procedure' } });
    const list = await agent.client.get<ProcedureProposalList>(
      `/v1/tickets/${ticket.id}/procedure-proposals`,
    );
    expect(list.body.items[0]?.status).toBe('applied');
  });

  it('a role target tells that role and leaves an internal note, without assigning', async () => {
    const { ticket, card } = await cardOn({ role: 'head' });
    const response = await agent.client.post<ProcedureProposalApplied>(
      applyPath(ticket.id, card.id),
    );
    expect(response.body).toMatchObject({ action: 'asked_role' });
    expect(response.body.notified).toBeGreaterThanOrEqual(1);
    const notes = await owner().query<{ kind: string; severity: string; user_id: string }>(
      `SELECT kind, severity, user_id FROM notification WHERE ticket_id = $1`,
      [ticket.id],
    );
    expect(
      notes.rows.every((n) => n.kind === 'ticket.escalation_requested' && n.severity === 'high'),
    ).toBe(true);
    expect(notes.rows.map((n) => n.user_id)).toContain(head.userId);
    const messages = await owner().query<{ direction: string }>(
      `SELECT direction FROM message WHERE ticket_id = $1 AND direction = 'internal'`,
      [ticket.id],
    );
    expect(messages.rows).toHaveLength(1);
    const row = await owner().query<{ assignee_id: string }>(
      `SELECT assignee_id FROM ticket WHERE id = $1`,
      [ticket.id],
    );
    expect(row.rows[0]?.assignee_id).toBe(agent.userId);
  });

  it('409 once the procedure was retired or the ticket closed; 404 for a card of another ticket', async () => {
    const a = await cardOn({ role: 'lead' });
    expect((await head.client.post(`${a.base}/${a.versionId}/retire`)).status).toBe(200);
    const gone = await agent.client.get<ProcedureProposalList>(
      `/v1/tickets/${a.ticket.id}/procedure-proposals`,
    );
    expect(gone.body.items[0]).toMatchObject({
      status: 'expired',
      expiredReason: 'version_changed',
    });
    const refused = await agent.client.post<ApiErrorBody>(applyPath(a.ticket.id, a.card.id));
    expect(refused.status).toBe(409);

    const b = await cardOn({ role: 'lead' });
    await owner().query(`UPDATE ticket SET status = 'closed' WHERE id = $1`, [b.ticket.id]);
    expect((await agent.client.post(applyPath(b.ticket.id, b.card.id))).status).toBe(409);

    const c = await cardOn({ role: 'lead' });
    expect((await agent.client.post(applyPath(c.ticket.id, b.card.id))).status).toBe(404);
  });
});
