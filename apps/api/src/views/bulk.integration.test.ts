import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type BulkResult,
  type ShiftSession,
  type ShiftStatus,
  type TicketDetail,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import {
  apiOrg,
  fileTicket,
  signIn,
  type ApiErrorBody,
  type Persona,
} from '../testing/ticketing.js';

// T-119b: bulk actions. Each ticket is its own change made as the person; one failing does not undo the
// others; every change is on the ticket history and the audit log with the person as actor (so the
// AC-7 reading of "moved away" sees it); nothing reaches a customer.

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let otherAgent: Persona;
let client: Persona;
let orgId: string;
let otherOrgId: string;

const pool = () => h.db.owner.pool;

const bulk = (who: Persona, ticketIds: string[], action: Record<string, unknown>) =>
  who.client.post<BulkResult & Partial<ApiErrorBody>>('/v1/tickets/bulk', { ticketIds, action });

async function tickets(count: number, fields: Record<string, unknown> = {}, org = orgId) {
  const made: TicketDetail[] = [];
  for (let index = 0; index < count; index += 1) {
    made.push(await fileTicket(lead, org, fields));
  }
  return made;
}

const ticketOf = async (who: Persona, id: string) =>
  (await who.client.get<TicketDetail>(`/v1/tickets/${id}`)).body;

const events = async (ticketId: string, type: string) =>
  (
    await pool().query<{
      actor_type: string;
      actor_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT actor_type, actor_id, payload FROM ticket_event WHERE ticket_id = $1 AND type = $2 ORDER BY created_at`,
      [ticketId, type],
    )
  ).rows;

const auditRows = async (action: string, targetId?: string) =>
  (
    await pool().query<{
      actor_id: string | null;
      outcome: string;
      target_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT actor_id, outcome, target_id, metadata FROM audit_log
        WHERE action = $1 AND ($2::text IS NULL OR target_id = $2) ORDER BY created_at`,
      [action, targetId ?? null],
    )
  ).rows;

beforeAll(async () => {
  h = await startHarness();
  head = await signIn(h, 'head', undefined, 'Head One');
  lead = await signIn(h, 'lead', undefined, 'Lead One');
  agent = await signIn(h, 'agent', undefined, 'Agent One');
  otherAgent = await signIn(h, 'agent', undefined, 'Agent Two');
  orgId = (await apiOrg(lead, { name: 'Bulk Org' })).id;
  otherOrgId = (await apiOrg(lead, { name: 'Other Bulk Org' })).id;
  client = await signIn(h, 'client', orgId);
});
afterAll(async () => {
  await h.close();
});

describe('who may use bulk', () => {
  it('needs ticket.handle: a client gets 403, nobody signed in 401, an agent without the permission 403', async () => {
    const [ticket] = await tickets(1);
    const action = { type: 'priority', priority: 'P2' };
    expect((await bulk(client, [ticket?.id ?? ''], action)).status).toBe(403);
    expect(
      (await h.client().post('/v1/tickets/bulk', { ticketIds: [ticket?.id], action })).status,
    ).toBe(401);

    const without = DEFAULT_ROLE_PERMISSIONS.agent.filter(
      (permission) => permission !== 'ticket.handle',
    );
    expect(
      (await head.client.put('/v1/rbac/roles/agent/permissions', { permissions: without })).status,
    ).toBe(200);
    try {
      expect((await bulk(agent, [ticket?.id ?? ''], action)).status).toBe(403);
    } finally {
      await head.client.put('/v1/rbac/roles/agent/permissions', {
        permissions: [...DEFAULT_ROLE_PERMISSIONS.agent],
      });
    }
    // Nothing changed; and with the permission back it works.
    expect((await ticketOf(agent, ticket?.id ?? '')).priority).not.toBe('P2');
    expect((await bulk(agent, [ticket?.id ?? ''], action)).status).toBe(200);
  });
});

