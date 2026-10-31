import { seedIntents } from '@watchtower/db';
import type { TicketDetail, TicketSummary } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, uniqueEmail, type Harness } from '../testing/harness.js';
import {
  apiOrg,
  apiQueue,
  fileTicket,
  signIn,
  timelineOf,
  type ApiErrorBody,
  type Page,
  type Persona,
} from '../testing/ticketing.js';

// T-013: the follow-ups of the T-005 review, on the real application (Postgres, Redis, BullMQ).

let h: Harness;
let lead: Persona;
let agent: Persona;
let agent2: Persona;
let orgId: string;

const pool = () => h.db.owner.pool;

interface AuditRow {
  actor_id: string | null;
  target_type: string | null;
  target_id: string | null;
  outcome: string;
  ip: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
}

async function auditRows(action: string, targetId?: string): Promise<AuditRow[]> {
  const result = await pool().query<AuditRow>(
    `SELECT actor_id, target_type, target_id, outcome, ip, before, after, metadata
     FROM audit_log WHERE action = $1 AND ($2::text IS NULL OR target_id = $2) ORDER BY created_at, id`,
    [action, targetId ?? null],
  );
  return result.rows;
}

beforeAll(async () => {
  h = await startHarness();
  await seedIntents(h.db.owner.db);
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent', undefined, 'Agent One');
  agent2 = await signIn(h, 'agent', undefined, 'Agent Two');
  orgId = (await apiOrg(lead, { name: 'Follow-up Org' })).id;
});

afterAll(async () => {
  await h.close();
});

