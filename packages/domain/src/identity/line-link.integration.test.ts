import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import { AUDIT_ACTIONS } from '@watchtower/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UNIDENTIFIED_ORG_ID } from '../inbound/identity.js';
import type { NormalisedInboundMessage } from '../inbound/types.js';
import {
  addOrg,
  addPolicy,
  addStaff,
  auditRows,
  startDomainTest,
  type DomainTestEnv,
} from '../testing/support.js';
import type { Actor } from '../types.js';
import { generateLinkCode, parseLinkCode } from './line-link.js';

// Link codes and the link itself, on the real database through the restricted application role.
let env: DomainTestEnv;
let lineId: string;
let orgId: string;
let staff: { id: string; actor: Actor };
const SYSTEM: Actor = { type: 'system', id: null };
const clock = { now: new Date('2026-11-02T03:00:00Z') };
const at = (seconds: number): Date => new Date(clock.now.getTime() + seconds * 1000);

beforeAll(async () => {
  env = await startDomainTest({ now: () => clock.now });
  await addPolicy(env, { P3: { first_response_min: 60, resolution_min: 240, calendar: '24x7' } });
  const [account] = await env.db.owner.db
    .insert(schema.channelAccount)
    .values({ type: 'line', name: 'Support LINE OA' })
    .returning();
  lineId = account?.id ?? '';
  orgId = (await addOrg(env, { name: 'Acme Link' })).id;
  staff = await addStaff(env, 'agent');
});
afterAll(async () => {
  await env.close();
});

const lineUser = () => `Ufake${randomUUID().replaceAll('-', '')}`;

async function addContact(fields: Partial<typeof schema.contact.$inferInsert> = {}) {
  const [row] = await env.db.owner.db
    .insert(schema.contact)
    .values({ orgId, name: 'Somchai', emails: [`${randomUUID()}@acme.example.test`], ...fields })
    .returning();
  if (!row) throw new Error('no contact');
  return row;
}

function lineMessage(userId: string, text: string): NormalisedInboundMessage {
  return {
    channelAccountId: lineId,
    providerMessageId: `l-${randomUUID()}`,
    rfc822MessageId: null,
    threadKey: `line:${userId}`,
    threadCandidates: [{ kind: 'line_conversation', value: userId }],
    from: { address: null, name: null, lineUserId: userId },
    subject: '',
    bodyText: text,
    bodyHtml: null,
    attachments: [],
    receivedAt: clock.now,
    rawObjectKey: null,
    automated: { disposition: 'human', subtype: 'none', signals: [] },
  };
}

const issue = (contactId: string, ttlSeconds?: number) =>
  env.tx((tx) =>
    env.domain.identity.issueLineLinkCode(tx, env.ctx(staff.actor), {
      contactId,
      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
    }),
  );
const redeem = (code: string, lineUserId: string) =>
  env.tx((tx) => env.domain.identity.redeemLineLinkCode(tx, env.ctx(SYSTEM), { code, lineUserId }));