describe('assign', () => {
  it('assigns every selected ticket as the caller, with a ticket event and an audit row for each', async () => {
    const made = await tickets(3);
    const ids = made.map((ticket) => ticket.id);
    const response = await bulk(agent, ids, { type: 'assign', assigneeId: otherAgent.userId });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ action: 'assign', total: 3, succeeded: 3, failed: 0 });
    expect(response.body.items.map((item) => item.ticketId)).toEqual(ids);
    expect(response.body.items.every((item) => item.ok && item.key !== null)).toBe(true);

    for (const ticket of made) {
      expect((await ticketOf(agent, ticket.id)).assignee?.id).toBe(otherAgent.userId);
      // The history says who did it: the caller, as a user. This is what the handoff gate reads.
      const moved = await events(ticket.id, 'ticket.assigned');
      expect(moved).toHaveLength(1);
      expect(moved[0]).toMatchObject({
        actor_type: 'user',
        actor_id: agent.userId,
        payload: { from: null, to: otherAgent.userId, strategy: 'manual' },
      });
      const audit = await auditRows('ticket.assign', ticket.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_id: agent.userId, outcome: 'success' });
    }

    // One summary row for the request, listing every outcome.
    const summary = (await auditRows('ticket.bulk')).at(-1);
    expect(summary).toMatchObject({ actor_id: agent.userId, outcome: 'success' });
    expect(summary?.metadata).toMatchObject({
      bulkAction: 'assign',
      total: 3,
      succeeded: 3,
      failed: 0,
      assigneeId: otherAgent.userId,
    });
    expect(
      (summary?.metadata.results as { ticketId: string; ok: boolean }[]).map((r) => r.ticketId),
    ).toEqual(ids);
  });

  it('unassigns with null, and refuses a person who cannot be assigned (per ticket)', async () => {
    const made = await tickets(2, { assigneeId: agent.userId });
    const ids = made.map((ticket) => ticket.id);
    const undone = await bulk(lead, ids, { type: 'assign', assigneeId: null });
    expect(undone.body).toMatchObject({ succeeded: 2, failed: 0 });
    expect((await ticketOf(lead, ids[0] ?? '')).assignee).toBeNull();

    const clientUser = client.userId;
    const refused = await bulk(lead, ids, { type: 'assign', assigneeId: clientUser });
    expect(refused.status).toBe(200);
    expect(refused.body).toMatchObject({ succeeded: 0, failed: 2 });
    expect(refused.body.items[0]?.error?.status).toBe(400);
    expect((await ticketOf(lead, ids[0] ?? '')).assignee).toBeNull();
    // Everything failed: the summary says so, and no ticket got an audit row for it.
    const summary = (await auditRows('ticket.bulk')).at(-1);
    expect(summary?.outcome).toBe('failure');
    expect(await auditRows('ticket.assign', ids[0])).toHaveLength(1); // the unassign only
  });
});

describe('one ticket failing does not undo the others', () => {
  it('reports each ticket: a merged one (409), one that does not exist (404), and the ones that worked', async () => {
    const [good1, good2, merged, target] = await tickets(4);
    await head.client.post(`/v1/tickets/${merged?.id ?? ''}/merge`, { intoTicketId: target?.id });
    const missing = randomUUID();

    const response = await bulk(
      agent,
      [good1?.id ?? '', merged?.id ?? '', missing, good2?.id ?? ''],
      {
        type: 'assign',
        assigneeId: agent.userId,
      },
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 4, succeeded: 2, failed: 2 });
    const [first, second, third, fourth] = response.body.items;
    expect(first).toMatchObject({ ticketId: good1?.id, ok: true });
    expect(second).toMatchObject({
      ticketId: merged?.id,
      ok: false,
      key: merged?.key,
      error: { status: 409, code: 'ticket_not_open' },
    });
    expect(third).toMatchObject({
      ticketId: missing,
      ok: false,
      key: null,
      error: { status: 404 },
    });
    expect(fourth).toMatchObject({ ticketId: good2?.id, ok: true });

    expect((await ticketOf(agent, good1?.id ?? '')).assignee?.id).toBe(agent.userId);
    expect((await ticketOf(agent, good2?.id ?? '')).assignee?.id).toBe(agent.userId);
    expect(await auditRows('ticket.assign', merged?.id)).toHaveLength(0);
    const summary = (await auditRows('ticket.bulk')).at(-1);
    expect(summary).toMatchObject({ outcome: 'success' });
    expect(summary?.metadata).toMatchObject({ succeeded: 2, failed: 2 });
  });
});