describe('contact.create from findOrCreateByEmail', () => {
  it('audits a contact created for a new requester, attributed to the staff member, with no address', async () => {
    const email = uniqueEmail('brand-new');
    const ticket = await fileTicket(agent, orgId, { requester: { email, name: 'Brand New' } });
    const contactId = ticket.requester?.id ?? '';
    const rows = await auditRows('contact.create', contactId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: agent.userId,
      target_type: 'contact',
      outcome: 'success',
      after: { id: contactId, orgId, emailCount: 1 },
      metadata: { via: 'find_or_create_by_email' },
    });
    expect(rows[0]?.ip).toBe(agent.client.ip);
    expect(JSON.stringify(rows)).not.toContain(email);
    // The ticket itself is on the log as before; the interceptor wrote nothing extra for the request.
    expect(await auditRows('ticket.create', ticket.id)).toHaveLength(1);
  });

  it('writes no row for a contact that already existed', async () => {
    const email = uniqueEmail('known');
    const first = await fileTicket(agent, orgId, { requester: { email, name: 'Known' } });
    const second = await fileTicket(agent, orgId, { requester: { email, name: 'Known' } });
    expect(second.requester?.id).toBe(first.requester?.id);
    expect(await auditRows('contact.create', first.requester?.id)).toHaveLength(1);
  });

  it('rolls the audit row back together with the contact when the ticket fails afterwards', async () => {
    const email = uniqueEmail('rolled-back');
    const client = await signIn(h, 'client', orgId);
    const count = async () =>
      (
        await pool().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_log WHERE action = 'contact.create'`,
        )
      ).rows[0]?.n;
    const before = await count();
    // A client user cannot be assigned: the request fails after the contact was inserted.
    const response = await agent.client.post('/v1/tickets', {
      orgId,
      subject: 'Will fail',
      body: 'This ticket is refused.',
      requester: { email, name: 'Ghost' },
      assigneeId: client.userId,
    });
    expect(response.status).toBe(400);
    const contact = await pool().query(`SELECT 1 FROM contact WHERE $1 = ANY (emails)`, [email]);
    expect(contact.rowCount).toBe(0);
    expect(await count()).toBe(before);
  });

  it('audits the contact a client creates for themselves when they reply (actor is the client)', async () => {
    const client = await signIn(h, 'client', orgId);
    const created = await client.client.post<{ id: string }>('/v1/tickets', {
      subject: 'From a client',
      body: 'Hello support.',
    });
    expect(created.status).toBe(201);
    const ticketRows = await auditRows('ticket.create', created.body.id);
    expect(ticketRows[0]?.actor_id).toBe(client.userId);
    const reply = await client.client.post(`/v1/tickets/${created.body.id}/replies`, {
      body: 'Any news?',
    });
    expect(reply.status).toBe(201);
    const contacts = await pool().query<{ id: string }>(
      `SELECT id FROM contact WHERE $1 = ANY (emails)`,
      [client.email],
    );
    const contactId = contacts.rows[0]?.id ?? '';
    const rows = await auditRows('contact.create', contactId);
    expect(rows.map((row) => row.actor_id)).toEqual([client.userId]);
  });
});

describe('audit of assign and merge', () => {
  it('writes ticket.assign with the before and after, the actor and the strategy', async () => {
    const ticket = await fileTicket(lead, orgId);
    const response = await lead.client.post(`/v1/tickets/${ticket.id}/assign`, {
      assigneeId: agent.userId,
    });
    expect(response.status).toBe(200);
    await lead.client.post(`/v1/tickets/${ticket.id}/assign`, { assigneeId: agent2.userId });

    const rows = await auditRows('ticket.assign', ticket.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      actor_id: lead.userId,
      target_type: 'ticket',
      outcome: 'success',
      before: { assigneeId: null },
      after: { assigneeId: agent.userId },
      metadata: { strategy: 'manual' },
    });
    expect(rows[0]?.ip).toBe(lead.client.ip);
    expect(rows[1]).toMatchObject({
      before: { assigneeId: agent.userId },
      after: { assigneeId: agent2.userId },
    });
  });

  it('records an unchanged assignment without a change, and a refused one as a failure', async () => {
    const ticket = await fileTicket(lead, orgId, { assigneeId: agent.userId });
    const same = await lead.client.post(`/v1/tickets/${ticket.id}/assign`, {
      assigneeId: agent.userId,
    });
    expect(same.status).toBe(200);
    const refused = await lead.client.post(`/v1/tickets/${ticket.id}/assign`, {
      assigneeId: '00000000-0000-4000-8000-000000000001',
    });
    expect(refused.status).toBe(400);
    const rows = await auditRows('ticket.assign', ticket.id);
    // Both requests are on the log, the second as a failure; neither carries a before/after of an
    // assignment that did not happen.
    expect(rows.map((row) => row.outcome)).toEqual(['success', 'failure']);
    expect(rows.every((row) => row.after === null)).toBe(true);
  });

  it('writes ticket.merge with the source, the target and the moved children', async () => {
    const source = await fileTicket(agent, orgId);
    const target = await fileTicket(agent, orgId);
    const result = await agent.client.post(`/v1/tickets/${source.id}/merge`, {
      intoTicketId: target.id,
      reason: 'same outage',
    });
    expect(result.status).toBe(200);
    const rows = await auditRows('ticket.merge', source.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: agent.userId,
      target_type: 'ticket',
      outcome: 'success',
      before: { status: 'new', parentTicketId: null },
      after: { status: 'merged', parentTicketId: target.id },
      metadata: { intoTicketId: target.id, intoKey: target.key, movedChildren: 0 },
    });
    expect(rows[0]?.ip).toBe(agent.client.ip);
    // The reason is free text and stays out of the log.
    expect(JSON.stringify(rows)).not.toContain('same outage');
  });

  it('gives every child that moves to the new target its own event and audit row', async () => {
    const a = await fileTicket(agent, orgId);
    const b = await fileTicket(agent, orgId);
    const c = await fileTicket(agent, orgId);
    const d = await fileTicket(agent, orgId);
    // a and d are merged into b; then b is merged into c, which moves a and d to c.
    expect(
      (await agent.client.post(`/v1/tickets/${a.id}/merge`, { intoTicketId: b.id })).status,
    ).toBe(200);
    expect(
      (await agent.client.post(`/v1/tickets/${d.id}/merge`, { intoTicketId: b.id })).status,
    ).toBe(200);
    const merged = await agent.client.post(`/v1/tickets/${b.id}/merge`, { intoTicketId: c.id });
    expect(merged.status).toBe(200);

    for (const child of [a, d]) {
      const detail = await agent.client.get<TicketDetail>(`/v1/tickets/${child.id}`);
      expect(detail.body.parentTicketId).toBe(c.id);

      const events = (await timelineOf(agent, child.id)).entries.filter(
        (entry) => entry.kind === 'event' && entry.type === 'ticket.reparented',
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actor: { id: agent.userId },
        visibility: 'internal',
        payload: {
          fromTicketId: b.id,
          fromKey: b.key,
          toTicketId: c.id,
          toKey: c.key,
          reason: 'parent_merged',
        },
      });

      const rows = await auditRows('ticket.reparent', child.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_id: agent.userId,
        target_type: 'ticket',
        before: { parentTicketId: b.id },
        after: { parentTicketId: c.id },
        metadata: { mergedTicketId: b.id, intoTicketId: c.id, intoKey: c.key },
      });
    }
    // The merge itself reports the two children it moved, and a ticket that did not move has no event.
    expect((await auditRows('ticket.merge', b.id))[0]?.metadata).toMatchObject({
      movedChildren: 2,
    });
    const untouched = (await timelineOf(agent, c.id, '?includeMerged=false')).entries.filter(
      (entry) => entry.kind === 'event' && entry.type === 'ticket.reparented',
    );
    expect(untouched).toHaveLength(0);
  });

  it('keeps the whole merged history visible in the timeline of the target (lower bound is not too tight)', async () => {
    const early = await fileTicket(agent, orgId);
    await agent.client.post(`/v1/tickets/${early.id}/notes`, { body: 'note on the early ticket' });
    const target = await fileTicket(agent, orgId);
    await agent.client.post(`/v1/tickets/${early.id}/merge`, { intoTicketId: target.id });
    const entries = (await timelineOf(agent, target.id)).entries;
    const types = entries
      .filter((e) => e.ticketId === early.id)
      .flatMap((e) => (e.kind === 'event' ? [e.type] : []));
    expect(types).toEqual(expect.arrayContaining(['ticket.created', 'ticket.merged']));
  });
});

describe('listing is a PII read', () => {
  it('writes pii.read for a staff list and for a client list, with the number of results', async () => {
    await fileTicket(agent, orgId);
    const before = await pool().query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'pii.read' AND target_type = 'ticket' AND actor_id = $1`,
      [agent.userId],
    );
    const list = await agent.client.get<Page<TicketSummary>>(`/v1/tickets?orgId=${orgId}&limit=5`);
    expect(list.status).toBe(200);
    const rows = await pool().query<AuditRow>(
      `SELECT actor_id, target_type, target_id, metadata, outcome, ip, before, after FROM audit_log
       WHERE action = 'pii.read' AND target_type = 'ticket' AND actor_id = $1 ORDER BY created_at DESC, id DESC`,
      [agent.userId],
    );
    expect(rows.rowCount).toBe((before.rows[0] as { n: number }).n + 1);
    expect(rows.rows[0]).toMatchObject({
      target_id: null,
      outcome: 'success',
      metadata: { method: 'GET', route: '/v1/tickets', resultCount: list.body.items.length },
    });

    const client = await signIn(h, 'client', orgId);
    expect((await client.client.get('/v1/tickets')).status).toBe(200);
    const clientRows = await pool().query(
      `SELECT 1 FROM audit_log WHERE action = 'pii.read' AND target_type = 'ticket' AND actor_id = $1`,
      [client.userId],
    );
    expect(clientRows.rowCount).toBe(1);
  });

  it('records a refused list (400) as a failure on the log too', async () => {
    const response = await agent.client.get('/v1/tickets?status=bogus');
    expect(response.status).toBe(400);
    const rows = await pool().query(
      `SELECT outcome FROM audit_log WHERE action = 'pii.read' AND actor_id = $1 AND outcome <> 'success'`,
      [agent.userId],
    );
    expect(rows.rowCount).toBeGreaterThanOrEqual(1);
  });
});

