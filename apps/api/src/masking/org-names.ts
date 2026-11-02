import { schema, type Database } from '@watchtower/db';
import { and, eq, inArray } from 'drizzle-orm';

/**
 * At most this many people of the organizations in view are given to the redactor. The redactor takes
 * a few tens of thousands of names; beyond this the list is "not complete" and a masked reader gets a
 * notice instead of text (see `createMaskingSession`).
 */
export const ORG_NAME_LIMIT = 10_000;

export interface OrgNames {
  readonly names: string[];
  /** False when an organization had more people than the limit: the list is cut short. */
  readonly complete: boolean;
}

/**
 * The names of the people of these organizations: their contacts, and their client users (whose
 * display name can be the local part of an email address, from the magic-link sign-in). The redactor
 * needs them to find a name written in running text.
 */
export async function orgPeopleNames(
  executor: Pick<Database['db'], 'select'>,
  orgIds: readonly string[],
  limit = ORG_NAME_LIMIT,
): Promise<OrgNames> {
  if (orgIds.length === 0) return { names: [], complete: true };
  const contacts = await executor
    .select({ name: schema.contact.name })
    .from(schema.contact)
    .where(inArray(schema.contact.orgId, [...orgIds]))
    .limit(limit + 1);
  const clients = await executor
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(and(eq(schema.users.role, 'client'), inArray(schema.users.orgId, [...orgIds])))
    .limit(limit + 1);
  const names = [...new Set([...contacts, ...clients].map((row) => row.name))];
  return {
    names: names.slice(0, limit),
    complete: contacts.length <= limit && clients.length <= limit,
  };
}
