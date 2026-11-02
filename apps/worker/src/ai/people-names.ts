import { schema, type Database } from '@watchtower/db';
import { and, asc, eq } from 'drizzle-orm';

/**
 * Most contacts (and, separately, client users) of an organization given to the redactor on top of
 * the requester. The redactor takes tens of thousands of names; this keeps one AI run cheap.
 */
export const MAX_PEOPLE_NAMES = 2_000;

/**
 * The names the redactor must know for a ticket (N4, QA-30): the requester always, wherever the
 * contact belongs and however many people the organization has, then the contacts of the
 * organization and its client users (a portal user's display name can be the local part of an
 * email address). Before QA-30 this was "the first 200 contacts of the organization", in no order,
 * so the requester could be missing and client users never were.
 *
 * A person the cues and the dictionary both miss is the residual gap (ADR-008, T-153).
 */
export async function ticketPeopleNames(
  db: Database['db'],
  ticket: { readonly orgId: string; readonly requesterContactId: string | null },
): Promise<string[]> {
  const [requester, contacts, clients] = await Promise.all([
    ticket.requesterContactId === null
      ? Promise.resolve([])
      : db
          .select({ name: schema.contact.name })
          .from(schema.contact)
          .where(eq(schema.contact.id, ticket.requesterContactId))
          .limit(1),
    db
      .select({ name: schema.contact.name })
      .from(schema.contact)
      .where(eq(schema.contact.orgId, ticket.orgId))
      .orderBy(asc(schema.contact.id))
      .limit(MAX_PEOPLE_NAMES),
    db
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(and(eq(schema.users.role, 'client'), eq(schema.users.orgId, ticket.orgId)))
      .orderBy(asc(schema.users.id))
      .limit(MAX_PEOPLE_NAMES),
  ]);
  const names = [...requester, ...contacts, ...clients]
    .map((row) => row.name)
    .filter((name) => name.trim() !== '');
  return [...new Set(names)];
}
