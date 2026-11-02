import { schema, type Database } from '@watchtower/db';
import { inArray } from 'drizzle-orm';

const MAX_NAMES = 200;

/**
 * Names of the customers' people in the organizations of these tickets, for the redactor's dictionary
 * (N4): a subject or a title in a brief often holds the name of whoever wrote in. Scoped, not every
 * contact of the instance (the redactor refuses a huge dictionary and rebuilds it for each call).
 */
export async function customerNamesOfTickets(
  db: Pick<Database['db'], 'select' | 'selectDistinct'>,
  ticketIds: readonly string[],
): Promise<string[]> {
  if (ticketIds.length === 0) return [];
  const orgs = await db
    .selectDistinct({ orgId: schema.ticket.orgId })
    .from(schema.ticket)
    .where(inArray(schema.ticket.id, [...ticketIds].slice(0, 500)));
  if (orgs.length === 0) return [];
  const rows = await db
    .select({ name: schema.contact.name })
    .from(schema.contact)
    .where(
      inArray(
        schema.contact.orgId,
        orgs.map((org) => org.orgId),
      ),
    )
    .limit(MAX_NAMES);
  return rows.map((row) => row.name);
}
