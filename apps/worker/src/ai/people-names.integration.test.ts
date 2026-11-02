import { schema } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WorkerLogger } from '../logger.js';
import { ticketPeopleNames, warnIfIncomplete } from './people-names.js';

// QA-30 (b): the redactor of an AI run must know the requester and the people of the organization,
// whatever else is true of the ticket. Throwaway Postgres only (TEST_DATABASE_URL).
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
let orgId = '';
let otherOrgId = '';
let requesterId = '';
let strangerId = '';
let senderId = '';
let ticketId = '';

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
  const [sender] = await db
    .insert(schema.contact)
    .values({ orgId: otherOrgId, name: 'Prasert Meechai', emails: ['prasert@other.example.test'] })
    .returning();
  senderId = sender?.id ?? '';
  const [ticket] = await db
    .insert(schema.ticket)
    .values({ orgId, subject: 'Export fails', requesterContactId: requesterId })
    .returning();
  ticketId = ticket?.id ?? '';
  await db.insert(schema.message).values({
    ticketId,
    direction: 'inbound',
    senderContactId: senderId,
    bodyText: 'hello',
    visibility: 'public',
  });
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
  const ticketOf = (requesterContactId: string | null) => ({
    id: ticketId,
    orgId,
    requesterContactId,
  });

  it('always has the requester, even in an organization with more contacts than the old cap', async () => {
    const { names, complete } = await ticketPeopleNames(testDb.owner.db, ticketOf(requesterId));
    expect(complete).toBe(true);
    expect(names[0]).toBe('Somchai Jaidee');
    expect(names.length).toBeGreaterThan(250);
  });

  it('has the requester from another organization and the client users of this one, not staff', async () => {
    const { names } = await ticketPeopleNames(testDb.owner.db, ticketOf(strangerId));
    expect(names).toContain('Nattaya Wong');
    expect(names).toContain('portal.user');
    expect(names).not.toContain('Agent Smith');
    expect(names).not.toContain('Other Client');
  });

  it('has every contact that sent a message on the ticket, whatever organization it belongs to', async () => {
    const { names } = await ticketPeopleNames(testDb.owner.db, ticketOf(null));
    expect(names).toContain('Prasert Meechai');
    expect(names).toContain('Somchai Jaidee');
  });

  it('says so when the list is cut short, and keeps the requester and senders', async () => {
    const { names, complete } = await ticketPeopleNames(
      testDb.owner.db,
      ticketOf(requesterId),
      100,
    );
    expect(complete).toBe(false);
    expect(names).toContain('Somchai Jaidee');
    expect(names).toContain('Prasert Meechai');
    expect(names.length).toBeLessThanOrEqual(100 + 100 + 2);
  });
});

describe('warnIfIncomplete', () => {
  it('warns once, without a name, only for an incomplete list', () => {
    const calls: unknown[][] = [];
    const logger = { warn: (...args: unknown[]) => calls.push(args) } as unknown as WorkerLogger;
    warnIfIncomplete(logger, 't1', { names: ['Somchai'], complete: true });
    expect(calls).toHaveLength(0);
    warnIfIncomplete(logger, 't1', { names: ['Somchai'], complete: false });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toContain('Somchai');
  });
});