describe('search length', () => {
  it('finds with a two-character Thai word and refuses one character', async () => {
    const thaiOrg = (await apiOrg(lead, { name: 'Thai search org' })).id;
    const ticket = await fileTicket(agent, thaiOrg, {
      subject: 'ไฟดับที่ห้องเซิร์ฟเวอร์',
      body: 'ไฟดับ ระบบหยุดทำงาน',
    });
    const found = await agent.client.get<Page<TicketSummary>>(
      `/v1/tickets?orgId=${thaiOrg}&q=${encodeURIComponent('ไฟ')}`,
    );
    expect(found.status).toBe(200);
    expect(found.body.items.map((item) => item.id)).toEqual([ticket.id]);

    const tooShort = await agent.client.get<ApiErrorBody>(`/v1/tickets?q=a`);
    expect(tooShort.status).toBe(400);
    const blank = await agent.client.get(`/v1/tickets?q=%20%20`);
    expect(blank.status).toBe(400);
  });

  it('documents the minimum and the index limit in the OpenAPI description', async () => {
    const response = await h
      .client()
      .get<{ paths: Record<string, { get?: { description?: string } }> }>('/docs-json');
    expect(response.status).toBe(200);
    const description = response.body.paths['/v1/tickets']?.get?.description ?? '';
    expect(description).toMatch(/at least 2 characters/);
    expect(description).toMatch(/trigram/);
  });
});

