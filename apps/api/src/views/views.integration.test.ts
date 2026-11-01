import { randomUUID } from 'node:crypto';

import {
  MAX_PERSONAL_VIEWS,
  SYSTEM_VIEW_KEYS,
  type SavedView,
  type SavedViewList,
  type TicketSummary,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import {
  apiOrg,
  fileTicket,
  signIn,
  type ApiErrorBody,
  type Page,
  type Persona,
} from '../testing/ticketing.js';

// T-119a: saved views on the server: the built-in ones with their counts, personal and shared views,
// who may change what, and that a view's filters give the same tickets as the list does.

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let otherAgent: Persona;
let client: Persona;
let orgId: string;

const pool = () => h.db.owner.pool;

const views = (who: Persona, query = '') =>
  who.client.get<SavedViewList>(`/v1/views${query}`).then((response) => response.body.items);
const viewNamed = async (who: Persona, key: string): Promise<SavedView> => {
  const found = (await views(who)).find((view) => view.key === key || view.name === key);
  if (!found) throw new Error(`no view ${key}`);
  return found;
};

/** The query string that `GET /v1/tickets` takes for a view's filters. */
function ticketQuery(view: SavedView): string {
  const params = new URLSearchParams();
  const { filters } = view;
  if (filters.status) params.set('status', filters.status.join(','));
  if (filters.priority) params.set('priority', filters.priority.join(','));
  if (filters.assignee) params.set('assignee', filters.assignee);
  if (filters.slaState) params.set('slaState', filters.slaState.join(','));
  if (filters.overdue !== undefined) params.set('overdue', String(filters.overdue));
  params.set('sort', view.sort);
  params.set('limit', '200');
  return params.toString();
}

beforeAll(async () => {
  h = await startHarness();
  head = await signIn(h, 'head', undefined, 'Head One');
  lead = await signIn(h, 'lead', undefined, 'Lead One');
  agent = await signIn(h, 'agent', undefined, 'Agent One');
  otherAgent = await signIn(h, 'agent', undefined, 'Agent Two');
  orgId = (await apiOrg(lead, { name: 'Views Org' })).id;
  client = await signIn(h, 'client', orgId);
});
afterAll(async () => {
  await h.close();
});

describe('who may list and save views', () => {
  it('is staff; a client gets 403 and nobody signed in 401', async () => {
    for (const who of [agent, lead, head]) {
      expect((await who.client.get('/v1/views')).status).toBe(200);
    }
    expect((await client.client.get('/v1/views')).status).toBe(403);
    expect((await h.client().get('/v1/views')).status).toBe(401);
    const body = { name: 'x', filters: {} };
    expect((await client.client.post('/v1/views', body)).status).toBe(403);
    expect((await h.client().post('/v1/views', body)).status).toBe(401);
    expect((await client.client.patch(`/v1/views/${randomUUID()}`, { name: 'y' })).status).toBe(403);
    expect((await client.client.delete(`/v1/views/${randomUUID()}`)).status).toBe(403);
    expect((await h.client().delete(`/v1/views/${randomUUID()}`)).status).toBe(401);
  });
});

describe('the built-in views', () => {
  let ids: Record<string, string>;

  beforeAll(async () => {
    const make = async (fields: Record<string, unknown> = {}) => fileTicket(lead, orgId, fields);
    const a = await make();
    const b = await make({ assigneeId: agent.userId });
    const c = await make();
    const d = await make({ assigneeId: lead.userId });
    const e = await make({ assigneeId: lead.userId });
    const f = await make();
    ids = { a: a.id, b: b.id, c: c.id, d: d.id, e: e.id, f: f.id };
    const set = (id: string, sql: string) => pool().query(`UPDATE ticket SET ${sql} WHERE id = $1`, [id]);
    await set(a.id, `status = 'new', assignee_id = NULL`);
    await set(b.id, `status = 'open'`);
    await set(c.id, `status = 'triage', assignee_id = NULL`);
    await set(d.id, `status = 'waiting_on_customer'`);
    // E has a first-response target that passed an hour ago and nobody answered.
    await set(
      e.id,
      `status = 'open', first_response_due_at = now() - interval '1 hour',
       resolution_due_at = now() + interval '1 day'`,
    );
    await set(f.id, `status = 'resolved', assignee_id = NULL, resolved_at = now()`);
  });

  it('lists all six, before anything somebody saved, each with the filters to give the ticket list', async () => {
    const items = await views(agent);
    expect(items.map((view) => view.key)).toEqual([...SYSTEM_VIEW_KEYS]);
    expect(items.map((view) => view.id)).toEqual(SYSTEM_VIEW_KEYS.map((key) => `system:${key}`));
    for (const view of items) {
      expect(view).toMatchObject({ kind: 'system', ownerId: null, editable: false });
    }
    const atRisk = items.find((view) => view.key === 'sla_at_risk');
    expect(atRisk).toMatchObject({
      filters: { slaState: ['at_risk', 'breached'] },
      sort: 'sla_due_asc',
    });
    expect(items.find((view) => view.key === 'triage')?.filters).toEqual({ status: ['triage'] });
    expect(items.find((view) => view.key === 'waiting_on_customer')?.filters).toEqual({
      status: ['waiting_on_customer'],
    });
  });

  it('counts each for the person asking', async () => {
    const countsOf = async (who: Persona): Promise<Record<string, number | null>> =>
      Object.fromEntries((await views(who)).map((view) => [view.key ?? view.id, view.count]));
    expect(await countsOf(agent)).toEqual({
      my_queue: 1,
      unassigned: 2,
      sla_at_risk: 1,
      triage: 1,
      waiting_on_customer: 1,
      all_open: 5,
    });
    // `my queue` is whoever asks.
    expect((await countsOf(lead)).my_queue).toBe(2);
    expect((await countsOf(otherAgent)).my_queue).toBe(0);
  });

  it('gives the same tickets through the ticket list as the number says, in SLA order', async () => {
    for (const view of (await views(agent)).filter((item) => item.kind === 'system')) {
      const list = await agent.client.get<Page<TicketSummary>>(`/v1/tickets?${ticketQuery(view)}`);
      expect(list.status, view.key ?? '').toBe(200);
      expect(list.body.items.length, view.key ?? '').toBe(view.count);
    }
    const atRisk = await viewNamed(agent, 'sla_at_risk');
    const list = await agent.client.get<Page<TicketSummary>>(`/v1/tickets?${ticketQuery(atRisk)}`);
    expect(list.body.items.map((ticket) => ticket.id)).toEqual([ids.e]);
    expect(list.body.items[0]?.sla?.state).toBe('breached');

    const triage = await viewNamed(agent, 'triage');
    const triageList = await agent.client.get<Page<TicketSummary>>(`/v1/tickets?${ticketQuery(triage)}`);
    expect(triageList.body.items.map((ticket) => ticket.id)).toEqual([ids.c]);
    const waiting = await viewNamed(agent, 'waiting_on_customer');
    const waitingList = await agent.client.get<Page<TicketSummary>>(`/v1/tickets?${ticketQuery(waiting)}`);
    expect(waitingList.body.items.map((ticket) => ticket.id)).toEqual([ids.d]);
  });

  it('sorts the SLA at risk list by the due time that is running, soonest first', async () => {
    const soon = await fileTicket(lead, orgId);
    await pool().query(
      `UPDATE ticket SET status = 'open', first_response_due_at = now() - interval '3 hours' WHERE id = $1`,
      [soon.id],
    );
    const atRisk = await viewNamed(agent, 'sla_at_risk');
    const list = await agent.client.get<Page<TicketSummary>>(`/v1/tickets?${ticketQuery(atRisk)}`);
    expect(list.body.items.map((ticket) => ticket.id)).toEqual([soon.id, ids.e]);
    await pool().query(`UPDATE ticket SET status = 'closed' WHERE id = $1`, [soon.id]);
  });

  it('leaves the counts out when asked', async () => {
    const items = await views(agent, '?counts=false');
    expect(items.every((view) => view.count === null)).toBe(true);
  });

  it('cannot be changed or deleted: 409, and an unknown id is 404', async () => {
    expect((await lead.client.patch('/v1/views/system:triage', { name: 'Mine' })).status).toBe(409);
    expect((await lead.client.delete('/v1/views/system:triage')).status).toBe(409);
    expect((await lead.client.patch('/v1/views/not-a-view', { name: 'Mine' })).status).toBe(404);
    expect((await lead.client.delete(`/v1/views/${randomUUID()}`)).status).toBe(404);
  });
});

describe('personal views', () => {
  it('saves the filters, lists them with a count, and keeps them to their owner', async () => {
    const created = await agent.client.post<SavedView>('/v1/views', {
      name: 'My open P3',
      filters: { priority: ['P3'], assignee: 'me', status: ['open'] },
      sort: 'created_asc',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'personal',
      key: null,
      name: 'My open P3',
      filters: { priority: ['P3'], assignee: 'me', status: ['open'] },
      sort: 'created_asc',
      ownerId: agent.userId,
      ownerName: 'Agent One',
      editable: true,
    });

    const mine = (await views(agent)).find((view) => view.id === created.body.id);
    expect(mine).toMatchObject({ count: 1, editable: true });
    // Nobody else sees it, and nobody else can change it: it is not theirs to know about (404).
    for (const who of [otherAgent, lead, head]) {
      expect((await views(who)).map((view) => view.id)).not.toContain(created.body.id);
      expect((await who.client.patch(`/v1/views/${created.body.id}`, { name: 'Stolen' })).status).toBe(404);
      expect((await who.client.delete(`/v1/views/${created.body.id}`)).status).toBe(404);
    }
    const audit = await pool().query<{ actor_id: string; after: { name: string } }>(
      `SELECT actor_id, after FROM audit_log WHERE action = 'view.create' AND target_id = $1`,
      [created.body.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_id: agent.userId, after: { name: 'My open P3' } });
  });

  it('is edited and deleted by its owner, with before and after on the audit log', async () => {
    const created = await otherAgent.client.post<SavedView>('/v1/views', {
      name: 'Waiting',
      filters: { status: ['waiting_on_customer'] },
    });
    expect(created.body.sort).toBe('sla_due_asc');
    const patched = await otherAgent.client.patch<SavedView>(`/v1/views/${created.body.id}`, {
      name: 'Waiting on them',
      filters: { status: ['waiting_on_customer', 'waiting_on_dev'], tag: 'vip' },
      sort: 'updated_desc',
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      name: 'Waiting on them',
      filters: { status: ['waiting_on_customer', 'waiting_on_dev'], tag: 'vip' },
      sort: 'updated_desc',
    });
    const audit = await pool().query<{
      before: { name: string; filters: unknown };
      after: { name: string; filters: unknown };
    }>(`SELECT before, after FROM audit_log WHERE action = 'view.update' AND target_id = $1`, [
      created.body.id,
    ]);
    expect(audit.rows[0]?.before.name).toBe('Waiting');
    expect(audit.rows[0]?.after.name).toBe('Waiting on them');

    expect((await otherAgent.client.delete(`/v1/views/${created.body.id}`)).status).toBe(204);
    expect((await views(otherAgent)).map((view) => view.id)).not.toContain(created.body.id);
    const removed = await pool().query<{ before: { name: string } }>(
      `SELECT before FROM audit_log WHERE action = 'view.delete' AND target_id = $1`,
      [created.body.id],
    );
    expect(removed.rows[0]?.before.name).toBe('Waiting on them');
    expect((await otherAgent.client.delete(`/v1/views/${created.body.id}`)).status).toBe(404);
  });

  it('refuses a name already used by that person, ignoring case, but not by somebody else', async () => {
    const first = await lead.client.post('/v1/views', { name: 'Billing', filters: { tag: 'billing' } });
    expect(first.status).toBe(201);
    const same = await lead.client.post<ApiErrorBody>('/v1/views', {
      name: 'BILLING',
      filters: {},
    });
    expect(same.status).toBe(409);
    expect((await head.client.post('/v1/views', { name: 'Billing', filters: {} })).status).toBe(201);
    // Renaming into a taken name is the same refusal.
    const other = await lead.client.post<SavedView>('/v1/views', { name: 'Other', filters: {} });
    expect(
      (await lead.client.patch(`/v1/views/${other.body.id}`, { name: 'billing' })).status,
    ).toBe(409);
  });

  it('keeps a person to 50 personal views', async () => {
    const user = await signIn(h, 'agent', undefined, 'Collector');
    await pool().query(
      `INSERT INTO saved_view (owner_id, name) SELECT $1, 'view ' || n FROM generate_series(1, $2) AS n`,
      [user.userId, MAX_PERSONAL_VIEWS],
    );
    const over = await user.client.post<ApiErrorBody>('/v1/views', { name: 'One too many', filters: {} });
    expect(over.status).toBe(409);
    expect(over.body.message).toContain(String(MAX_PERSONAL_VIEWS));
  });

  it('refuses filters the list does not understand, a bad sort and an empty name (400)', async () => {
    const bad = (body: Record<string, unknown>) => agent.client.post('/v1/views', body);
    expect((await bad({ name: 'a', filters: { colour: 'red' } })).status).toBe(400);
    expect((await bad({ name: 'a', filters: { status: ['nope'] } })).status).toBe(400);
    expect((await bad({ name: 'a', filters: { status: [] } })).status).toBe(400);
    expect((await bad({ name: 'a', filters: { q: 'x' } })).status).toBe(400);
    expect((await bad({ name: 'a', filters: {}, sort: 'random' })).status).toBe(400);
    expect((await bad({ name: '   ', filters: {} })).status).toBe(400);
    expect((await bad({ name: 'a'.repeat(81), filters: {} })).status).toBe(400);
    expect((await bad({ filters: {} })).status).toBe(400);
    expect((await agent.client.patch(`/v1/views/${randomUUID()}`, {})).status).toBe(400);
  });
});

describe('shared views', () => {
  let shared: SavedView;

  it('need view.share to create: an agent gets 403, a lead can', async () => {
    const refused = await agent.client.post('/v1/views', {
      name: 'For everyone',
      filters: { assignee: 'me' },
      shared: true,
    });
    expect(refused.status).toBe(403);
    const created = await lead.client.post<SavedView>('/v1/views', {
      name: 'For everyone',
      filters: { assignee: 'me' },
      shared: true,
    });
    expect(created.status).toBe(201);
    shared = created.body;
    expect(shared).toMatchObject({ kind: 'shared', ownerId: lead.userId, editable: true });
  });

  it('are listed for everybody before personal ones, counted for the person asking', async () => {
    const forAgent = await views(agent);
    const copy = forAgent.find((view) => view.id === shared.id);
    expect(copy).toMatchObject({ kind: 'shared', editable: false, ownerName: 'Lead One' });
    // `assignee: me` is the viewer: one ticket is the agent's, two are the lead's.
    expect(copy?.count).toBe(1);
    expect((await views(lead)).find((view) => view.id === shared.id)?.count).toBe(2);
    const order = forAgent.map((view) => view.kind);
    expect(order.indexOf('shared')).toBeGreaterThan(order.lastIndexOf('system'));
    expect(order.lastIndexOf('shared')).toBeLessThan(order.indexOf('personal'));
  });

  it('are changed and deleted only by somebody with view.share, even for their owner', async () => {
    expect((await agent.client.patch(`/v1/views/${shared.id}`, { name: 'Mine now' })).status).toBe(403);
    expect((await agent.client.delete(`/v1/views/${shared.id}`)).status).toBe(403);
    // The head holds view.share and may change the lead's shared view.
    const renamed = await head.client.patch<SavedView>(`/v1/views/${shared.id}`, {
      name: 'For the whole team',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('For the whole team');
    // A person may not make their own view the team's without view.share, nor take it back.
    const mine = await agent.client.post<SavedView>('/v1/views', { name: 'Private', filters: {} });
    expect((await agent.client.patch(`/v1/views/${mine.body.id}`, { shared: true })).status).toBe(403);
    const shareIt = await lead.client.post<SavedView>('/v1/views', { name: 'Draft', filters: {} });
    const promoted = await lead.client.patch<SavedView>(`/v1/views/${shareIt.body.id}`, { shared: true });
    expect(promoted.body.kind).toBe('shared');
    expect((await agent.client.patch(`/v1/views/${shareIt.body.id}`, { shared: false })).status).toBe(403);
    expect((await lead.client.patch<SavedView>(`/v1/views/${shareIt.body.id}`, { shared: false })).body.kind).toBe('personal');
  });

  it('keep their names unique among shared views', async () => {
    const clash = await head.client.post<ApiErrorBody>('/v1/views', {
      name: 'for the WHOLE team',
      filters: {},
      shared: true,
    });
    expect(clash.status).toBe(409);
    // A personal view may have the same name as a shared one.
    expect(
      (await agent.client.post('/v1/views', { name: 'For the whole team', filters: {} })).status,
    ).toBe(201);
  });

  it('can be deleted by the head, and the deletion is audited', async () => {
    expect((await head.client.delete(`/v1/views/${shared.id}`)).status).toBe(204);
    expect((await views(agent)).map((view) => view.id)).not.toContain(shared.id);
    const audit = await pool().query<{ actor_id: string; outcome: string }>(
      `SELECT actor_id, outcome FROM audit_log WHERE action = 'view.delete' AND target_id = $1 ORDER BY created_at`,
      [shared.id],
    );
    // The agent's refused attempt is on the log too, as denied; then the head's deletion.
    expect(audit.rows).toEqual([
      { actor_id: agent.userId, outcome: 'denied' },
      { actor_id: head.userId, outcome: 'success' },
    ]);
  });
});
