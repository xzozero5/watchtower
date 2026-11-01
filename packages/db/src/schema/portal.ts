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
