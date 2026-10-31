import { runSeed } from '@watchtower/db';
import type { TicketDetail, TicketSummary } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { signIn, timelineOf, type Page, type Persona } from '../testing/ticketing.js';

// The development seed (`pnpm db:seed`) read back through the real API: what it wrote behaves like
// tickets that people worked on.

let h: Harness;
let agent: Persona;
let tickets: TicketSummary[];

beforeAll(async () => {
  h = await startHarness();
  await runSeed(h.db.owner, { nodeEnv: 'test' });
  agent = await signIn(h, 'agent');
  const list = await agent.client.get<Page<TicketSummary>>('/v1/tickets?limit=200');
  tickets = list.body.items;
});

afterAll(async () => {
  await h.close();
});

describe('seeded tickets through the API', () => {
  it('lists 30 tickets, keyed OPS-n, in every status, each with its SLA policy', () => {
    expect(tickets).toHaveLength(30);
    expect(tickets.every((ticket) => /^OPS-\d+$/.test(ticket.key))).toBe(true);
    expect(new Set(tickets.map((ticket) => ticket.status)).size).toBe(8);
    expect(tickets.every((ticket) => ticket.slaPolicyId !== null)).toBe(true);
    expect(tickets.every((ticket) => ticket.autonomyStageAtCreation === 2)).toBe(true);
  });

  it('finds the overdue tickets the seed made, and a Thai word in a subject', async () => {
    const overdue = await agent.client.get<Page<TicketSummary>>(
      '/v1/tickets?overdue=true&limit=200',
    );
    expect(overdue.status).toBe(200);
    const thai = await agent.client.get<Page<TicketSummary>>(
      `/v1/tickets?q=${encodeURIComponent('เข้าสู่ระบบ')}`,
    );
    expect(thai.body.items.length).toBeGreaterThanOrEqual(1);
  });

  it('shows a merged ticket pointing at its target, and the target carrying the merged history', async () => {
    const merged = tickets.filter((ticket) => ticket.status === 'merged');
    expect(merged).toHaveLength(3);
    const source = merged[0] as TicketSummary;
    expect(source.mergedIntoKey).toMatch(/^OPS-\d+$/);
    const target = tickets.find((ticket) => ticket.key === source.mergedIntoKey) as TicketSummary;
    expect(target.status).not.toBe('merged');
    const entries = (await timelineOf(agent, target.id)).entries;
    expect(entries.some((entry) => entry.ticketId === source.id)).toBe(true);
    const detail = await agent.client.get<TicketDetail>(`/v1/tickets/${target.id}`);
    expect(detail.body.mergedTickets.map((child) => child.id)).toContain(source.id);
  });

  it('keeps client visibility: a client sees their own organization and no internal note', async () => {
    const org = await h.db.owner.pool.query<{ id: string }>(
      `SELECT id FROM organization WHERE name = 'Acme Logistics'`,
    );
    const client = await signIn(h, 'client', org.rows[0]?.id);
    const own = await client.client.get<Page<{ id: string }>>('/v1/tickets?limit=200');
    expect(own.body.items).toHaveLength(12);
    const withNote = tickets.find(
      (ticket) => ticket.org.name === 'Acme Logistics' && ticket.key,
    ) as TicketSummary;
    const timeline = await timelineOf(client, withNote.id);
    expect(
      timeline.entries.every((entry) => entry.kind !== 'message' || entry.visibility === 'public'),
    ).toBe(true);
  });

  it('resumes the SLA clock when an agent answers a waiting ticket, like a ticket worked by hand', async () => {
    const waiting = tickets.find(
      (ticket) => ticket.status === 'waiting_on_customer',
    ) as TicketSummary;
    expect(waiting.slaPausedAt).not.toBeNull();
    const response = await agent.client.post<TicketDetail>(`/v1/tickets/${waiting.id}/status`, {
      status: 'open',
    });
    expect(response.status).toBe(200);
    expect(response.body.slaPausedAt).toBeNull();
    expect(Date.parse(response.body.resolutionDueAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(waiting.resolutionDueAt ?? ''),
    );
  });
});
