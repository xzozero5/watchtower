import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { users } from './auth.js';

/**
 * Mirrors migrations/0010_integration_credential.sql (the SQL file is the source of truth; keep both
 * in step by hand and let the integration tests catch drift).
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Integration credentials (T-116a, ADR-012): one row per (integration, field), envelope-encrypted.
 * Read and written only through the credential store (`../credentials.ts`).
 */
export const integrationCredential = pgTable(
  'integration_credential',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    integration: text('integration').notNull(),
    field: text('field').notNull(),
    valueSealed: text('value_sealed').notNull(),
    dekWrapped: text('dek_wrapped').notNull(),
    keyVersion: integer('key_version').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    uniqueIndex('integration_credential_field_key').on(table.integration, table.field),
    index('integration_credential_key_version_idx').on(table.keyVersion),
  ],
);