describe('status and priority', () => {
  it('changes the status where the workflow allows it and says why elsewhere', async () => {
    const [open, resolved] = await tickets(2);
    await pool().query(`UPDATE ticket SET status = 'open' WHERE id = $1`, [open?.id]);
    await pool().query(`UPDATE ticket SET status = 'closed' WHERE id = $1`, [resolved?.id]);
    const response = await bulk(agent, [open?.id ?? '', resolved?.id ?? ''], {
      type: 'status',
      status: 'waiting_on_customer',
      reason: 'Asked for logs',
    });
    expect(response.body).toMatchObject({ action: 'status', succeeded: 1, failed: 1 });
    expect(response.body.items[0]).toMatchObject({ ok: true });
    expect(response.body.items[1]).toMatchObject({
      ok: false,
      error: { status: 409, code: 'invalid_transition' },
    });
    const after = await ticketOf(agent, open?.id ?? '');
    expect(after.status).toBe('waiting_on_customer');
    // The SLA clock stops in this status, exactly as for a single change.
    expect(after.slaPausedAt).not.toBeNull();
    const changed = await events(open?.id ?? '', 'ticket.status_changed');
    expect(changed.at(-1)).toMatchObject({ actor_type: 'user', actor_id: agent.userId });
    expect(await auditRows('ticket.status_change', open?.id)).toHaveLength(1);
  });

  it('cannot make a ticket merged: that is the merge action (400)', async () => {
    const [ticket] = await tickets(1);
    expect(
      (await bulk(agent, [ticket?.id ?? ''], { type: 'status', status: 'merged' })).status,
    ).toBe(400);
  });

  it('changes the priority and records from and to on each ticket', async () => {
    const made = await tickets(2, { priority: 'P3' });
    const response = await bulk(
      lead,
      made.map((ticket) => ticket.id),
      {
        type: 'priority',
        priority: 'P1',
      },
    );
    expect(response.body).toMatchObject({ succeeded: 2, failed: 0 });
    for (const ticket of made) {
      expect((await ticketOf(lead, ticket.id)).priority).toBe('P1');
      const updated = await events(ticket.id, 'ticket.updated');
      const change = updated.find((event) => 'priority' in event.payload);
      expect(change).toMatchObject({
        actor_type: 'user',
        actor_id: lead.userId,
        payload: { priority: { from: 'P3', to: 'P1' } },
      });
      expect(await auditRows('ticket.update', ticket.id)).toHaveLength(1);
    }
  });
});

