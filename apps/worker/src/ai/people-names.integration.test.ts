import { schema } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_PEOPLE_NAMES, ticketPeopleNames } from './people-names.js';

// QA-30 (b): the redactor of an AI run must know the requester and the people of the organization,
// whatever else is true of the ticket. Throwaway Postgres only (TEST_DATABASE_URL).
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
let orgId = '';
let otherOrgId = '';
let requesterId = '';
let strangerId = '';

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  const db = testDb.owner.db;
  const orgs = await db
    .insert(schema.organization)
    .values([{ name: 'Acme' }, { name: 'Other' }])
    .returning();
  orgId = orgs[0]?.id ?? '';
  otherOrgId = orgs[1]?.id ?? '';
  // More contacts than the old cap of 200 (in no order), so the requester is not among "the first".
  await db.insert(schema.contact).values(
    Array.from({ length: 250 }, (_, index) => ({
      orgId,
      name: `Filler Person ${String(index).padStart(3, '0')}`,
      emails: [`filler${String(index)}@customer.example.test`],
    })),
  );
  const [requester] = await db
    .insert(schema.contact)
    .values({ orgId, name: 'Somchai Jaidee', emails: ['somchai@customer.example.test'] })
    .returning();
  requesterId = requester?.id ?? '';
  const [stranger] = await db
    .insert(schema.contact)
    .values({ orgId: otherOrgId, name: 'Nattaya Wong', emails: ['nattaya@other.example.test'] })
    .returning();
  strangerId = stranger?.id ?? '';
  await db.insert(schema.users).values([
    { email: 'portal.user@customer.example.test', name: 'portal.user', role: 'client', orgId },
    { email: 'agent@watchtower.example.test', name: 'Agent Smith', role: 'agent' },
    {
      email: 'client2@other.example.test',
      name: 'Other Client',
      role: 'client',
      orgId: otherOrgId,
    },
  ]);
});

afterAll(async () => {
  await testDb.cleanup();
});

describe('ticketPeopleNames', () => {
  it('always has the requester, even in an organization with more contacts than the old cap', async () => {
    const names = await ticketPeopleNames(testDb.owner.db, {
      orgId,
      requesterContactId: requesterId,
    });
    expect(names).toContain('Somchai Jaidee');
    expect(names[0]).toBe('Somchai Jaidee');
    expect(names.length).toBeGreaterThan(250);
    expect(names.length).toBeLessThanOrEqual(2 * MAX_PEOPLE_NAMES + 1);
  });

  it('has the requester from another organization and the client users of this one, not staff', async () => {
    const names = await ticketPeopleNames(testDb.owner.db, {
      orgId,
      requesterContactId: strangerId,
    });
    expect(names).toContain('Nattaya Wong');
    expect(names).toContain('portal.user');
    expect(names).not.toContain('Agent Smith');
    expect(names).not.toContain('Other Client');
  });

  it('works with no requester', async () => {
    const names = await ticketPeopleNames(testDb.owner.db, { orgId, requesterContactId: null });
    expect(names).toContain('Somchai Jaidee');
  });
});
