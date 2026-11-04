import { schema } from '@watchtower/db';
import { FREE_MAIL_DOMAINS } from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import type { TicketRow } from '../rows.js';
import type { DbTransaction } from '../types.js';

/**
 * Who an email reply may go to without asking again (T-171 C-2, T-171a C-3). A staff member can type any
 * address into To / Cc / Bcc; a typo or a wrong autocomplete would send a customer's ticket to a stranger.
 * An address is "known" when it belongs to something the customer organization owns:
 *
 * - a domain of the organization (`organization.domains`), or the address of one of its contacts,
 * - the domain of the staff member's own address (colleagues copied in).
 *
 * Nothing is learnt from the Cc of a mail that came in: a sender can put any address there. A free
 * mail provider (gmail.com, outlook.com ...) is shared by everybody, so its domain proves nothing: the
 * whole address has to match. Anything else is "external": the reply is refused until the person
 * confirms those keys (a domain, or a whole address for a free mail provider), and the confirmation is
 * audited.
 */

const CONTACT_LIMIT = 500;

export interface KnownRecipients {
  /** Keys that are known: a domain, or a whole address for a free mail provider. */
  readonly keys: ReadonlySet<string>;
  readonly freeMail: ReadonlySet<string>;
}

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

/** The key an address is known by: its domain, or the whole address when the provider is shared. */
export function recipientKey(address: string, freeMail: ReadonlySet<string>): string {
  const clean = address.trim().toLowerCase();
  const domain = domainOfAddress(clean);
  return freeMail.has(domain) ? clean : domain;
}

function addKeysOf(into: Set<string>, freeMail: ReadonlySet<string>, value: unknown): void {
  if (typeof value === 'string') {
    const key = recipientKey(value, freeMail);
    if (key !== '') into.add(key);
  } else if (Array.isArray(value)) {
    for (const item of value as unknown[]) addKeysOf(into, freeMail, item);
  } else if (typeof value === 'object' && value !== null) {
    addKeysOf(into, freeMail, (value as { address?: unknown }).address);
  }
}

/** The keys (lower-case, sorted, once each) among `addresses` that are not in `known`. */
export function externalDomains(addresses: readonly string[], known: KnownRecipients): string[] {
  const out = new Set<string>();
  for (const address of addresses) {
    if (domainOfAddress(address) === '') continue;
    const key = recipientKey(address, known.freeMail);
    if (!known.keys.has(key)) out.add(key);
  }
  return [...out].sort();
}

/** What the ticket's customer owns (see the module comment). */
export async function knownDomains(
  tx: DbTransaction,
  ticket: Pick<TicketRow, 'id' | 'orgId'>,
  staffUserId: string,
  freeMailDomains: readonly string[] = FREE_MAIL_DOMAINS,
): Promise<KnownRecipients> {
  const freeMail = new Set(freeMailDomains.map((d) => d.trim().toLowerCase().replace(/^@/, '')));
  const known = new Set<string>();

  const [org] = await tx
    .select({ domains: schema.organization.domains })
    .from(schema.organization)
    .where(eq(schema.organization.id, ticket.orgId))
    .limit(1);
  for (const domain of org?.domains ?? []) {
    const clean = domain.trim().toLowerCase().replace(/^@/, '');
    // A free mail provider listed as an organization domain would open the door to everyone on it.
    if (clean !== '' && !freeMail.has(clean)) known.add(clean);
  }

  const contacts = await tx
    .select({ emails: schema.contact.emails })
    .from(schema.contact)
    .where(eq(schema.contact.orgId, ticket.orgId))
    .limit(CONTACT_LIMIT);
  for (const row of contacts) addKeysOf(known, freeMail, row.emails);

  const [staff] = await tx
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, staffUserId))
    .limit(1);
  addKeysOf(known, freeMail, staff?.email);
  return { keys: known, freeMail };
}
