import { schema, type Database } from '@watchtower/db';
import { inArray } from 'drizzle-orm';

import { orgPeopleNames } from '../masking/org-names.js';

export interface CustomerPeople {
  readonly names: readonly string[];
  /** False when an organization had more people than the redactor can take (see `orgPeopleNames`). */
  readonly complete: boolean;
}

/**
 * The people of the organizations of these tickets, for the redactor's dictionary (N4): a subject or a
 * title in a brief often holds the name of whoever wrote in. All of them, as the ticket page's masking
 * does; when the list had to be cut short `complete` is false and the summary is not made at all.
 */
export async function customerNamesOfTickets(
  db: Pick<Database['db'], 'select' | 'selectDistinct'>,
  ticketIds: readonly string[],
): Promise<CustomerPeople> {
  if (ticketIds.length === 0) return { names: [], complete: true };
  const orgs = await db
    .selectDistinct({ orgId: schema.ticket.orgId })
    .from(schema.ticket)
    .where(inArray(schema.ticket.id, [...ticketIds].slice(0, 500)));
  return orgPeopleNames(
    db,
    orgs.map((org) => org.orgId),
  );
}
