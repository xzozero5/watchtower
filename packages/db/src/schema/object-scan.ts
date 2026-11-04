import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Mirrors migrations/0091_object_scan.sql (T-155, ADR-022). The malware scan state of one stored
 * upload, keyed by its object key. With `UPLOAD_SCAN=clamav` a file is served and forwarded only when
 * its row is `clean`; `infected` rows stay as the record after the object itself is deleted.
 */
export const OBJECT_SCAN_STATUSES = ['pending', 'clean', 'infected', 'error'] as const;
export type ObjectScanStatus = (typeof OBJECT_SCAN_STATUSES)[number];
export const OBJECT_SCAN_SOURCES = ['message', 'inbound_message', 'staff_upload'] as const;
export type ObjectScanSource = (typeof OBJECT_SCAN_SOURCES)[number];

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const objectScan = pgTable(
  'object_scan',
  {
    objectKey: text('object_key').primaryKey(),
    source: text('source').$type<ObjectScanSource>().notNull(),
    ticketId: uuid('ticket_id'),
    filename: text('filename'),
    size: integer('size'),
    scanStatus: text('scan_status').$type<ObjectScanStatus>().notNull().default('pending'),
    signature: text('signature'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: at('next_attempt_at').notNull().defaultNow(),
    scannedAt: at('scanned_at'),
    removedAt: at('removed_at'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('object_scan_removal_idx')
      .on(table.scannedAt)
      .where(sql`${table.scanStatus} = 'infected' AND ${table.removedAt} IS NULL`),
    index('object_scan_ticket_idx')
      .on(table.ticketId)
      .where(sql`${table.ticketId} IS NOT NULL`),
    index('object_scan_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.scanStatus} IN ('pending', 'error')`),
  ],
);

export type ObjectScanRow = typeof objectScan.$inferSelect;