describe('merge', () => {
  it('merges every selected ticket into the target, inside one organization', async () => {
    const [a, b, target] = await tickets(3);
    const response = await bulk(agent, [a?.id ?? '', b?.id ?? ''], {
      type: 'merge',
      intoTicketId: target?.key,
      reason: 'Same outage',
    });
    expect(response.body).toMatchObject({ action: 'merge', succeeded: 2, failed: 0 });
    for (const source of [a, b]) {
      const merged = await ticketOf(agent, source?.id ?? '');
      expect(merged.status).toBe('merged');
      expect(merged.mergedIntoKey).toBe(target?.key);
      expect(await auditRows('ticket.merge', source?.id)).toHaveLength(1);
    }
    const summary = (await auditRows('ticket.bulk')).at(-1);
    expect(summary?.metadata).toMatchObject({ bulkAction: 'merge', intoTicketId: target?.id });
  });

  it('fails a ticket of another organization alone, and refuses a target that is selected or unknown', async () => {
    const [near, target] = await tickets(2);
    const [far] = await tickets(1, {}, otherOrgId);
    const response = await bulk(agent, [near?.id ?? '', far?.id ?? ''], {
      type: 'merge',
      intoTicketId: target?.id,
    });
    expect(response.body).toMatchObject({ succeeded: 1, failed: 1 });
    expect(response.body.items[1]).toMatchObject({
      ok: false,
      error: { status: 409, code: 'merge_not_allowed' },
    });
    expect((await ticketOf(agent, far?.id ?? '')).status).not.toBe('merged');

    const selected = await bulk(agent, [near?.id ?? '', target?.id ?? ''], {
      type: 'merge',
      intoTicketId: target?.id,
    });
    expect(selected.status).toBe(400);
    const unknown = await bulk(agent, [near?.id ?? ''], {
      type: 'merge',
      intoTicketId: randomUUID(),
    });
    expect(unknown.status).toBe(404);
  });
});

describe('what a bulk request can be', () => {
  it('rejects a bad body: nothing selected, too many, repeated ids, an unknown action (there is no reply)', async () => {
    const [ticket] = await tickets(1);
    const id = ticket?.id ?? '';
    const ok = { type: 'priority', priority: 'P2' };
    expect((await bulk(agent, [], ok)).status).toBe(400);
    expect(
      (
        await bulk(
          agent,
          Array.from({ length: 101 }, () => randomUUID()),
          ok,
        )
      ).status,
    ).toBe(400);
    expect((await bulk(agent, [id, id], ok)).status).toBe(400);
    expect((await bulk(agent, ['OPS-1'], ok)).status).toBe(400);
    expect((await bulk(agent, [id], { type: 'reply', body: 'Hello' })).status).toBe(400);
    expect((await bulk(agent, [id], { type: 'note', body: 'Hello' })).status).toBe(400);
    expect((await bulk(agent, [id], { type: 'priority', priority: 'P9' })).status).toBe(400);
    expect((await bulk(agent, [id], { type: 'assign' })).status).toBe(400);
  });

  it('puts nothing in front of a customer: no message, no delivery, no outbound job', async () => {
    const account = await pool().query<{ id: string }>(
      `INSERT INTO channel_account (type, name) VALUES ('gmail', 'Bulk mailbox') RETURNING id`,
    );
    const made = await tickets(2);
    for (const ticket of made) {
      await pool().query(
        `UPDATE ticket SET channel = 'gmail', channel_account_id = $2, status = 'open' WHERE id = $1`,
        [ticket.id, account.rows[0]?.id],
      );
    }
    const count = async () =>
      (
        await pool().query<{ messages: string; deliveries: string; jobs: string }>(
          `SELECT (SELECT count(*) FROM message) AS messages,
                  (SELECT count(*) FROM outbound_delivery) AS deliveries,
                  (SELECT count(*) FROM outbox WHERE queue IN ('outbound', 'email', 'line', 'gmail')) AS jobs`,
        )
      ).rows[0];
    const before = await count();
    const ids = made.map((ticket) => ticket.id);
    for (const action of [
      { type: 'assign', assigneeId: agent.userId },
      { type: 'priority', priority: 'P1' },
      { type: 'status', status: 'resolved', reason: 'Fixed' },
      { type: 'status', status: 'closed' },
    ]) {
      expect((await bulk(lead, ids, action)).status).toBe(200);
    }
    expect(await count()).toEqual(before);
  });
});

