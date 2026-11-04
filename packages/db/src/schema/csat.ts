// CSAT surveys (T-110, migration 0031). Mirrors the SQL by hand; the SQL file is the source of truth
// (CHECKs, partial unique index, privileges).
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { channelAccount, contact, organization, ticket } from './ticketing.js';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * One survey of one resolved ticket. `status`: `scheduled` (owed, due at `sendAfter`), `sent`,
 * `answered`, `voided` (the ticket was reopened), `skipped` (a rule spared the customer: `reason`) or
 * `expired` (the link ran out unanswered). The survey link is not stored: it is an HMAC of the id and
 * `tokenExpiresAt`. A link works once because the answer is a conditional UPDATE on `status = 'sent'`.
 */
export const csatSurvey = pgTable(
  'csat_survey',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => ticket.id, { onDelete: 'restrict' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contact.id, { onDelete: 'restrict' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    channel: text('channel').notNull().default('email'),
    status: text('status').notNull().default('scheduled'),
    sendAfter: timestamptz('send_after').notNull(),
    sentAt: timestamptz('sent_at'),
    reminderDueAt: timestamptz('reminder_due_at'),
    reminderSentAt: timestamptz('reminder_sent_at'),
    tokenExpiresAt: timestamptz('token_expires_at'),
    answeredAt: timestamptz('answered_at'),
    /** A stable code for a skipped or voided survey. */
    reason: text('reason'),
    score: smallint('score'),
    resolved: boolean('resolved'),
    comment: text('comment'),
    reopened: boolean('reopened').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('csat_survey_ticket_live_key')
      .on(table.ticketId)
      .where(sql`${table.status} IN ('scheduled', 'sent')`),
    index('csat_survey_due_idx')
      .on(table.sendAfter)
      .where(sql`${table.status} = 'scheduled'`),
    index('csat_survey_reminder_idx')
      .on(table.reminderDueAt)
      .where(sql`${table.status} = 'sent' AND ${table.reminderSentAt} IS NULL`),
    index('csat_survey_expiry_idx')
      .on(table.tokenExpiresAt)
      .where(sql`${table.status} = 'sent'`),
    index('csat_survey_contact_idx')
      .on(table.contactId, table.sentAt)
      .where(sql`${table.sentAt} IS NOT NULL`),
    index('csat_survey_sent_idx')
      .on(table.sentAt)
      .where(sql`${table.sentAt} IS NOT NULL`),
    index('csat_survey_answered_idx')
      .on(table.answeredAt, table.id)
      .where(sql`${table.status} = 'answered'`),
  ],
);

export type CsatSurveyRow = typeof csatSurvey.$inferSelect;

/** An organization that asked not to be surveyed (R-10.4): a row means opted out. */
export const csatOrgOptOut = pgTable('csat_org_opt_out', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organization.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

/**
 * The at-most-once ledger of a survey (or its reminder) sent through a Gmail mailbox (T-174, migration
 * 0084). `claimed` before the send, `sent` after, `released` when the send certainly did not leave and
 * may be tried again. A row left `claimed` is an unknown outcome and is never repeated.
 */
export const csatEmailDispatch = pgTable(
  'csat_email_dispatch',
  {
    surveyId: uuid('survey_id')
      .notNull()
      .references(() => csatSurvey.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    state: text('state').notNull().default('claimed'),
    attempts: integer('attempts').notNull().default(1),
    channelAccountId: uuid('channel_account_id').references(() => channelAccount.id, {
      onDelete: 'set null',
    }),
    providerMessageId: text('provider_message_id'),
    errorCode: text('error_code'),
    claimedAt: timestamptz('claimed_at').notNull().defaultNow(),
    finishedAt: timestamptz('finished_at'),
  },
  (table) => [
    primaryKey({ columns: [table.surveyId, table.kind] }),
    index('csat_email_dispatch_account_idx')
      .on(table.channelAccountId)
      .where(sql`${table.channelAccountId} IS NOT NULL`),
  ],
);
