// Alerts, the service catalog and escalation policies (T-201b, migration 0041). Mirrors the SQL by
// hand; the SQL file is the source of truth (CHECKs, partial unique indexes).
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './auth.js';
import { kbArticle } from './kb.js';
import { teamQueue } from './ticketing.js';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Who is told and after how long. `steps`: `[{ target: 'on_shift' | 'lead' | 'head', afterSeconds }]`. */
export const escalationPolicy = pgTable(
  'escalation_policy',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    steps: jsonb('steps').notNull(),
    /** Exactly one row: the policy a service without its own falls back to. */
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('escalation_policy_name_key').on(sql`lower(${table.name})`),
    uniqueIndex('escalation_policy_default_key')
      .on(table.isDefault)
      .where(sql`${table.isDefault}`),
  ],
);

/** The service catalog (R-3.7). `matchRules` maps an alert to the service; see the shared schema. */
export const service = pgTable(
  'service',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    ownerQueueId: uuid('owner_queue_id').references(() => teamQueue.id, { onDelete: 'set null' }),
    runbookUrl: text('runbook_url'),
    runbookArticleId: uuid('runbook_article_id').references(() => kbArticle.id, {
      onDelete: 'set null',
    }),
    dashboardUrl: text('dashboard_url'),
    matchRules: jsonb('match_rules')
      .notNull()
      .default(sql`'[]'::jsonb`),
    repos: text('repos')
      .array()
      .notNull()
      .default(sql`'{}'`),
    escalationPolicyId: uuid('escalation_policy_id').references(() => escalationPolicy.id, {
      onDelete: 'set null',
    }),
    active: boolean('active').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('service_slug_key').on(table.slug)],
);

/**
 * One row per open fingerprint (partial unique index); `state` is `open`, `acknowledged` or
 * `resolved`. Every timestamp the system decides with is written with the database clock.
 */
export const alert = pgTable(
  'alert',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fingerprint: text('fingerprint').notNull(),
    source: text('source').notNull(),
    serviceId: uuid('service_id').references(() => service.id, { onDelete: 'set null' }),
    severity: text('severity').notNull().default('unknown'),
    state: text('state').notNull().default('open'),
    title: text('title').notNull(),
    summary: text('summary'),
    count: integer('count').notNull().default(1),
    /** Allow-listed keys only (N4): see `sanitizeAlertPayload`. */
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    firstSeenAt: timestamptz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),
    resolvedAt: timestamptz('resolved_at'),
    ackedAt: timestamptz('acked_at'),
    ackedBy: uuid('acked_by').references(() => users.id, { onDelete: 'set null' }),
    /** `web` or `discord`. */
    ackedVia: text('acked_via'),
    escalationLevel: smallint('escalation_level').notNull().default(0),
    nextEscalationAt: timestamptz('next_escalation_at'),
    snoozedUntil: timestamptz('snoozed_until'),
    snoozeReason: text('snooze_reason'),
    /** No foreign key until the incident table exists (T-202a). */
    incidentId: uuid('incident_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('alert_open_fingerprint_key')
      .on(table.fingerprint)
      .where(sql`${table.state} <> 'resolved'`),
    index('alert_list_idx').on(table.lastSeenAt.desc(), table.id.desc()),
    index('alert_state_list_idx').on(table.state, table.lastSeenAt.desc(), table.id.desc()),
    index('alert_service_idx')
      .on(table.serviceId, table.lastSeenAt.desc())
      .where(sql`${table.serviceId} IS NOT NULL`),
    index('alert_unmapped_idx')
      .on(table.lastSeenAt.desc())
      .where(sql`${table.serviceId} IS NULL`),
    index('alert_escalation_due_idx')
      .on(table.nextEscalationAt)
      .where(sql`${table.state} = 'open' AND ${table.nextEscalationAt} IS NOT NULL`),
  ],
);

/** One delivery that changed an alert. `(source, providerEventId)` is the idempotency key. */
export const alertEvent = pgTable(
  'alert_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    alertId: uuid('alert_id')
      .notNull()
      .references(() => alert.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    /** `fired`, `renotified` or `resolved`. */
    type: text('type').notNull(),
    /** The provider's own time, for display only. */
    occurredAt: timestamptz('occurred_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('alert_event_provider_key').on(table.source, table.providerEventId),
    index('alert_event_alert_idx').on(table.alertId, table.createdAt),
  ],
);

/**
 * One step of an escalation policy that was carried out (T-201d, migration 0042): who was told
 * (ids only) and how the chat post of that step went. `(alertId, level)` is unique, so a step happens
 * once however often the sweep runs. The `chat*` columns follow the `discord_notification` ledger:
 * claimed (`sending`) before the post; a mock transport can never record `sent`.
 */
export const alertEscalation = pgTable(
  'alert_escalation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    alertId: uuid('alert_id')
      .notNull()
      .references(() => alert.id, { onDelete: 'cascade' }),
    level: smallint('level').notNull(),
    target: text('target').notNull(),
    fallback: text('fallback'),
    recipientIds: uuid('recipient_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),
    recipientCount: integer('recipient_count').notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    chatState: text('chat_state').notNull().default('pending'),
    chatNextAttemptAt: timestamptz('chat_next_attempt_at').notNull().defaultNow(),
    chatClaimedAt: timestamptz('chat_claimed_at'),
    chatAttempts: integer('chat_attempts').notNull().default(0),
    chatErrorCode: text('chat_error_code'),
    chatChannelId: text('chat_channel_id'),
    chatMessageId: text('chat_message_id'),
    chatSentAt: timestamptz('chat_sent_at'),
  },
  (table) => [
    uniqueIndex('alert_escalation_step_key').on(table.alertId, table.level),
    index('alert_escalation_chat_due_idx')
      .on(table.chatNextAttemptAt)
      .where(sql`${table.chatState} IN ('pending', 'sending')`),
  ],
);
