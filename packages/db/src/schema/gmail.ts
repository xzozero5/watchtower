import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { channelAccount } from './ticketing.js';

/**
 * Mirrors migrations/0015_gmail_account_state.sql (T-102 b/c). The SQL file is the source of truth
 * (check constraints and comments live there); keep both in step by hand and let the integration
 * tests catch drift.
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Sync cursor, watch state and push heartbeat of one Gmail mailbox (PRD R-2.1, R-2.8). */
export const gmailAccountState = pgTable(
  'gmail_account_state',
  {
    channelAccountId: uuid('channel_account_id')
      .primaryKey()
      .references(() => channelAccount.id, { onDelete: 'cascade' }),
    /** Lower case; the address a Pub/Sub push names. */
    emailAddress: text('email_address').notNull(),
    historyId: text('history_id'),
    watchExpiresAt: timestamptz('watch_expires_at'),
    watchRenewedAt: timestamptz('watch_renewed_at'),
    lastPushAt: timestamptz('last_push_at'),
    lastSyncAt: timestamptz('last_sync_at'),
    lastFullSyncAt: timestamptz('last_full_sync_at'),
    lastErrorCode: text('last_error_code'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('gmail_account_state_email_key').on(table.emailAddress),
    check(
      'gmail_account_state_email_check',
      sql`${table.emailAddress} = lower(${table.emailAddress}) AND ${table.emailAddress} <> ''`,
    ),
    check(
      'gmail_account_state_history_check',
      sql`${table.historyId} IS NULL OR ${table.historyId} ~ '^[0-9]{1,20}$'`,
    ),
  ],
);

export type GmailAccountStateRow = typeof gmailAccountState.$inferSelect;
