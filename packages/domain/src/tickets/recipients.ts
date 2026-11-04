import { schema } from '@watchtower/db';
import { asc, eq } from 'drizzle-orm';

import type { TicketRow } from '../rows.js';
import type { DbTransaction } from '../types.js';

/**
 * Who an email reply may go to without asking again (T-171 C-2). A staff member can type any address
 * into To / Cc / Bcc; a typo or a wrong autocomplete would send a customer's ticket to a stranger.
 * An address is "known" when its domain is one the ticket already has a link to:
 *
 * - a domain of the customer organization (`organization.domains`), or of one of its contacts,
 * - a domain seen on this ticket (the requester, and the From / To / Cc of every earlier message),
 * - the domain of the staff member's own address (colleagues copied in).
 *
 * Anything else is "external": the reply is refused until the person confirms it, and the confirmation
 * is audited with the domains.
 */

const CONTACT_LIMIT = 500;
const MESSAGE_LIMIT = 200;

/** The lower-case part after the last `@`, or an empty string when there is none. */
export function domainOfAddress(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1
    ? ''
    : address
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

function addDomainsOf(into: Set<string>, value: unknown): void {
  if (typeof value === 'string') {
    const domain = domainOfAddress(value);
    if (domain !== '') into.add(domain);
  } else if (Array.isArray(value)) {
    for (const item of value as unknown[]) addDomainsOf(into, item);
  } else if (typeof value === 'object' && value !== null) {
    addDomainsOf(into, (value as { address?: unknown }).address);
  }
}

/** The domains (lower-case, sorted, once each) among `addresses` that are not in `known`. */
export function externalDomains(
  addresses: readonly string[],
  known: ReadonlySet<string>,
): string[] {
  const out = new Set<string>();
  for (const address of addresses) {
    const domain = domainOfAddress(address);
    if (domain !== '' && !known.has(domain)) out.add(domain);
  }
  return [...out].sort();
}

/** Domains the ticket is already linked to (see the module comment). */
export async function knownDomains(
  tx: DbTransaction,
  ticket: Pick<TicketRow, 'id' | 'orgId'>,
  staffUserId: string,
): Promise<Set<string>> {
  const known = new Set<string>();

  const [org] = await tx
    .select({ domains: schema.organization.domains })
    .from(schema.organization)
    .where(eq(schema.organization.id, ticket.orgId))
    .limit(1);
  for (const domain of org?.domains ?? []) {
    const clean = domain.trim().toLowerCase().replace(/^@/, '');
    if (clean !== '') known.add(clean);
  }

  const contacts = await tx
    .select({ emails: schema.contact.emails })
    .from(schema.contact)
    .where(eq(schema.contact.orgId, ticket.orgId))
    .limit(CONTACT_LIMIT);
  for (const row of contacts) addDomainsOf(known, row.emails);

  const messages = await tx
    .select({ meta: schema.message.emailMeta })
    .from(schema.message)
    .where(eq(schema.message.ticketId, ticket.id))
    .orderBy(asc(schema.message.createdAt))
    .limit(MESSAGE_LIMIT);
  for (const row of messages) {
    const meta = row.meta as { from?: unknown; to?: unknown; cc?: unknown } | null;
    if (meta === null || typeof meta !== 'object') continue;
    addDomainsOf(known, meta.from);
    addDomainsOf(known, meta.to);
    addDomainsOf(known, meta.cc);
  }

  const [staff] = await tx
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, staffUserId))
    .limit(1);
  addDomainsOf(known, staff?.email);
  return known;
}
