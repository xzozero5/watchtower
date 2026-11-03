import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { users } from './auth.js';

/**
 * Mirrors migrations/0083_staff_uploads.sql. A file a signed-in person uploaded to attach to a note, a
 * handoff, an incident note or a ticket. The object lives in the object store under `objectKey`; it is
 * only ever read back through the api. Written once, never updated.
 */
export const staffUpload = pgTable(
  'staff_upload',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    objectKey: text('object_key').notNull().unique(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('staff_upload_uploader_idx').on(table.uploaderId, table.createdAt.desc())],
);
