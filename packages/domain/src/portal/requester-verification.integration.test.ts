import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadAutoSendFacts } from '../autonomy/autosend-facts.js';
import { addIntent, addOrg, startDomainTest, type DomainTestEnv } from '../testing/support.js';
import { markPortalRequesterVerified } from './requester-verification.js';

// Proof of mailbox ownership for portal tickets (T-306h), on the real database through the restricted
// application role, and what the stage 3 gate then sees.
let env: DomainTestEnv;
let orgId: string;
let intentId: string;

beforeAll(async () => {
  env = await startDomainTest();
  orgId = (await addOrg(env, { name: 'Acme Proof' })).id;
  intentId = (await addIntent(env)).id;
});
afterAll(async () => {
  await env.close();
});

async function addContact(verified: boolean) {
  const [row] = await env.db.owner.db
    .insert(schema.contact)
    .values({
      orgId,
      name: 'Somchai',
      emails: [`${randomUUID()}@acme.example.test`],
      ...(verified ? { verifiedAt: new Date() } : {}),
    })
    .returning();
  if (!row) throw new Error('no contact');
  return row;
}

async function addTicket(
  contactId: string,
  channel: 'portal' | 'gmail',
  customFields: Record<string, unknown> = { portal: { requesterVerified: false, category: 'x' } },
) {
  const [row] = await env.db.owner.db
    .insert(schema.ticket)
    .values({ subject: 'S', orgId, requesterContactId: contactId, channel, intentId, customFields })
    .returning();
  if (!row) throw new Error('no ticket');
  return row;
}

async function portalOf(ticketId: string): Promise<Record<string, unknown>> {
  const [row] = await env.db.owner.db
    .select({ fields: schema.ticket.customFields })
    .from(schema.ticket)
    .where(eq(schema.ticket.id, ticketId));
  return (row?.fields as { portal: Record<string, unknown> }).portal;
}

async function gateSeesVerified(ticketId: string): Promise<boolean | null> {
  const loaded = await loadAutoSendFacts(
    env.database.db,
    {
      ticketId,
      aiDraftId: randomUUID(),
      aiGradeId: randomUUID(),
      text: 'hello',
      attachmentCount: 0,
      hasHtml: false,
    },
    { flagOn: false, linkOrigins: [], aiBudgetExceeded: () => Promise.resolve(false) },
  );
  return loaded.facts.disclosure?.contactVerified ?? null;
}

describe('markPortalRequesterVerified', () => {
  it('verifies the portal tickets that exist, not one filed afterwards, and the gate sees exactly that', async () => {
    const contact = await addContact(true);
    const first = await addTicket(contact.id, 'portal');
    const second = await addTicket(contact.id, 'portal');
    // The contact is verified (staff side), yet the gate does not trust the typed address.
    expect(await gateSeesVerified(first.id)).toBe(false);

    const ids = await env.tx((tx) => markPortalRequesterVerified(tx, { contactId: contact.id }));
    expect([...ids].sort()).toEqual([first.id, second.id].sort());
    const later = await addTicket(contact.id, 'portal');

    expect(await portalOf(first.id)).toMatchObject({
      requesterVerified: true,
      category: 'x',
    });
    expect(typeof (await portalOf(first.id)).requesterVerifiedAt).toBe('string');
    expect(await portalOf(later.id)).toMatchObject({ requesterVerified: false });
    expect(await gateSeesVerified(first.id)).toBe(true);
    expect(await gateSeesVerified(later.id)).toBe(false);
  });

  it('is idempotent: a second call changes nothing and keeps the first timestamp', async () => {
    const contact = await addContact(false);
    const ticket = await addTicket(contact.id, 'portal');
    expect(
      await env.tx((tx) => markPortalRequesterVerified(tx, { contactId: contact.id })),
    ).toEqual([ticket.id]);
    const stamp = (await portalOf(ticket.id)).requesterVerifiedAt;
    expect(
      await env.tx((tx) => markPortalRequesterVerified(tx, { contactId: contact.id })),
    ).toEqual([]);
    expect((await portalOf(ticket.id)).requesterVerifiedAt).toBe(stamp);
  });

  it('with a ticket id touches that ticket only, and never another contact, channel or a ticket without portal fields', async () => {
    const contact = await addContact(false);
    const other = await addContact(false);
    const target = await addTicket(contact.id, 'portal');
    const sibling = await addTicket(contact.id, 'portal');
    const foreign = await addTicket(other.id, 'portal');
    const mail = await addTicket(contact.id, 'gmail', { portal: { requesterVerified: false } });
    const bare = await addTicket(contact.id, 'portal', {});

    const ids = await env.tx((tx) =>
      markPortalRequesterVerified(tx, { contactId: contact.id, ticketId: target.id }),
    );
    expect(ids).toEqual([target.id]);
    expect(await portalOf(sibling.id)).toMatchObject({ requesterVerified: false });
    expect(await portalOf(foreign.id)).toMatchObject({ requesterVerified: false });

    // The contact-wide call leaves the email ticket and the one without a portal object alone.
    await env.tx((tx) => markPortalRequesterVerified(tx, { contactId: contact.id }));
    expect(await portalOf(mail.id)).toMatchObject({ requesterVerified: false });
    const [row] = await env.db.owner.db
      .select({ fields: schema.ticket.customFields })
      .from(schema.ticket)
      .where(eq(schema.ticket.id, bare.id));
    expect(row?.fields).toEqual({});
    // A ticket id of another contact is not reachable through this contact.
    expect(
      await env.tx((tx) =>
        markPortalRequesterVerified(tx, { contactId: contact.id, ticketId: foreign.id }),
      ),
    ).toEqual([]);
  });
});
