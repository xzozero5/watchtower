import { randomUUID } from 'node:crypto';

import type { TicketLink, TicketLinkList, TimelineEntry } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import {
  apiOrg,
  fileTicket,
  signIn,
  timelineOf,
  type ApiErrorBody,
  type Persona,
} from '../testing/ticketing.js';

// T-119c: duplicate / related links between tickets (R-1.1): staff only, one organization, events on
// both tickets, an audit row, and never a merge.

let h: Harness;
let lead: Persona;
let agent: Persona;
let client: Persona;
let orgId: string;
let otherOrgId: string;

const pool = () => h.db.owner.pool;

const link = (who: Persona, ref: string, body: Record<string, unknown>) =>
  who.client.post<TicketLink & Partial<ApiErrorBody>>(`/v1/tickets/${ref}/links`, body);
const linksOf = async (who: Persona, ref: string) =>
  (await who.client.get<TicketLinkList>(`/v1/tickets/${ref}/links`)).body.items;
const newTicket = (org = orgId) => fileTicket(lead, org);

const events = async (ticketId: string, type: string) =>
  (
    await pool().query<{
      actor_id: string | null;
      visibility: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT actor_id, visibility, payload FROM ticket_event WHERE ticket_id = $1 AND type = $2 ORDER BY created_at`,
      [ticketId, type],
    )
  ).rows;

beforeAll(async () => {
  h = await startHarness();
  lead = await signIn(h, 'lead', undefined, 'Lead One');
  agent = await signIn(h, 'agent', undefined, 'Agent One');
  orgId = (await apiOrg(lead, { name: 'Links Org' })).id;
  otherOrgId = (await apiOrg(lead, { name: 'Other Links Org' })).id;
  client = await signIn(h, 'client', orgId);
});
afterAll(async () => {
  await h.close();
});

describe('who may see and change links', () => {
  it('reading needs ticket.read and writing ticket.handle: a client gets 403, nobody signed in 401', async () => {
    const ticket = await newTicket();
    const other = await newTicket();
    expect((await agent.client.get(`/v1/tickets/${ticket.id}/links`)).status).toBe(200);
    expect((await client.client.get(`/v1/tickets/${ticket.id}/links`)).status).toBe(403);
    expect((await h.client().get(`/v1/tickets/${ticket.id}/links`)).status).toBe(401);
    const body = { kind: 'related', ticketId: other.id };
    expect((await link(client, ticket.id, body)).status).toBe(403);
    expect((await h.client().post(`/v1/tickets/${ticket.id}/links`, body)).status).toBe(401);
    expect(
      (await client.client.delete(`/v1/tickets/${ticket.id}/links/${randomUUID()}`)).status,
    ).toBe(403);
    expect((await h.client().delete(`/v1/tickets/${ticket.id}/links/${randomUUID()}`)).status).toBe(
      401,
    );
  });
});

describe('duplicate', () => {
  it('points from the duplicate to the original, both ways round, by id or by number', async () => {
    const original = await newTicket();
    const copy = await newTicket();
    const created = await link(agent, copy.key, { kind: 'duplicate', ticketId: original.key });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'duplicate',
      relation: 'duplicate_of',
      ticket: {
        id: original.id,
        key: original.key,
        subject: original.subject,
        status: original.status,
      },
      createdBy: { id: agent.userId, name: 'Agent One' },
    });

    expect(await linksOf(agent, copy.id)).toEqual([created.body]);
    const seenFromOriginal = await linksOf(lead, original.key);
    expect(seenFromOriginal).toHaveLength(1);
    expect(seenFromOriginal[0]).toMatchObject({
      id: created.body.id,
      kind: 'duplicate',
      relation: 'has_duplicate',
      ticket: { id: copy.id, key: copy.key },
    });
  });

  it('writes an internal event on both tickets and one audit row, and shows neither to the customer', async () => {
    const original = await newTicket();
    const copy = await newTicket();
    const created = await link(agent, copy.id, { kind: 'duplicate', ticketId: original.id });
    for (const [ticket, peer] of [
      [copy, original],
      [original, copy],
    ] as const) {
      const written = await events(ticket.id, 'ticket.linked');
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        actor_id: agent.userId,
        visibility: 'internal',
        payload: {
          linkId: created.body.id,
          kind: 'duplicate',
          otherTicketId: peer.id,
          otherTicketKey: peer.key,
        },
      });
    }
    const audit = await pool().query<{ actor_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_id, metadata FROM audit_log WHERE action = 'ticket.link' AND target_id = $1`,
      [copy.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_id: agent.userId,
      metadata: { linkId: created.body.id, kind: 'duplicate', otherTicketId: original.id },
    });

    // The customer's own ticket shows no trace of it.
    const mine = await client.client.post<{ id: string }>('/v1/tickets', {
      subject: 'Customer ticket',
      body: 'Please help.',
    });
    await link(agent, mine.body.id, { kind: 'related', ticketId: copy.id }); // different organizations
    const clientOwn = await newTicket();
    await link(agent, clientOwn.id, { kind: 'related', ticketId: original.id });
    const timeline = await timelineOf(client, mine.body.id);
    expect(
      timeline.entries.some((entry: TimelineEntry) => JSON.stringify(entry).includes('linked')),
    ).toBe(false);
  });

  it('is refused the same way twice, and the other way round (409)', async () => {
    const a = await newTicket();
    const b = await newTicket();
    expect((await link(agent, a.id, { kind: 'duplicate', ticketId: b.id })).status).toBe(201);
    const again = await link(agent, a.id, { kind: 'duplicate', ticketId: b.id });
    expect(again.status).toBe(409);
    const reverse = await link(agent, b.id, { kind: 'duplicate', ticketId: a.id });
    expect(reverse.status).toBe(409);
    expect(reverse.body.message).toContain('duplicate');
    // They can still be related.
    expect((await link(agent, b.id, { kind: 'related', ticketId: a.id })).status).toBe(201);
    expect(await linksOf(agent, a.id)).toHaveLength(2);
  });
});

