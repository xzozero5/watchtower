import type { OrgTierList, OrgTierRecord, Organization } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { apiOrg, signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';

// T-121b: the head adds, renames, reorders and deletes organization tiers.

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let client: Persona;

const tiers = async (): Promise<string[]> =>
  (await head.client.get<OrgTierList>('/v1/org-tiers')).body.tiers.map((tier) => tier.slug);

const auditRows = async (action: string, targetId: string) =>
  (
    await h.db.owner.pool.query<{
      actor_id: string;
      outcome: string;
      before: unknown;
      after: unknown;
    }>(
      `SELECT actor_id, outcome, before, after FROM audit_log WHERE action = $1 AND target_id = $2 ORDER BY created_at`,
      [action, targetId],
    )
  ).rows;

beforeAll(async () => {
  h = await startHarness();
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  client = await signIn(h, 'client', (await apiOrg(lead, { name: 'Tier client org' })).id);
});
afterAll(async () => {
  await h.close();
});

describe('who may change tiers', () => {
  it('is the head (sla.manage); lead, agent and client get 403, nobody signed in gets 401', async () => {
    const body = { slug: 'rbac-probe', name: 'Probe' };
    expect((await lead.client.post('/v1/org-tiers', body)).status).toBe(403);
    expect((await agent.client.post('/v1/org-tiers', body)).status).toBe(403);
    expect((await client.client.post('/v1/org-tiers', body)).status).toBe(403);
    expect((await h.client().post('/v1/org-tiers', body)).status).toBe(401);
    expect((await lead.client.patch('/v1/org-tiers/gold', { name: 'X' })).status).toBe(403);
    expect((await agent.client.patch('/v1/org-tiers/gold', { name: 'X' })).status).toBe(403);
    expect((await h.client().patch('/v1/org-tiers/gold', { name: 'X' })).status).toBe(401);
    expect((await lead.client.delete('/v1/org-tiers/gold')).status).toBe(403);
    expect((await client.client.delete('/v1/org-tiers/gold')).status).toBe(403);
    expect((await h.client().delete('/v1/org-tiers/gold')).status).toBe(401);
    // Nothing happened.
    expect(await tiers()).toEqual(['gold', 'silver', 'standard']);
  });
});

describe('POST /v1/org-tiers', () => {
  it('adds a tier in its place, audited, and organizations can use it at once', async () => {
    const created = await head.client.post<OrgTierRecord>('/v1/org-tiers', {
      slug: 'platinum',
      name: 'Platinum',
      sortOrder: 5,
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ slug: 'platinum', name: 'Platinum', sortOrder: 5 });
    expect(await tiers()).toEqual(['platinum', 'gold', 'silver', 'standard']);

    const org = await apiOrg(lead, { name: 'Platinum customer', tier: 'platinum' });
    expect(org.tier).toBe('platinum');

    const rows = await auditRows('org_tier.create', 'platinum');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: head.userId,
      outcome: 'success',
      after: { slug: 'platinum', name: 'Platinum', sortOrder: 5 },
    });
  });

  it('refuses a slug that exists (409) and one that is not a slug (400)', async () => {
    const again = await head.client.post<ApiErrorBody>('/v1/org-tiers', {
      slug: 'gold',
      name: 'Another gold',
    });
    expect(again.status).toBe(409);
    for (const slug of ['Has Space', '1abc', '', 'x'.repeat(40)]) {
      expect((await head.client.post('/v1/org-tiers', { slug, name: 'Bad' })).status).toBe(400);
    }
    expect((await head.client.post('/v1/org-tiers', { slug: 'ok-name', name: '  ' })).status).toBe(
      400,
    );
  });
});

describe('PATCH /v1/org-tiers/:slug', () => {
  it('renames a tier everywhere it is used, and records before and after', async () => {
    await head.client.post('/v1/org-tiers', { slug: 'bronze', name: 'Bronze', sortOrder: 40 });
    const org = await apiOrg(lead, { name: 'Bronze customer', tier: 'bronze' });
    const updated = await head.client.patch<OrgTierRecord>('/v1/org-tiers/bronze', {
      slug: 'copper',
      name: 'Copper',
      sortOrder: 45,
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({ slug: 'copper', name: 'Copper', sortOrder: 45 });
    const read = await lead.client.get<Organization>(`/v1/orgs/${org.id}`);
    expect(read.body.tier).toBe('copper');
    expect(await tiers()).toContain('copper');
    expect(await tiers()).not.toContain('bronze');

    const rows = await auditRows('org_tier.update', 'copper');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      before: { slug: 'bronze', name: 'Bronze', sortOrder: 40 },
      after: { slug: 'copper', name: 'Copper', sortOrder: 45 },
    });
  });

  it('reorders and renames the display name of the default tier but not its slug', async () => {
    const renamed = await head.client.patch<OrgTierRecord>('/v1/org-tiers/standard', {
      name: 'Standard plan',
      sortOrder: 31,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ slug: 'standard', name: 'Standard plan', sortOrder: 31 });
    const slug = await head.client.patch<ApiErrorBody>('/v1/org-tiers/standard', {
      slug: 'basic',
    });
    expect(slug.status).toBe(409);
  });

  it('answers 404 for an unknown tier, 409 for a slug that is taken and 400 for nothing to change', async () => {
    expect((await head.client.patch('/v1/org-tiers/nope', { name: 'X' })).status).toBe(404);
    expect((await head.client.patch('/v1/org-tiers/silver', { slug: 'gold' })).status).toBe(409);
    expect((await head.client.patch('/v1/org-tiers/silver', {})).status).toBe(400);
  });
});

describe('DELETE /v1/org-tiers/:slug', () => {
  it('deletes a tier nobody uses, audited', async () => {
    await head.client.post('/v1/org-tiers', { slug: 'temp', name: 'Temp' });
    expect((await head.client.delete('/v1/org-tiers/temp')).status).toBe(204);
    expect(await tiers()).not.toContain('temp');
    const rows = await auditRows('org_tier.delete', 'temp');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: head.userId,
      before: { slug: 'temp', name: 'Temp' },
    });
  });

  it('refuses while an organization or an SLA policy uses the tier (409), and the default tier', async () => {
    await head.client.post('/v1/org-tiers', { slug: 'inuse', name: 'In use' });
    await apiOrg(lead, { name: 'Uses it', tier: 'inuse' });
    const refused = await head.client.delete<ApiErrorBody>('/v1/org-tiers/inuse');
    expect(refused.status).toBe(409);
    expect(await tiers()).toContain('inuse');

    // A tier that an SLA policy is the default for.
    await head.client.post('/v1/org-tiers', { slug: 'sla-only', name: 'SLA only' });
    await h.db.owner.pool.query(
      `INSERT INTO sla_policy (name, tier, targets) VALUES ('Policy for sla-only', 'sla-only',
         '{"P1":{"first_response_min":15,"resolution_min":240},"P2":{"first_response_min":30,"resolution_min":480},"P3":{"first_response_min":60,"resolution_min":1440},"P4":{"first_response_min":240,"resolution_min":4320}}'::jsonb)`,
    );
    expect((await head.client.delete('/v1/org-tiers/sla-only')).status).toBe(409);

    expect((await head.client.delete('/v1/org-tiers/standard')).status).toBe(409);
    expect((await head.client.delete('/v1/org-tiers/nope')).status).toBe(404);
    // Failed attempts are on the audit log as failures.
    const rows = await auditRows('org_tier.delete', 'inuse');
    expect(rows.map((row) => row.outcome)).toEqual(['failure']);
  });
});
