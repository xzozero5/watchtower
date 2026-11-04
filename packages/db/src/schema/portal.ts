import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { contact, ticket } from './ticketing.js';

/**
 * Mirrors migrations/0004_portal.sql (the SQL file is the source of truth; keep both in step by
 * hand and let the integration tests catch drift).
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Tracking links of the client portal (T-007). Only the SHA-256 of a token is stored. */
export const portalAccessToken = pgTable(
  'portal_access_token',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => ticket.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contact.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('portal_access_token_hash_key').on(table.tokenHash),
    index('portal_access_token_ticket_idx').on(table.ticketId),
    index('portal_access_token_contact_idx').on(table.contactId),
    index('portal_access_token_expiry_idx').on(table.expiresAt),
    index('portal_access_token_revoked_idx')
      .on(table.revokedAt)
      .where(sql`${table.revokedAt} IS NOT NULL`),
  ],
);

/**
 * One-time "my requests" links (T-152, migration 0104). Only the SHA-256 of a token is stored; the row
 * is bound to a contact and to a keyed tag of the address it was mailed to, never the address.
 */
export const portalListLink = pgTable(
  'portal_list_link',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contact.id, { onDelete: 'cascade' }),
    emailTag: text('email_tag').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    consumedAt: timestamptz('consumed_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('portal_list_link_hash_key').on(table.tokenHash),
    index('portal_list_link_contact_idx')
      .on(table.contactId)
      .where(sql`${table.consumedAt} IS NULL`),
    index('portal_list_link_expiry_idx').on(table.expiresAt),
  ],
);
