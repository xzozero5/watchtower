import { PG, isPgError, schema } from '@watchtower/db';
import { AUDIT_ACTIONS } from '@watchtower/shared';
import { and, arrayContains, eq } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { contactSnapshot, findOrCreateContactByEmailIn } from '../contacts.js';
import type { ContactRow } from '../rows.js';
import type { DbTransaction, DomainContext, Effects } from '../types.js';
import type { NormalisedInboundMessage } from './types.js';

/**
 * Who sent a message (PRD section 5.1 step 2, R-2.11). A person we already know keeps their
 * organization. An address on a domain an organization claims joins that organization. Everybody
 * else is a contact of the placeholder organization below, `unverified` (no `verified_at`), so the
 * disclosure policy treats them as strangers until a person links them.
 */

/** The organization that holds contacts nobody has claimed yet. Created on first use. */
export const UNIDENTIFIED_ORG_ID = '00000000-0000-4000-8000-0000000000f1';
export const UNIDENTIFIED_ORG_NAME = 'Unidentified senders';

export type SenderVia = 'contact' | 'domain' | 'unidentified';

export interface SenderLookup {
  readonly contact: ContactRow | null;
  /** The organization the sender belongs to; null when nothing is known (not even a domain). */
  readonly orgId: string | null;
  readonly via: SenderVia;
}

type Sender = NormalisedInboundMessage['from'];

function normalisedEmail(sender: Sender): string | null {
  const address = sender.address?.trim().toLowerCase() ?? '';
  return address.includes('@') ? address : null;
}

/** Reads only: finds the contact and the organization, creates nothing. */
export async function lookupSender(tx: DbTransaction, sender: Sender): Promise<SenderLookup> {
  if (sender.lineUserId !== null) {
    const [byLine] = await tx
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.lineUserId, sender.lineUserId))
      .limit(1);
    if (byLine) return { contact: byLine, orgId: byLine.orgId, via: 'contact' };
  }
  const email = normalisedEmail(sender);
  if (email !== null) {
    const [byEmail] = await tx
      .select()
      .from(schema.contact)
      .where(arrayContains(schema.contact.emails, [email]))
      .limit(1);
    if (byEmail) return { contact: byEmail, orgId: byEmail.orgId, via: 'contact' };
    const domain = email.slice(email.lastIndexOf('@') + 1);
    const orgs = await tx
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(
        and(
          arrayContains(schema.organization.domains, [domain]),
          eq(schema.organization.status, 'active'),
        ),
      )
      .limit(2);
    // The database refuses two organizations with one domain; if that ever changes, guessing would
    // show one customer's mail to another, so an ambiguous domain stays unidentified.
    if (orgs.length === 1 && orgs[0]) return { contact: null, orgId: orgs[0].id, via: 'domain' };
  }
  return { contact: null, orgId: null, via: 'unidentified' };
}

async function ensureUnidentifiedOrg(tx: DbTransaction): Promise<string> {
  await tx
    .insert(schema.organization)
    .values({ id: UNIDENTIFIED_ORG_ID, name: UNIDENTIFIED_ORG_NAME })
    .onConflictDoNothing({ target: schema.organization.id });
  return UNIDENTIFIED_ORG_ID;
}

function displayName(sender: Sender): string {
  const name = sender.name?.trim() ?? '';
  if (name !== '') return name.slice(0, 200);
  const email = normalisedEmail(sender);
  if (email !== null) return email.slice(0, email.indexOf('@'));
  return 'LINE user';
}

async function findOrCreateContactByLineIn(
  tx: DbTransaction,
  ctx: DomainContext,
  fx: Effects,
  input: { readonly orgId: string; readonly lineUserId: string; readonly name: string },
): Promise<ContactRow> {
  const find = async (): Promise<ContactRow | undefined> =>
    (
      await tx
        .select()
        .from(schema.contact)
        .where(eq(schema.contact.lineUserId, input.lineUserId))
        .limit(1)
    )[0];
  const existing = await find();
  if (existing) return existing;
  try {
    return await tx.transaction(async (savepoint) => {
      const [created] = await savepoint
        .insert(schema.contact)
        .values({ orgId: input.orgId, name: input.name, lineUserId: input.lineUserId })
        .returning();
      if (!created) throw new Error('contact insert returned no row');
      await recordAuditInTx(savepoint, ctx, fx, {
        action: AUDIT_ACTIONS.contactCreate,
        targetType: 'contact',
        targetId: created.id,
        after: contactSnapshot(created),
        metadata: { via: 'inbound_line' },
      });
      return created;
    });
  } catch (error) {
    // `line_user_id` has no unique index; this only guards a future one. Re-read and use the winner.
    if (!isPgError(error, PG.uniqueViolation)) throw error;
    const winner = await find();
    if (winner) return winner;
    throw error;
  }
}

/**
 * The contact for `sender` in `orgId`, created `unverified` when new. Pass the organization that
 * `lookupSender` found (or the placeholder one). A contact that already exists is returned as it is,
 * wherever it belongs: the caller has checked that.
 */
export async function ensureSenderContact(
  tx: DbTransaction,
  ctx: DomainContext,
  fx: Effects,
  sender: Sender,
  found: SenderLookup,
): Promise<{ readonly contact: ContactRow; readonly via: SenderVia }> {
  if (found.contact) return { contact: found.contact, via: found.via };
  const orgId = found.orgId ?? (await ensureUnidentifiedOrg(tx));
  const via: SenderVia = found.orgId === null ? 'unidentified' : found.via;
  const email = normalisedEmail(sender);
  if (sender.lineUserId !== null) {
    const contact = await findOrCreateContactByLineIn(tx, ctx, fx, {
      orgId,
      lineUserId: sender.lineUserId,
      name: displayName(sender),
    });
    return { contact, via };
  }
  if (email === null) {
    // A message without a usable sender address: keep it with a contact nobody can reply to by mistake.
    const [created] = await tx
      .insert(schema.contact)
      .values({ orgId, name: displayName(sender) })
      .returning();
    if (!created) throw new Error('contact insert returned no row');
    await recordAuditInTx(tx, ctx, fx, {
      action: AUDIT_ACTIONS.contactCreate,
      targetType: 'contact',
      targetId: created.id,
      after: contactSnapshot(created),
      metadata: { via: 'inbound_no_address' },
    });
    return { contact: created, via };
  }
  const contact = await findOrCreateContactByEmailIn(tx, ctx, fx, {
    orgId,
    email,
    name: displayName(sender),
  });
  return { contact, via };
}
