// The public status page (T-204a, migration 0060). Mirrors the SQL by hand; the SQL file is the source of
// truth (CHECKs, among them the N3 rule that only a person publishes).
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { service } from './alerting.js';
import { users } from './auth.js';
import { incident } from './incident.js';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** What the page lists. Off the page until `public` is set. */
export const statusComponent = pgTable(
  'status_component',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    serviceId: uuid('service_id').references(() => service.id, { onDelete: 'set null' }),
    public: boolean('public').notNull().default(false),
    position: integer('position').notNull().default(0),
    /** `operational`, `degraded_performance`, `partial_outage`, `major_outage`, `under_maintenance`. */
    status: text('status').notNull().default('operational'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('status_component_slug_key').on(table.slug)],
);

/** An announcement: a draft until a person publishes it (`published_by` is required once published, N3). */
export const statusPost = pgTable(
  'status_post',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    incidentId: uuid('incident_id').references(() => incident.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** `investigating`, `identified`, `monitoring`, `resolved`. */
    phase: text('phase').notNull().default('investigating'),
    /** `none`, `minor`, `major`, `critical`. */
    impact: text('impact').notNull().default('minor'),
    /** `draft`, `published`. */
    state: text('state').notNull().default('draft'),
    /** `human` or `ai`: who wrote the first draft. */
    origin: text('origin').notNull(),
    draftedBy: uuid('drafted_by').references(() => users.id, { onDelete: 'set null' }),
    publishedBy: uuid('published_by').references(() => users.id, { onDelete: 'set null' }),
    publishedAt: timestamptz('published_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('status_post_public_idx')
      .on(table.publishedAt.desc())
      .where(sql`${table.state} = 'published'`),
    index('status_post_list_idx').on(table.createdAt.desc(), table.id.desc()),
  ],
);

export const statusPostComponent = pgTable(
  'status_post_component',
  {
    postId: uuid('post_id')
      .notNull()
      .references(() => statusPost.id, { onDelete: 'cascade' }),
    componentId: uuid('component_id')
      .notNull()
      .references(() => statusComponent.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.postId, table.componentId] })],
);

/** A scheduled maintenance window; public only once a person published it. */
export const statusMaintenance = pgTable('status_maintenance', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  startsAt: timestamptz('starts_at').notNull(),
  endsAt: timestamptz('ends_at').notNull(),
  /** `draft`, `published`, `cancelled`. */
  state: text('state').notNull().default('draft'),
  origin: text('origin').notNull(),
  draftedBy: uuid('drafted_by').references(() => users.id, { onDelete: 'set null' }),
  publishedBy: uuid('published_by').references(() => users.id, { onDelete: 'set null' }),
  publishedAt: timestamptz('published_at'),
  cancelledAt: timestamptz('cancelled_at'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const statusMaintenanceComponent = pgTable(
  'status_maintenance_component',
  {
    maintenanceId: uuid('maintenance_id')
      .notNull()
      .references(() => statusMaintenance.id, { onDelete: 'cascade' }),
    componentId: uuid('component_id')
      .notNull()
      .references(() => statusComponent.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.maintenanceId, table.componentId] })],
);

/** An email subscription with double opt-in. The signed links are derived from the id and the nonces. */
export const statusSubscription = pgTable(
  'status_subscription',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    locale: text('locale').notNull().default('en'),
    /** `pending`, `confirmed`, `unsubscribed`. */
    state: text('state').notNull().default('pending'),
    confirmNonce: text('confirm_nonce').notNull(),
    unsubscribeNonce: text('unsubscribe_nonce').notNull(),
    confirmExpiresAt: timestamptz('confirm_expires_at'),
    confirmationSentAt: timestamptz('confirmation_sent_at'),
    confirmedAt: timestamptz('confirmed_at'),
    unsubscribedAt: timestamptz('unsubscribed_at'),
    /** Hard bounces in a row since the last mail the address accepted (migration 0093, T-207a C-7). */
    bounceCount: integer('bounce_count').notNull().default(0),
    /** The worker stopped mailing the address after too many hard bounces; a new request sends nothing while set. */
    suppressedAt: timestamptz('suppressed_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('status_subscription_email_key').on(table.email)],
);

/** Who was told about which post or window, once. */
export const statusNotification = pgTable(
  'status_notification',
  {
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => statusSubscription.id, { onDelete: 'cascade' }),
    /** `post` or `maintenance`. */
    refKind: text('ref_kind').notNull(),
    refId: uuid('ref_id').notNull(),
    sentAt: timestamptz('sent_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.subscriptionId, table.refKind, table.refId] })],
);