describe('issueLineLinkCode', () => {
  it('stores only a hash, audits without the code, and lives 15 minutes', async () => {
    const contact = await addContact();
    const issued = await issue(contact.id);
    expect(issued.audited).toBe(true);
    expect(parseLinkCode(issued.value.code)).toBe(issued.value.code);
    expect(issued.value.expiresAt).toEqual(at(15 * 60));
    const rows = await env.db.owner.db
      .select()
      .from(schema.lineLinkCode)
      .where(eq(schema.lineLinkCode.contactId, contact.id));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(issued.value.code);
    const audit = (await auditRows(env, AUDIT_ACTIONS.lineLinkCodeIssued)).filter(
      (row) => row.targetId === contact.id,
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(issued.value.code);
    expect(audit[0]?.actorId).toBe(staff.id);
  });

  it('retires the earlier code of the same contact', async () => {
    const contact = await addContact();
    const first = await issue(contact.id);
    const second = await issue(contact.id);
    expect((await redeem(first.value.code, lineUser())).value.status).toBe('invalid');
    expect((await redeem(second.value.code, lineUser())).value.status).toBe('linked');
  });

  it('refuses a contact that does not exist', async () => {
    await expect(issue(randomUUID())).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('redeemLineLinkCode', () => {
  it('links the LINE user, leaves the LINE identity unverified and works once', async () => {
    const contact = await addContact();
    const { code } = (await issue(contact.id)).value;
    const userId = lineUser();
    const result = await redeem(code, userId);
    expect(result.value).toEqual({ status: 'linked', contactId: contact.id, ticketsMoved: 0 });
    expect(result.audited).toBe(true);
    const [row] = await env.db.owner.db
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.id, contact.id));
    expect(row).toMatchObject({ lineUserId: userId });
    // Linked by a staff-issued code: the LINE identity is NOT verified, and the contact's own
    // verification is untouched.
    expect(row).toMatchObject({
      lineLinkedVia: 'staff_code',
      lineVerifiedAt: null,
      verifiedAt: null,
    });
    expect(row?.lineLinkedAt).toEqual(clock.now);
    // A second use, even by the same person, is refused: the code is spent.
    expect((await redeem(code, userId)).value).toEqual({ status: 'invalid' });
    const audit = (await auditRows(env, AUDIT_ACTIONS.lineLinked)).filter(
      (entry) => entry.targetId === contact.id,
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(userId);
    expect(JSON.stringify(audit)).not.toContain(code);
  });

  it("does not hand an email-verified contact's verification to the LINE account", async () => {
    const emailVerifiedAt = new Date('2026-10-01T00:00:00Z');
    const contact = await addContact({ verifiedAt: emailVerifiedAt });
    const { code } = (await issue(contact.id)).value;
    await redeem(code, lineUser());
    const [row] = await env.db.owner.db
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.id, contact.id));
    expect(row?.verifiedAt).toEqual(emailVerifiedAt);
    expect(row).toMatchObject({ lineLinkedVia: 'staff_code', lineVerifiedAt: null });
  });

  it('answers the same for an unknown, an expired and a used code', async () => {
    const contact = await addContact();
    const short = await issue(contact.id, 60);
    clock.now = at(61);
    try {
      expect((await redeem(short.value.code, lineUser())).value).toEqual({ status: 'invalid' });
      expect((await redeem(generateLinkCode(), lineUser())).value).toEqual({ status: 'invalid' });
    } finally {
      clock.now = new Date('2026-11-02T03:00:00Z');
    }
    const [row] = await env.db.owner.db
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.id, contact.id));
    expect(row?.lineUserId).toBeNull();
    expect(row?.verifiedAt).toBeNull();
  });

  it('moves the tickets of the unverified placeholder contact to the real one', async () => {
    const userId = lineUser();
    // The customer wrote first: an unverified contact in the placeholder organization and a ticket.
    const first = await env.tx((tx) =>
      env.domain.inbound.ingest(tx, env.ctx(SYSTEM), { message: lineMessage(userId, 'ระบบล่ม') }),
    );
    const ticketId = first.value.ticketId ?? '';
    const [before] = await env.db.owner.db
      .select()
      .from(schema.ticket)
      .where(eq(schema.ticket.id, ticketId));
    expect(before?.orgId).toBe(UNIDENTIFIED_ORG_ID);
    const placeholderId = before?.requesterContactId ?? '';

    const known = await addContact({ name: 'Known customer' });
    const { code } = (await issue(known.id)).value;
    const result = await redeem(code, userId);
    expect(result.value).toEqual({ status: 'linked', contactId: known.id, ticketsMoved: 1 });
    expect(result.events.map((event) => event.type)).toEqual(['ticket.updated']);

    const [after] = await env.db.owner.db
      .select()
      .from(schema.ticket)
      .where(eq(schema.ticket.id, ticketId));
    expect(after).toMatchObject({ orgId, requesterContactId: known.id });
    const [placeholder] = await env.db.owner.db
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.id, placeholderId));
    // Retired, not deleted: its messages still point at it.
    expect(placeholder).toMatchObject({ lineUserId: null, mergedIntoContactId: known.id });
    // From now on the same LINE user is the known contact, in the known organization.
    const next = await env.tx((tx) =>
      env.domain.inbound.ingest(tx, env.ctx(SYSTEM), { message: lineMessage(userId, 'ยังไม่หาย') }),
    );
    expect(next.value.ticketId).toBe(ticketId);
  });

  it('never moves the tickets of a contact in a real organization (cross-tenant guard)', async () => {
    const userId = lineUser();
    // Staff created this contact in organization B with a LINE id; it is unverified but it is not a placeholder.
    const orgB = (await addOrg(env, { name: 'Org B' })).id;
    const holder = await addContact({ orgId: orgB, lineUserId: userId, name: 'B person' });
    const [ticketB] = await env.db.owner.db
      .insert(schema.ticket)
      .values({ subject: 'Org B ticket', orgId: orgB, requesterContactId: holder.id })
      .returning();
    const target = await addContact({ name: 'A person' });
    const { code } = (await issue(target.id)).value;
    expect((await redeem(code, userId)).value).toEqual({ status: 'invalid' });
    const [after] = await env.db.owner.db
      .select()
      .from(schema.ticket)
      .where(eq(schema.ticket.id, ticketB?.id ?? ''));
    expect(after).toMatchObject({ orgId: orgB, requesterContactId: holder.id });
    const [still] = await env.db.owner.db
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.id, holder.id));
    expect(still).toMatchObject({ lineUserId: userId, mergedIntoContactId: null });
    // The same through the LINE Login path.
    await expect(
      env.tx((tx) =>
        env.domain.identity.linkLineUser(tx, env.ctx(SYSTEM), {
          contactId: target.id,
          lineUserId: userId,
          via: 'line_login',
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('gives the code back when the LINE user already belongs to a verified contact', async () => {
    const userId = lineUser();
    await addContact({ lineUserId: userId, verifiedAt: clock.now, name: 'Verified' });
    const other = await addContact({ name: 'Other' });
    const { code } = (await issue(other.id)).value;
    expect((await redeem(code, userId)).value).toEqual({ status: 'invalid' });
    const [stillOther] = await env.db.owner.db
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.id, other.id));
    expect(stillOther?.lineUserId).toBeNull();
    // The refusal did not burn the code: the same code works for a LINE user that is free.
    expect((await redeem(code, lineUser())).value.status).toBe('linked');
  });
});

