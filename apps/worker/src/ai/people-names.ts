import { schema, type Database } from '@watchtower/db';
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';

import type { WorkerLogger } from '../logger.js';

/**
 * Most contacts (and, separately, client users) of an organization given to the redactor on top of
 * the requester and the senders. The same limit as the API's masking (`ORG_NAME_LIMIT`, 10,000);
 * the redactor takes tens of thousands of names.
 */
export const MAX_PEOPLE_NAMES = 10_000;
/** Distinct senders of one ticket looked up by name; far more than a real thread has. */
const MAX_SENDERS = 500;

export interface TicketPeopleNames {
  readonly names: string[];
  /**
   * False when an organization had more people than the limit and the list is cut short. The run
   * goes on (the name cues still cover free text), but the audit row and the log say it (QA-30).
   */
  readonly complete: boolean;
}

/**
 * The names the redactor must know for a ticket (N4, QA-30): the requester always, wherever the
 * contact belongs and however many people the organization has; every contact that sent a message
 * on the ticket; then the contacts of the organization and its client users (a portal user's
 * display name can be the local part of an email address). Before QA-30 this was "the first 200
 * contacts of the organization", in no order, so the requester could be missing and client users
 * never were.
 *
 * A person the cues and the dictionary both miss is the residual gap (ADR-008, T-153).
 */
export async function ticketPeopleNames(
  db: Database['db'],
  ticket: {
    readonly id: string;
    readonly orgId: string;
    readonly requesterContactId: string | null;
  },
  limit = MAX_PEOPLE_NAMES,
): Promise<TicketPeopleNames> {
  const [requester, senders, contacts, clients] = await Promise.all([
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
      .where(
        inArray(
          schema.contact.id,
          db
            .selectDistinct({ id: schema.message.senderContactId })
            .from(schema.message)
            .where(
              and(
                eq(schema.message.ticketId, ticket.id),
                isNotNull(schema.message.senderContactId),
              ),
            )
            .limit(MAX_SENDERS),
        ),
      ),
    db
      .select({ name: schema.contact.name })
      .from(schema.contact)
      .where(eq(schema.contact.orgId, ticket.orgId))
      .orderBy(asc(schema.contact.id))
      .limit(limit + 1),
    db
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(and(eq(schema.users.role, 'client'), eq(schema.users.orgId, ticket.orgId)))
      .orderBy(asc(schema.users.id))
      .limit(limit + 1),
  ]);
  const complete = contacts.length <= limit && clients.length <= limit;
  const names = [...requester, ...senders, ...contacts.slice(0, limit), ...clients.slice(0, limit)]
    .map((row) => row.name)
    .filter((name) => name.trim() !== '');
  return { names: [...new Set(names)], complete };
}

/** Logs (never silently) that a ticket's name dictionary was cut short. No names are logged. */
export function warnIfIncomplete(
  logger: WorkerLogger,
  ticketId: string,
  people: TicketPeopleNames,
): void {
  if (people.complete) return;
  logger.warn(
    { ticketId, limit: MAX_PEOPLE_NAMES },
    'name dictionary incomplete: the organization has more people than the limit; the name cues still apply',
  );
}
