import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOrg, startHarness, type Harness } from '../testing/harness.js';
import { fileClientTicket, signIn, type Persona } from '../testing/ticketing.js';

// Review of T-200: an internal ticket (a usage anomaly, an alert follow-up) belongs to an organization
// but is for staff only. A client of that very organization must not find it by any route.
const net = disableNetConnect();

let h: Harness;
let head: Persona;
let client: Persona;
let outsider: Persona;
let internalId = '';
let internalKey = '';
let portalKey = '';

beforeAll(async () => {
  h = await startHarness();
  head = await signIn(h, 'head');
  const orgId = await createOrg(h.db.owner.pool);
  client = await signIn(h, 'client', orgId);
  outsider = await signIn(h, 'client', await createOrg(h.db.owner.pool));
  const created = await h.db.owner.pool.query<{ id: string; number: string }>(
    `INSERT INTO ticket (subject, org_id, channel, status, intent_id)
     VALUES ('Usage anomaly in the client organization', $1, 'internal', 'open',
             (SELECT id FROM intent LIMIT 1))
     RETURNING id, number`,
    [orgId],
  );
  internalId = created.rows[0]?.id ?? '';
  internalKey = `OPS-${created.rows[0]?.number ?? ''}`;
  const own = await fileClientTicket(client);
  portalKey = own.key;
});
afterAll(async () => {
  await h.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

describe('a client of the same organization', () => {
  it('does not see it in the list or the search', async () => {
    const list = await client.client.get<{ items: { id: string; key: string }[] }>('/v1/tickets');
    expect(list.status).toBe(200);
    expect(list.body.items.map((item) => item.key)).toEqual([portalKey]);
    const search = await client.client.get<{ items: { id: string }[] }>('/v1/tickets?q=anomaly');
    expect(search.body.items).toEqual([]);
  });

  it.each([
    ['by id', () => internalId],
    ['by key', () => internalKey],
  ])('gets 404 when it opens it %s', async (_label, ref) => {
    expect((await client.client.get(`/v1/tickets/${ref()}`)).status).toBe(404);
    expect((await client.client.get(`/v1/tickets/${ref()}/timeline`)).status).toBe(404);
    expect((await client.client.get(`/v1/tickets/${ref()}/duplicates`)).status).toBe(404);
  });

  it('cannot reply on it', async () => {
    const response = await client.client.post(`/v1/tickets/${internalId}/replies`, {
      body: 'Hello?',
    });
    expect(response.status).toBe(404);
    const messages = await h.db.owner.pool.query('SELECT 1 FROM message WHERE ticket_id = $1', [
      internalId,
    ]);
    expect(messages.rowCount).toBe(0);
  });

  it('still sees its own ticket', async () => {
    expect((await client.client.get(`/v1/tickets/${portalKey}`)).status).toBe(200);
  });
});

describe('staff', () => {
  it('see it, with the internal channel', async () => {
    const detail = await head.client.get<{ channel: string; key: string }>(
      `/v1/tickets/${internalId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.channel).toBe('internal');
    const list = await head.client.get<{ items: { key: string; channel: string }[] }>(
      '/v1/tickets?channel=internal',
    );
    expect(list.body.items.map((item) => item.key)).toEqual([internalKey]);
  });

  it('cannot send a public reply on it: there is no customer, a note is the way', async () => {
    const reply = await head.client.post(`/v1/tickets/${internalId}/replies`, { body: 'Hi' });
    expect(reply.status).toBe(400);
    const note = await head.client.post(`/v1/tickets/${internalId}/notes`, { body: 'Checking' });
    expect(note.status).toBe(201);
  });
});

describe('a client of another organization', () => {
  it('is no better off', async () => {
    expect((await outsider.client.get(`/v1/tickets/${internalId}`)).status).toBe(404);
  });
});