describe('deleting what tickets still reference', () => {
  it('answers 409 for a queue with tickets, and deletes it once they are moved', async () => {
    const queue = await apiQueue(lead, { name: `Busy ${uniqueEmail('q')}` });
    const other = await apiQueue(lead, { name: `Other ${uniqueEmail('q')}` });
    const ticket = await fileTicket(agent, orgId, { queueId: queue.id });

    const refused = await lead.client.delete<ApiErrorBody>(`/v1/queues/${queue.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/still has tickets/);
    expect((await agent.client.get<TicketDetail>(`/v1/tickets/${ticket.id}`)).body.queue?.id).toBe(
      queue.id,
    );
    // The refusal is on the audit log as a failure of queue.delete.
    const failure = (await auditRows('queue.delete', queue.id)).map((row) => row.outcome);
    expect(failure).toEqual(['failure']);

    const moved = await agent.client.patch(`/v1/tickets/${ticket.id}`, { queueId: other.id });
    expect(moved.status).toBe(200);
    expect((await lead.client.delete(`/v1/queues/${queue.id}`)).status).toBe(204);
  });

  it('answers 409 for a contact that a ticket or a message points at, and 204 for one nothing uses', async () => {
    const used = await lead.client.post<{ id: string }>('/v1/contacts', {
      orgId,
      name: 'Has a ticket',
      emails: [uniqueEmail('has-ticket')],
    });
    await fileTicket(agent, orgId, { requesterContactId: used.body.id, requester: undefined });
    const refused = await lead.client.delete<ApiErrorBody>(`/v1/contacts/${used.body.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/referenced by tickets or messages/);
    expect((await lead.client.get(`/v1/contacts/${used.body.id}`)).status).toBe(200);

    // A contact that only wrote a message (not the requester) is protected too.
    const writer = await lead.client.post<{ id: string }>('/v1/contacts', {
      orgId,
      name: 'Wrote a message',
      emails: [uniqueEmail('writer')],
    });
    const ticket = await fileTicket(agent, orgId);
    await pool().query(
      `INSERT INTO message (ticket_id, direction, visibility, body_text, sender_contact_id)
       VALUES ($1, 'inbound', 'public', 'hi', $2)`,
      [ticket.id, writer.body.id],
    );
    expect((await lead.client.delete(`/v1/contacts/${writer.body.id}`)).status).toBe(409);

    const free = await lead.client.post<{ id: string }>('/v1/contacts', {
      orgId,
      name: 'Nobody uses me',
      emails: [uniqueEmail('free')],
    });
    expect((await lead.client.delete(`/v1/contacts/${free.body.id}`)).status).toBe(204);
  });
});

describe('tiers are data', () => {
  it('refuses an unknown tier with 400 and accepts one that was added to org_tier', async () => {
    const unknown = await lead.client.post<ApiErrorBody>('/v1/orgs', {
      name: 'Unknown tier org',
      tier: 'platinum',
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toMatch(/not a known tier/);
    expect(
      (await lead.client.post('/v1/orgs', { name: 'Bad shape', tier: 'Not A Slug' })).status,
    ).toBe(400);

    await pool().query(
      `INSERT INTO org_tier (slug, name, sort_order) VALUES ('platinum', 'Platinum', 5)`,
    );
    const created = await lead.client.post<{ tier: string }>('/v1/orgs', {
      name: 'Platinum org',
      tier: 'platinum',
    });
    expect(created.status).toBe(201);
    expect(created.body.tier).toBe('platinum');

    const patched = await lead.client.patch<ApiErrorBody>(`/v1/orgs/${(await apiOrg(lead)).id}`, {
      tier: 'titanium',
    });
    expect(patched.status).toBe(400);
  });
});
