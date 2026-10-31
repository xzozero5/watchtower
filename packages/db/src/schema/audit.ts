import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Parent of the monthly partitions created by migration 0001 (PARTITION BY RANGE (created_at)).
 * Append-only: the application role has no UPDATE, DELETE or TRUNCATE, and a trigger rejects them
 * for every role. Insert and read through this table; never address a partition directly.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').notNull().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    outcome: text('outcome').notNull().default('success'),
    targetType: text('target_type'),
    targetId: text('target_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    requestId: text('request_id'),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.createdAt] }),
    index('audit_log_created_idx').on(table.createdAt.desc(), table.id.desc()),
    index('audit_log_actor_idx').on(table.actorId, table.createdAt.desc()),
    index('audit_log_target_idx').on(table.targetType, table.targetId, table.createdAt.desc()),
    index('audit_log_action_idx').on(table.action, table.createdAt.desc()),
  ],
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
