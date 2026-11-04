import { schema } from '@watchtower/db';
import { and, eq, sql, type SQL } from 'drizzle-orm';

import type { DbTransaction } from '../types.js';

export interface MarkRequesterVerifiedInput {
  /** The contact that owns the mailbox that was just proven. */
  readonly contactId: string;
  /** Limit to one ticket (the tracking link of that ticket); omit for every portal ticket that exists now. */
  readonly ticketId?: string;
}

/**
 * Proof of mailbox ownership for portal tickets (T-306h, T-306a C-3). The stage 3 autosend gate treats a
 * portal requester as verified only when `customFields.portal.requesterVerified === true`; the address on
 * a portal form is only typed (ADR-007), so this is set only after the customer opened a link that was
 * delivered to that mailbox.
 *
 * Sets `requesterVerified=true` and `requesterVerifiedAt` on the portal tickets of the contact that
 * are not verified yet and returns their ids (empty when nothing changed: idempotent, and the caller
 * writes no audit row for a repeat). Only tickets that already exist are touched; a ticket filed later
 * from the same address stays unverified until its own link is opened. `updated_at` is left alone: this
 * is not a change the customer or staff should see in a queue order.
 */
export async function markPortalRequesterVerified(
  tx: DbTransaction,
  input: MarkRequesterVerifiedInput,
): Promise<readonly string[]> {
  const conditions: SQL[] = [
    eq(schema.ticket.requesterContactId, input.contactId),
    eq(schema.ticket.channel, 'portal'),
    // Only tickets the portal itself filed (they carry the `portal` object); never invents one.
    sql`jsonb_typeof(${schema.ticket.customFields}->'portal') = 'object'`,
    sql`${schema.ticket.customFields}->'portal'->'requesterVerified' is distinct from 'true'::jsonb`,
  ];
  if (input.ticketId !== undefined) conditions.push(eq(schema.ticket.id, input.ticketId));
  const rows = await tx
    .update(schema.ticket)
    .set({
      customFields: sql`jsonb_set(
        ${schema.ticket.customFields},
        '{portal}',
        (${schema.ticket.customFields}->'portal')
          || jsonb_build_object('requesterVerified', true, 'requesterVerifiedAt', to_jsonb(now()))
      )`,
    })
    .where(and(...conditions))
    .returning({ id: schema.ticket.id });
  return rows.map((row) => row.id);
}
