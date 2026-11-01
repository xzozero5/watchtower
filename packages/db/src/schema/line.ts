import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { contact } from './ticketing.js';

/**
 * Mirrors migrations/0014_line_identity.sql (T-103d). The SQL file is the source of truth; keep both
 * in step by hand and let the integration tests catch drift. The `contact.merged_into_contact_id` column
 * and its check are in `ticketing.ts` / the SQL.
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** A one-time code that links the LINE user who sends it to `contactId` (R-2.11). */
export const lineLinkCode = pgTable(
  'line_link_code',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contact.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
  },
  (table) => [
    uniqueIndex('line_link_code_hash_key')
      .on(table.codeHash)
      .where(sql`${table.usedAt} IS NULL`),
    index('line_link_code_contact_idx').on(table.contactId),
    index('line_link_code_expiry_idx').on(table.expiresAt),
  ],
);

export type LineLinkCodeRow = typeof lineLinkCode.$inferSelect;