describe('related', () => {
  it('is the same from both tickets, and linking it from the other end is the same link (409)', async () => {
    const a = await newTicket();
    const b = await newTicket();
    const created = await link(agent, a.id, { kind: 'related', ticketId: b.id });
    expect(created.status).toBe(201);
    expect(created.body.relation).toBe('related');
    expect((await linksOf(agent, b.id))[0]).toMatchObject({
      id: created.body.id,
      relation: 'related',
      ticket: { id: a.id },
    });
    expect((await link(agent, b.id, { kind: 'related', ticketId: a.id })).status).toBe(409);
    expect((await link(agent, a.id, { kind: 'related', ticketId: b.id })).status).toBe(409);
    expect(await linksOf(agent, a.id)).toHaveLength(1);
  });

  it('keeps linked tickets as they are: nothing is merged, both stay open with their own status', async () => {
    const a = await newTicket();
    const b = await newTicket();
    await link(agent, a.id, { kind: 'duplicate', ticketId: b.id });
    for (const ticket of [a, b]) {
      const read = await agent.client.get<{ status: string; parentTicketId: string | null }>(
        `/v1/tickets/${ticket.id}`,
      );
      expect(read.body.status).toBe(ticket.status);
      expect(read.body.parentTicketId).toBeNull();
    }
  });
});

describe('what cannot be linked', () => {
  it('refuses itself (400), another organization (409), an unknown ticket (404) and a bad body (400)', async () => {
    const a = await newTicket();
    const far = await newTicket(otherOrgId);
    expect((await link(agent, a.id, { kind: 'related', ticketId: a.id })).status).toBe(400);
    expect((await link(agent, a.key, { kind: 'related', ticketId: a.key })).status).toBe(400);
    const crossOrg = await link(agent, a.id, { kind: 'related', ticketId: far.id });
    expect(crossOrg.status).toBe(409);
    expect(crossOrg.body.message).toContain('organizations');
    expect((await link(agent, a.id, { kind: 'related', ticketId: randomUUID() })).status).toBe(404);
    expect((await link(agent, randomUUID(), { kind: 'related', ticketId: a.id })).status).toBe(404);
    expect((await link(agent, a.id, { kind: 'blocks', ticketId: far.id })).status).toBe(400);
    expect((await link(agent, a.id, { kind: 'related' })).status).toBe(400);
    expect((await link(agent, a.id, { kind: 'related', ticketId: 'not a ticket' })).status).toBe(
      400,
    );
    expect(await linksOf(agent, a.id)).toEqual([]);
    expect(
      (
        await pool().query(
          `SELECT 1 FROM audit_log WHERE action = 'ticket.link' AND outcome = 'success' AND target_id = $1`,
          [a.id],
        )
      ).rowCount,
    ).toBe(0);
  });
});

describe('DELETE /v1/tickets/:id/links/:linkId', () => {
  it('removes the link from either end, with an event on both tickets and an audit row', async () => {
    const a = await newTicket();
    const b = await newTicket();
    const created = await link(agent, a.id, { kind: 'duplicate', ticketId: b.id });
    // Removed from the other end than it was made.
    const removed = await lead.client.delete(`/v1/tickets/${b.id}/links/${created.body.id}`);
    expect(removed.status).toBe(204);
    expect(await linksOf(agent, a.id)).toEqual([]);
    expect(await linksOf(agent, b.id)).toEqual([]);
    for (const ticket of [a, b]) {
      const gone = await events(ticket.id, 'ticket.unlinked');
      expect(gone).toHaveLength(1);
      expect(gone[0]).toMatchObject({ actor_id: lead.userId, visibility: 'internal' });
    }
    const audit = await pool().query<{ actor_id: string }>(
      `SELECT actor_id FROM audit_log WHERE action = 'ticket.unlink' AND target_id = $1`,
      [b.id],
    );
    expect(audit.rows).toEqual([{ actor_id: lead.userId }]);
    // And the pair can be linked again.
    expect((await link(agent, a.id, { kind: 'duplicate', ticketId: b.id })).status).toBe(201);
  });

  it('is 404 for a link that does not exist or belongs to two other tickets', async () => {
    const a = await newTicket();
    const b = await newTicket();
    const c = await newTicket();
    const created = await link(agent, b.id, { kind: 'related', ticketId: c.id });
    expect((await agent.client.delete(`/v1/tickets/${a.id}/links/${created.body.id}`)).status).toBe(
      404,
    );
    expect((await agent.client.delete(`/v1/tickets/${a.id}/links/${randomUUID()}`)).status).toBe(
      404,
    );
    expect((await agent.client.delete(`/v1/tickets/${a.id}/links/not-a-uuid`)).status).toBe(400);
    expect(await linksOf(agent, b.id)).toHaveLength(1);
  });
});
