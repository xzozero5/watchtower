import { seedIntents } from '@watchtower/db';
import type { TicketSummary } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import {
  apiOrg,
  fileTicket,
  signIn,
  timelineOf,
  type Page,
  type Persona,
} from '../testing/ticketing.js';

// An instance with its own ticket key prefix (TICKET_KEY_PREFIX=SUP): every key the api writes or
// reads uses it, and the default OPS is just another unknown prefix.

let h: Harness;
let agent: Persona;
let orgId: string;

beforeAll(async () => {
  h = await startHarness({ env: { TICKET_KEY_PREFIX: 'sup' } });
  await seedIntents(h.db.owner.db);
  const lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  orgId = (await apiOrg(lead)).id;
});

afterAll(async () => {
  await h.close();
});

describe('TICKET_KEY_PREFIX=sup', () => {
  it('numbers tickets SUP-n, in lists, details, merges and the timeline', async () => {
    const a = await fileTicket(agent, orgId, { subject: 'First needle' });
    const b = await fileTicket(agent, orgId, { subject: 'Second' });
    expect(a.key).toBe(`SUP-${String(a.number)}`);

    const merged = await agent.client.post<{ source: { mergedIntoKey: string } }>(
      `/v1/tickets/${a.id}/merge`,
      { intoTicketId: b.key },
    );
    expect(merged.status).toBe(200);
    expect(merged.body.source.mergedIntoKey).toBe(b.key);

    const list = await agent.client.get<Page<TicketSummary>>(`/v1/tickets?orgId=${orgId}`);
    expect(list.body.items.every((item) => item.key.startsWith('SUP-'))).toBe(true);
    const timeline = await timelineOf(agent, b.id);
    expect(timeline.entries.every((entry) => entry.ticketKey.startsWith('SUP-'))).toBe(true);
    const mergedEvent = timeline.entries.find(
      (entry) => entry.kind === 'event' && entry.type === 'ticket.merged',
    );
    expect(mergedEvent).toMatchObject({ payload: { intoKey: b.key } });
  });

  it('finds a ticket by its key in any case, and by number in the search box', async () => {
    const ticket = await fileTicket(agent, orgId, { subject: 'Addressed by key' });
    const byKey = await agent.client.get<{ id: string }>(`/v1/tickets/${ticket.key.toLowerCase()}`);
    expect(byKey.status).toBe(200);
    expect(byKey.body.id).toBe(ticket.id);
    const found = await agent.client.get<Page<TicketSummary>>(
      `/v1/tickets?orgId=${orgId}&q=${ticket.key.toLowerCase()}`,
    );
    expect(found.body.items.map((item) => item.id)).toContain(ticket.id);
  });

  it('answers 404 to a key of another prefix, never a database error', async () => {
    const ticket = await fileTicket(agent, orgId);
    expect((await agent.client.get(`/v1/tickets/OPS-${String(ticket.number)}`)).status).toBe(404);
    expect((await agent.client.get('/v1/tickets/XYZ-12345')).status).toBe(404);
    expect((await agent.client.get('/v1/tickets/not-a-key')).status).toBe(400);
  });
});
