import { PG, isPgError, schema } from '@watchtower/db';
import { AUDIT_ACTIONS } from '@watchtower/shared';
import { arrayContains } from 'drizzle-orm';

import { recordAuditInTx } from './audit.js';
import { conflict } from './errors.js';
import type { ContactRow } from './rows.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from './types.js';

/** The audit log gets ids and counts, not addresses or phone numbers (PII minimization). */
export function contactSnapshot(row: ContactRow): Record<string, unknown> {
  return {
    id: row.id,
    orgId: row.orgId,
    emailCount: row.emails.length,
    hasLineUserId: row.lineUserId !== null,
    lineLinkedVia: row.lineLinkedVia,
    lineVerified: row.lineVerifiedAt !== null,
    hasPhone: row.phone !== null,
  };
}

export interface FindOrCreateContactInput {
  readonly orgId: string;
  readonly email: string;
  readonly name: string;
}

/** Inside another operation: the effects (audit mark) go to the caller's `fx`. */
export async function findOrCreateContactByEmailIn(
  tx: DbTransaction,
  ctx: DomainContext,
  fx: Effects,
  input: FindOrCreateContactInput,
): Promise<ContactRow> {
  const { orgId, name } = input;
  const normalized = input.email.trim().toLowerCase();
  const [existing] = await tx
    .select()
    .from(schema.contact)
    .where(arrayContains(schema.contact.emails, [normalized]))
    .limit(1);
  if (existing) {
    if (existing.orgId !== orgId) {
      throw conflict('This email address belongs to a contact of another organization');
    }
    return existing;
  }
  try {
    // A savepoint: a unique violation must not abort the caller's whole transaction.
    return await tx.transaction(async (savepoint) => {
      const [created] = await savepoint
        .insert(schema.contact)
        .values({ orgId, name, emails: [normalized] })
        .returning();
      if (!created) throw new Error('contact insert returned no row');
      await recordAuditInTx(savepoint, ctx, fx, {
        action: AUDIT_ACTIONS.contactCreate,
        targetType: 'contact',
        targetId: created.id,
        after: contactSnapshot(created),
        metadata: { via: 'find_or_create_by_email' },
      });
      return created;
    });
  } catch (error) {
    if (!isPgError(error, PG.uniqueViolation)) throw error;
    // Someone created the same contact a moment ago (two submissions from one new address).
    const [winner] = await tx
      .select()
      .from(schema.contact)
      .where(arrayContains(schema.contact.emails, [normalized]))
      .limit(1);
    if (winner?.orgId === orgId) return winner;
    throw conflict('This email address belongs to another contact');
  }
}

/**
 * The contact of this organization that owns `email`, created if the address is new. Used when a
 * ticket arrives from a person we have not seen (portal form, a staff member filing on behalf).
 * An address that already belongs to a contact of another organization is a conflict: one mailbox
 * is one contact, and silently moving it would change whose tickets someone sees.
 *
 * A contact it creates gets a `contact.create` audit row in the same transaction (rolled back
 * together with it), attributed to `ctx.actor`: creating a person record is never silent.
 */
export async function findOrCreateContactByEmail(
  tx: DbTransaction,
  ctx: DomainContext,
  input: FindOrCreateContactInput,
): Promise<DomainResult<ContactRow>> {
  const fx = new Effects();
  return fx.result(await findOrCreateContactByEmailIn(tx, ctx, fx, input));
}
