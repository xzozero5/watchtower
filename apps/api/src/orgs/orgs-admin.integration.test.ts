import type { Contact, Organization, OrgTierList } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, uniqueEmail, type Harness } from '../testing/harness.js';
import { apiOrg, signIn, type Page, type Persona } from '../testing/ticketing.js';

// T-127: contact count per organization, and the read-only tier list for the admin pages.

let h: Harness;
let lead: Persona;
let agent: Persona;
let client: Persona;
let org: Organization;
let emptyOrg: Organization;

const addContact = (orgId: string, name: string) =>
  lead.client.post<Contact>('/v1/contacts', { orgId, name, emails: [uniqueEmail('contact')] });

beforeAll(async () => {
  h = await startHarness();
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  org = await apiOrg(lead, { name: 'Count org' });
  emptyOrg = await apiOrg(lead, { name: 'Empty org' });
  client = await signIn(h, 'client', org.id);
});
afterAll(async () => {
  await h.close();
});

describe('contactCount on organizations', () => {
  it('is 0 for a new organization, in the create answer and in the list', async () => {
    expect(org.contactCount).toBe(0);
    const list = await lead.client.get<Page<Organization>>('/v1/orgs');
    expect(list.body.items.find((row) => row.id === emptyOrg.id)?.contactCount).toBe(0);
  });

  it('counts the contacts of each organization separately, in one list answer', async () => {
    expect((await addContact(org.id, 'First Contact')).status).toBe(201);
    expect((await addContact(org.id, 'Second Contact')).status).toBe(201);
    expect((await addContact(emptyOrg.id, 'Lonely Contact')).status).toBe(201);

    const list = await lead.client.get<Page<Organization>>('/v1/orgs?limit=200');
    expect(list.body.items.find((row) => row.id === org.id)?.contactCount).toBe(2);
    expect(list.body.items.find((row) => row.id === emptyOrg.id)?.contactCount).toBe(1);

    const one = await agent.client.get<Organization>(`/v1/orgs/${org.id}`);
    expect(one.body.contactCount).toBe(2);

    const edited = await lead.client.patch<Organization>(`/v1/orgs/${org.id}`, { notes: 'hello' });
    expect(edited.body.contactCount).toBe(2);
  });

  it('follows a deleted contact', async () => {
    const extra = await addContact(emptyOrg.id, 'Short lived');
    expect((await lead.client.delete(`/v1/contacts/${extra.body.id}`)).status).toBe(204);
    const one = await lead.client.get<Organization>(`/v1/orgs/${emptyOrg.id}`);
    expect(one.body.contactCount).toBe(1);
  });

  it('is not shown to a client, who sees their own organization with a null count', async () => {
    const list = await client.client.get<Page<Organization>>('/v1/orgs');
    expect(list.body.items.map((row) => row.id)).toEqual([org.id]);
    expect(list.body.items[0]?.contactCount).toBeNull();
    const one = await client.client.get<Organization>(`/v1/orgs/${org.id}`);
    expect(one.body.contactCount).toBeNull();
  });
});

describe('GET /v1/org-tiers', () => {
  it('lists the tiers in display order for staff', async () => {
    for (const who of [agent, lead]) {
      const response = await who.client.get<OrgTierList>('/v1/org-tiers');
      expect(response.status).toBe(200);
      expect(response.body.tiers).toEqual([
        { slug: 'gold', name: 'Gold', sortOrder: 10 },
        { slug: 'silver', name: 'Silver', sortOrder: 20 },
        { slug: 'standard', name: 'Standard', sortOrder: 30 },
      ]);
    }
  });

  it('includes a tier added later, in its place', async () => {
    await h.db.owner.pool.query(
      `INSERT INTO org_tier (slug, name, sort_order) VALUES ('platinum', 'Platinum', 5)`,
    );
    const response = await lead.client.get<OrgTierList>('/v1/org-tiers');
    expect(response.body.tiers.map((tier) => tier.slug)).toEqual([
      'platinum',
      'gold',
      'silver',
      'standard',
    ]);
  });

  it('is closed to a client and to anyone not signed in', async () => {
    expect((await client.client.get('/v1/org-tiers')).status).toBe(403);
    expect((await h.client().get('/v1/org-tiers')).status).toBe(401);
  });
});
