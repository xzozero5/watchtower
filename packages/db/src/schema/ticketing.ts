import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { users } from './auth.js';

/**
 * Mirrors migrations/0002_ticketing.sql. The SQL file is the source of truth (check constraints,
 * partitioning, triggers and privileges live there); keep both in step by hand and let the
 * integration tests catch drift.
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const businessCalendar = pgTable(
  'business_calendar',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    timezone: text('timezone').notNull().default('Asia/Bangkok'),
    hours: jsonb('hours').notNull(),
    holidays: jsonb('holidays')
      .notNull()
      .default(sql`'[]'::jsonb`),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('business_calendar_name_key').on(sql`lower(${table.name})`),
    uniqueIndex('business_calendar_default_key')
      .on(table.isDefault)
      .where(sql`${table.isDefault}`),
  ],
);

export const slaPolicy = pgTable(
  'sla_policy',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    tier: text('tier'),
    targets: jsonb('targets')
      .notNull()
      .default(sql`'{}'::jsonb`),
    businessCalendarId: uuid('business_calendar_id').references(() => businessCalendar.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('sla_policy_name_key').on(sql`lower(${table.name})`),
    uniqueIndex('sla_policy_tier_key')
      .on(table.tier)
      .where(sql`${table.tier} IS NOT NULL`),
  ],
);

export const teamQueue = pgTable(
  'team_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    assignmentMode: text('assignment_mode').notNull().default('manual'),
    isDefault: boolean('is_default').notNull().default(false),
    lastAssignedUserId: uuid('last_assigned_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('team_queue_name_key').on(sql`lower(${table.name})`),
    uniqueIndex('team_queue_default_key')
      .on(table.isDefault)
      .where(sql`${table.isDefault}`),
  ],
);

export const teamQueueMember = pgTable(
  'team_queue_member',
  {
    queueId: uuid('queue_id')
      .notNull()
      .references(() => teamQueue.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.queueId, table.userId] }),
    index('team_queue_member_user_idx').on(table.userId),
  ],
);

export const organization = pgTable(
  'organization',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    tier: text('tier').notNull().default('standard'),
    slaPolicyId: uuid('sla_policy_id').references(() => slaPolicy.id, { onDelete: 'restrict' }),
    domains: text('domains')
      .array()
      .notNull()
      .default(sql`'{}'`),
    lineGroupIds: text('line_group_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),
    healthScore: smallint('health_score'),
    primaryContactId: uuid('primary_contact_id').references((): AnyPgColumn => contact.id, {
      onDelete: 'set null',
    }),
    notes: text('notes').notNull().default(''),
    status: text('status').notNull().default('active'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [index('organization_domains_idx').using('gin', table.domains)],
);

export const contact = pgTable(
  'contact',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    emails: text('emails')
      .array()
      .notNull()
      .default(sql`'{}'`),
    lineUserId: text('line_user_id'),
    phone: text('phone'),
    verifiedAt: timestamptz('verified_at'),
    roleInOrg: text('role_in_org'),
    notificationPrefs: jsonb('notification_prefs')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('contact_org_idx').on(table.orgId),
    index('contact_emails_idx').using('gin', table.emails),
  ],
);

export const channelAccount = pgTable('channel_account', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull(),
  name: text('name').notNull(),
  configEncrypted: bytea('config_encrypted'),
  health: text('health').notNull().default('unknown'),
  quotaUsed: integer('quota_used').notNull().default(0),
  quotaLimit: integer('quota_limit'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const intent = pgTable(
  'intent',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    typicalEvidence: text('typical_evidence').notNull().default(''),
    defaultPriority: text('default_priority').notNull().default('P3'),
    slaPolicyId: uuid('sla_policy_id').references(() => slaPolicy.id, { onDelete: 'set null' }),
    runbookArticleId: uuid('runbook_article_id'),
    allowedTools: text('allowed_tools')
      .array()
      .notNull()
      .default(sql`'{}'`),
    autonomyStage: smallint('autonomy_stage').notNull().default(2),
    procedureVersionId: uuid('procedure_version_id'),
    replyTemplates: jsonb('reply_templates')
      .notNull()
      .default(sql`'[]'::jsonb`),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('intent_key_key').on(table.key)],
);

export const ticketStatusTransition = pgTable(
  'ticket_status_transition',
  {
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
  },
  (table) => [primaryKey({ columns: [table.fromStatus, table.toStatus] })],
);

export const ticket = pgTable(
  'ticket',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    number: bigint('number', { mode: 'number' })
      .notNull()
      .default(sql`nextval('ticket_number_seq')`),
    subject: text('subject').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    requesterContactId: uuid('requester_contact_id').references(() => contact.id, {
      onDelete: 'set null',
    }),
    channelAccountId: uuid('channel_account_id').references(() => channelAccount.id, {
      onDelete: 'restrict',
    }),
    channel: text('channel').notNull().default('portal'),
    intentId: uuid('intent_id').references(() => intent.id, { onDelete: 'restrict' }),
    priority: text('priority').notNull().default('P3'),
    status: text('status').notNull().default('new'),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    queueId: uuid('queue_id').references(() => teamQueue.id, { onDelete: 'set null' }),
    slaPolicyId: uuid('sla_policy_id').references(() => slaPolicy.id, { onDelete: 'restrict' }),
    firstResponseDueAt: timestamptz('first_response_due_at'),
    resolutionDueAt: timestamptz('resolution_due_at'),
    slaPausedAt: timestamptz('sla_paused_at'),
    firstRespondedAt: timestamptz('first_responded_at'),
    resolvedAt: timestamptz('resolved_at'),
    closedAt: timestamptz('closed_at'),
    incidentId: uuid('incident_id'),
    parentTicketId: uuid('parent_ticket_id').references((): AnyPgColumn => ticket.id, {
      onDelete: 'restrict',
    }),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'`),
    customFields: jsonb('custom_fields')
      .notNull()
      .default(sql`'{}'::jsonb`),
    autonomyStageAtCreation: smallint('autonomy_stage_at_creation'),
    aiHandled: boolean('ai_handled').notNull().default(false),
    reopenCount: integer('reopen_count').notNull().default(0),
    csatScore: smallint('csat_score'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ticket_number_key').on(table.number),
    index('ticket_queue_idx').on(
      table.status,
      table.queueId,
      table.priority,
      table.firstResponseDueAt,
    ),
    index('ticket_org_status_idx').on(table.orgId, table.status),
    index('ticket_assignee_status_idx').on(table.assigneeId, table.status),
    index('ticket_created_idx').on(table.createdAt.desc(), table.id.desc()),
    index('ticket_updated_idx').on(table.updatedAt.desc(), table.id.desc()),
    index('ticket_org_created_idx').on(table.orgId, table.createdAt.desc(), table.id.desc()),
    index('ticket_tags_idx').using('gin', table.tags),
  ],
);

export const message = pgTable(
  'message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => ticket.id, { onDelete: 'restrict' }),
    channelAccountId: uuid('channel_account_id').references(() => channelAccount.id, {
      onDelete: 'restrict',
    }),
    direction: text('direction').notNull(),
    externalId: text('external_id'),
    threadKey: text('thread_key'),
    senderContactId: uuid('sender_contact_id').references(() => contact.id, {
      onDelete: 'set null',
    }),
    senderUserId: uuid('sender_user_id').references(() => users.id, { onDelete: 'set null' }),
    bodyText: text('body_text').notNull(),
    bodyHtml: text('body_html'),
    bodyRedacted: text('body_redacted'),
    attachments: jsonb('attachments')
      .notNull()
      .default(sql`'[]'::jsonb`),
    visibility: text('visibility').notNull(),
    deliveryStatus: text('delivery_status').notNull().default('not_applicable'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('message_ticket_idx').on(table.ticketId, table.createdAt),
    uniqueIndex('message_external_key').on(table.channelAccountId, table.externalId),
  ],
);

/**
 * Parent of the monthly partitions (PARTITION BY RANGE (created_at)). Append-only: no UPDATE,
 * DELETE or TRUNCATE for the application role, and a trigger rejects them for everyone.
 */
export const ticketEvent = pgTable(
  'ticket_event',
  {
    id: uuid('id').notNull().defaultRandom(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => ticket.id, { onDelete: 'restrict' }),
    type: text('type').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    visibility: text('visibility').notNull().default('internal'),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.createdAt] }),
    index('ticket_event_ticket_idx').on(table.ticketId, table.createdAt),
  ],
);

export type OrganizationRow = typeof organization.$inferSelect;
export type ContactRow = typeof contact.$inferSelect;
export type TeamQueueRow = typeof teamQueue.$inferSelect;
export type IntentRow = typeof intent.$inferSelect;
export type SlaPolicyRow = typeof slaPolicy.$inferSelect;
export type BusinessCalendarRow = typeof businessCalendar.$inferSelect;
export type TicketRow = typeof ticket.$inferSelect;
export type MessageRow = typeof message.$inferSelect;
export type TicketEventRow = typeof ticketEvent.$inferSelect;