describe('per ticket permission', () => {
  it('fails only the tickets the caller may not see: a client given ticket.handle by mistake still reaches only its own organization', async () => {
    const [mine] = await tickets(1);
    const [theirs] = await tickets(1, {}, otherOrgId);
    const grant = await head.client.put('/v1/rbac/roles/client/permissions', {
      permissions: [...DEFAULT_ROLE_PERMISSIONS.client, 'ticket.handle'],
    });
    try {
      expect(grant.status).toBe(200);
      const response = await bulk(client, [mine?.id ?? '', theirs?.id ?? ''], {
        type: 'priority',
        priority: 'P2',
      });
      expect(response.status).toBe(200);
      expect(response.body.items[1]).toMatchObject({
        ticketId: theirs?.id,
        ok: false,
        key: null,
        error: { status: 404 },
      });
      expect((await ticketOf(lead, theirs?.id ?? '')).priority).not.toBe('P2');
    } finally {
      await head.client.put('/v1/rbac/roles/client/permissions', {
        permissions: [...DEFAULT_ROLE_PERMISSIONS.client],
      });
    }
  });
});

describe('AC-7: a bulk change cannot be used to shake tickets off before clocking out', () => {
  async function clockIn(who: Persona): Promise<void> {
    const response = await who.client.post<ShiftSession>('/v1/shifts/clock-in', {});
    expect(response.status).toBe(200);
  }
  const blockersOf = async (who: Persona) =>
    (await who.client.get<ShiftStatus>('/v1/shifts/status')).body.clockOutBlocked?.blockers ?? [];

  it('reads a bulk reassignment and a bulk downgrade like single ones: the P1 tickets stay on the gate', async () => {
    const shaker = await signIn(h, 'agent', undefined, 'Bulk Shaker');
    await clockIn(shaker);
    const moved = await tickets(2, { priority: 'P1', assigneeId: shaker.userId });
    const lowered = await tickets(1, { priority: 'P2', assigneeId: shaker.userId });
    const kept = await tickets(1, { priority: 'P1', assigneeId: shaker.userId });
    // Before: each open P1/P2 ticket is simply required in the handoff, none of them "moved away".
    const before = await blockersOf(shaker);
    expect(before).toHaveLength(4);
    expect(before.every((blocker) => blocker.cause === undefined)).toBe(true);

    // A bulk reassignment to somebody who is not on shift...
    const away = await bulk(
      shaker,
      moved.map((ticket) => ticket.id),
      {
        type: 'assign',
        assigneeId: otherAgent.userId,
      },
    );
    expect(away.body).toMatchObject({ succeeded: 2, failed: 0 });
    // ...and a bulk downgrade to P4.
    const down = await bulk(
      shaker,
      lowered.map((ticket) => ticket.id),
      {
        type: 'priority',
        priority: 'P4',
      },
    );
    expect(down.body).toMatchObject({ succeeded: 1, failed: 0 });

    const blockers = await blockersOf(shaker);
    const withCause = blockers.filter((blocker) => blocker.cause !== undefined);
    expect(withCause.map((blocker) => [blocker.ticketId, blocker.cause]).sort()).toEqual(
      [...moved.map((ticket) => [ticket.id, 'moved_away']), [lowered[0]?.id, 'downgraded']].sort(),
    );
    // The ticket still assigned and still P1 is a plain requirement, not a bypass.
    expect(blockers.find((blocker) => blocker.ticketId === kept[0]?.id)?.cause).toBeUndefined();
    // They cannot clock out until the handoff lists them.
    expect((await shaker.client.post('/v1/shifts/clock-out', {})).status).toBe(409);
  });

  it("does not count a lead's bulk change against the person whose tickets were moved", async () => {
    const holder = await signIn(h, 'agent', undefined, 'Bulk Holder');
    await clockIn(holder);
    const [ticket] = await tickets(1, { priority: 'P1', assigneeId: holder.userId });
    const response = await bulk(lead, [ticket?.id ?? ''], {
      type: 'assign',
      assigneeId: otherAgent.userId,
    });
    expect(response.body.succeeded).toBe(1);
    const moved = await events(ticket?.id ?? '', 'ticket.assigned');
    expect(moved.at(-1)).toMatchObject({ actor_id: lead.userId, payload: { from: holder.userId } });
    expect((await blockersOf(holder)).map((blocker) => blocker.ticketId)).not.toContain(ticket?.id);
  });
});
