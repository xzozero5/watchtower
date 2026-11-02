// Saved views and linked tickets (T-119, migration 0066). Mirrors the SQL by hand; the SQL file is the
// source of truth (CHECKs, partial unique indexes and the REVOKE live there).
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './auth.js';
import { deploy, incident } from './incident.js';
import { ticket } from './ticketing.js';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** A named set of ticket filters and a sort: personal, or shared with the team. Built-in views are code. */
export const savedView = pgTable(
  'saved_view',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    shared: boolean('shared').notNull().default(false),
    filters: jsonb('filters')
      .notNull()
      .default(sql`'{}'::jsonb`),
    sort: text('sort').notNull().default('sla_due_asc'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('saved_view_personal_name_key')
      .on(table.ownerId, sql`lower(${table.name})`)
      .where(sql`NOT ${table.shared}`),
    uniqueIndex('saved_view_shared_name_key')
      .on(sql`lower(${table.name})`)
      .where(sql`${table.shared}`),
    index('saved_view_owner_idx').on(table.ownerId),
  ],
);

/**
 * `duplicate`: `fromTicketId` is a duplicate of `toTicketId`. `related`: symmetric, stored with the
 * smaller id first. Never updated (the application role has no UPDATE), only inserted and deleted.
 */
export const ticketLink = pgTable(
  'ticket_link',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    fromTicketId: uuid('from_ticket_id')
      .notNull()
      .references(() => ticket.id, { onDelete: 'restrict' }),
    /** Empty for a link to an incident or a deploy (T-137, migration 0080). */
    toTicketId: uuid('to_ticket_id').references(() => ticket.id, { onDelete: 'restrict' }),
    /** `incident` links: the incident (exactly one of `incidentId`, `deployId` or `toTicketId` is set). */
    incidentId: uuid('incident_id').references(() => incident.id, { onDelete: 'cascade' }),
    deployId: uuid('deploy_id').references(() => deploy.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ticket_link_pair_key').on(table.kind, table.fromTicketId, table.toTicketId),
    index('ticket_link_from_idx').on(table.fromTicketId),
    index('ticket_link_to_idx').on(table.toTicketId),
    uniqueIndex('ticket_link_incident_key')
      .on(table.fromTicketId, table.incidentId)
      .where(sql`${table.incidentId} IS NOT NULL`),
    uniqueIndex('ticket_link_deploy_key')
      .on(table.fromTicketId, table.deployId)
      .where(sql`${table.deployId} IS NOT NULL`),
  ],
);

export type SavedViewRow = typeof savedView.$inferSelect;
export type TicketLinkRow = typeof ticketLink.$inferSelect;
