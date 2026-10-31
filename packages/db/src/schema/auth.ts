import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/**
 * Mirrors migrations/0001_auth_rbac_audit.sql. The SQL file is the source of truth (it carries the
 * check constraints, partitioning and privileges that drizzle-kit cannot express); keep both in
 * step by hand and let the integration tests catch drift.
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    permissions: text('permissions')
      .array()
      .notNull()
      .default(sql`'{}'`),
    status: text('status').notNull().default('active'),
    orgId: uuid('org_id'),
    shiftPreferences: jsonb('shift_preferences')
      .notNull()
      .default(sql`'{}'::jsonb`),
    discordUserId: text('discord_user_id'),
    googleSub: text('google_sub'),
    passwordHash: text('password_hash'),
    isBreakGlass: boolean('is_break_glass').notNull().default(false),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamptz('locked_until'),
    lastLoginAt: timestamptz('last_login_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('users_email_key').on(table.email),
    uniqueIndex('users_google_sub_key')
      .on(table.googleSub)
      .where(sql`${table.googleSub} IS NOT NULL`),
    index('users_org_idx')
      .on(table.orgId)
      .where(sql`${table.orgId} IS NOT NULL`),
  ],
);

export const permissions = pgTable('permissions', {
  key: text('key').primaryKey(),
  description: text('description').notNull(),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    role: text('role').notNull(),
    permission: text('permission')
      .notNull()
      .references(() => permissions.key, { onUpdate: 'cascade', onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.role, table.permission] })],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    authMethod: text('auth_method').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastUsedAt: timestamptz('last_used_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
    revokedReason: text('revoked_reason'),
  },
  (table) => [
    index('sessions_user_active_idx')
      .on(table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    replacedBy: uuid('replaced_by').references((): AnyPgColumn => refreshTokens.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    uniqueIndex('refresh_tokens_hash_key').on(table.tokenHash),
    index('refresh_tokens_session_idx').on(table.sessionId),
  ],
);

export const magicLinkTokens = pgTable(
  'magic_link_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    consumedAt: timestamptz('consumed_at'),
    requestedIp: text('requested_ip'),
  },
  (table) => [
    uniqueIndex('magic_link_tokens_hash_key').on(table.tokenHash),
    index('magic_link_tokens_user_open_idx')
      .on(table.userId)
      .where(sql`${table.consumedAt} IS NULL`),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
