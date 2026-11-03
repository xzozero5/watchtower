import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './auth.js';
import { ticket } from './ticketing.js';

/**
 * Mirrors migrations/0020_shifts.sql (T-111). The SQL file is the source of truth (check
 * constraints, column privileges); keep both in step by hand and let the integration tests catch
 * drift.
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const shiftDefinition = pgTable(
  'shift_definition',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Local wall-clock `HH:MM` in the default business calendar's zone. */
    startsAt: text('starts_at').notNull(),
    endsAt: text('ends_at').notNull(),
    onCall: boolean('on_call').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('shift_definition_name_key').on(sql`lower(${table.name})`)],
);

export const rosterEntry = pgTable(
  'roster_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shiftId: uuid('shift_id')
      .notNull()
      .references(() => shiftDefinition.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `YYYY-MM-DD`, the local date the shift starts on. */
    workDate: date('work_date', { mode: 'string' }).notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('roster_entry_slot_key').on(table.userId, table.shiftId, table.workDate),
    index('roster_entry_date_idx').on(table.workDate, table.shiftId),
  ],
);

export const shiftSession = pgTable(
  'shift_session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    shiftId: uuid('shift_id').references(() => shiftDefinition.id, { onDelete: 'set null' }),
    rosterEntryId: uuid('roster_entry_id').references(() => rosterEntry.id, {
      onDelete: 'set null',
    }),
    scheduledStart: timestamptz('scheduled_start'),
    scheduledEnd: timestamptz('scheduled_end'),
    clockedInAt: timestamptz('clocked_in_at').notNull().defaultNow(),
    lateMinutes: integer('late_minutes').notNull().default(0),
    device: text('device'),
    locationConsent: boolean('location_consent').notNull().default(false),
    clockedOutAt: timestamptz('clocked_out_at'),
    overrideBy: uuid('override_by').references(() => users.id, { onDelete: 'set null' }),
    overrideReason: text('override_reason'),
    briefReadAt: timestamptz('brief_read_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('shift_session_open_key')
      .on(table.userId)
      .where(sql`${table.clockedOutAt} IS NULL`),
    index('shift_session_user_idx').on(table.userId, table.clockedInAt.desc()),
    index('shift_session_roster_idx')
      .on(table.rosterEntryId)
      .where(sql`${table.rosterEntryId} IS NOT NULL`),
  ],
);

export const handoff = pgTable(
  'handoff',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .unique()
      .references(() => shiftSession.id, { onDelete: 'restrict' }),
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    toUserId: uuid('to_user_id').references(() => users.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('draft'),
    notes: text('notes').notNull().default(''),
    messageForNext: text('message_for_next').notNull().default(''),
    /** References [{id, filename, contentType, size}] to `staff_upload` rows (migration 0083). */
    attachments: jsonb('attachments')
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    confirmedAt: timestamptz('confirmed_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('handoff_confirmed_idx')
      .on(table.confirmedAt.desc())
      .where(sql`${table.status} = 'confirmed'`),
    index('handoff_to_idx')
      .on(table.toUserId)
      .where(sql`${table.toUserId} IS NOT NULL`),
  ],
);

export const handoffItem = pgTable(
  'handoff_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    handoffId: uuid('handoff_id')
      .notNull()
      .references(() => handoff.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    kind: text('kind').notNull(),
    ticketId: uuid('ticket_id').references(() => ticket.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    nextAction: text('next_action'),
    dueAt: timestamptz('due_at'),
    severity: text('severity'),
    source: text('source').notNull(),
    edited: boolean('edited').notNull().default(false),
    requiresAck: boolean('requires_ack').notNull(),
    carriedShifts: integer('carried_shifts').notNull().default(0),
    ackStatus: text('ack_status').notNull().default('pending'),
    ackBy: uuid('ack_by').references(() => users.id, { onDelete: 'set null' }),
    ackAt: timestamptz('ack_at'),
    ackNote: text('ack_note'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('handoff_item_handoff_idx').on(table.handoffId, table.position),
    uniqueIndex('handoff_item_ticket_key')
      .on(table.handoffId, table.ticketId)
      .where(sql`${table.ticketId} IS NOT NULL`),
    index('handoff_item_open_idx')
      .on(table.handoffId)
      .where(sql`${table.requiresAck} AND ${table.ackStatus} IN ('pending', 'question')`),
    index('handoff_item_ticket_idx')
      .on(table.ticketId, table.createdAt.desc())
      .where(sql`${table.ticketId} IS NOT NULL`),
  ],
);

export const shiftNote = pgTable(
  'shift_note',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    audience: text('audience').notNull(),
    toUserId: uuid('to_user_id').references(() => users.id, { onDelete: 'cascade' }),
    deliverAt: timestamptz('deliver_at'),
    body: text('body').notNull(),
    /** References to `staff_upload` rows (migration 0083). */
    attachments: jsonb('attachments')
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    handoffId: uuid('handoff_id').references(() => handoff.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('shift_note_to_idx')
      .on(table.toUserId, table.createdAt.desc())
      .where(sql`${table.toUserId} IS NOT NULL`),
    index('shift_note_audience_idx').on(table.audience, table.createdAt.desc()),
    index('shift_note_author_idx').on(table.authorId, table.createdAt.desc()),
    uniqueIndex('shift_note_handoff_key')
      .on(table.handoffId)
      .where(sql`${table.handoffId} IS NOT NULL`),
  ],
);

export const shiftNoteRead = pgTable(
  'shift_note_read',
  {
    noteId: uuid('note_id')
      .notNull()
      .references(() => shiftNote.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    readAt: timestamptz('read_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.noteId, table.userId] }),
    index('shift_note_read_user_idx').on(table.userId, table.readAt.desc()),
  ],
);