describe('linkLineUser', () => {
  it('is a no-op for a contact already linked to this LINE user and refuses another one', async () => {
    const userId = lineUser();
    const contact = await addContact();
    const link = (lineUserId: string) =>
      env.tx((tx) =>
        env.domain.identity.linkLineUser(tx, env.ctx(SYSTEM), {
          contactId: contact.id,
          lineUserId,
          via: 'line_login',
        }),
      );
    expect((await link(userId)).value.changed).toBe(true);
    const again = await link(userId);
    expect(again.value.changed).toBe(false);
    expect(again.audited).toBe(false);
    await expect(link(lineUser())).rejects.toMatchObject({ code: 'conflict' });
  });

  it("verifies the LINE identity for LINE Login without touching the contact's own verification", async () => {
    const contact = await addContact();
    const linked = await env.tx((tx) =>
      env.domain.identity.linkLineUser(tx, env.ctx(SYSTEM), {
        contactId: contact.id,
        lineUserId: lineUser(),
        via: 'line_login',
      }),
    );
    expect(linked.value.contact).toMatchObject({ lineLinkedVia: 'line_login', verifiedAt: null });
    expect(linked.value.contact.lineVerifiedAt).toEqual(clock.now);
    const audit = (await auditRows(env, AUDIT_ACTIONS.lineLinked)).filter(
      (entry) => entry.targetId === contact.id,
    );
    expect(JSON.stringify(audit)).toContain('line_login');
  });

  it('refuses a verified LINE identity that says nothing about how (the database check)', async () => {
    const contact = await addContact();
    await expect(
      env.db.owner.db
        .update(schema.contact)
        .set({ lineUserId: lineUser(), lineVerifiedAt: clock.now })
        .where(eq(schema.contact.id, contact.id)),
    ).rejects.toThrow();
    await expect(
      env.db.owner.db
        .update(schema.contact)
        .set({ lineUserId: lineUser(), lineLinkedVia: 'staff_code', lineVerifiedAt: clock.now })
        .where(eq(schema.contact.id, contact.id)),
    ).rejects.toThrow();
  });

  it('lets the database refuse two contacts with one LINE user id', async () => {
    const userId = lineUser();
    await addContact({ lineUserId: userId });
    await expect(addContact({ lineUserId: userId })).rejects.toThrow();
  });
});
