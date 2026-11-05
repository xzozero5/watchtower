// Embedded insights (T-414, ADR-029 section 9, migration 0113). Mirrors the SQL by hand; the SQL file is the
// source of truth (CHECKs). Written only by the worker; the api reads (boundary lint, C-15).
import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { organization } from './ticketing.js';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** The stored narration of one screen element for one audience and language. */
export const aiElementInsight = pgTable(
  'ai_element_insight',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** A key of `INSIGHT_ELEMENTS` in `@watchtower/shared`. */
    element: text('element').notNull(),
    /** `instance`, `org:<uuid>`, `intent:<uuid>`, `incident:<uuid>` or `service:<uuid>`. */
    scopeKey: text('scope_key').notNull(),
    /** `d7`, `now`, `shift:<id>`, `w2026-45` or `-`. */
    period: text('period').notNull(),
    locale: text('locale').notNull().$type<'th' | 'en'>(),
    orgId: uuid('org_id').references(() => organization.id, { onDelete: 'cascade' }),
    /** The facts the narration was made from (allow-list, view `full`). */
    facts: jsonb('facts').notNull().$type<unknown[]>(),
    factsFingerprint: text('facts_fingerprint').notNull(),
    /** `InsightStoredClaim[]`: redacted text, evidence = fact ids. */
    claims: jsonb('claims').notNull().$type<unknown[]>(),
    promptId: text('prompt_id').notNull(),
    promptVersion: text('prompt_version').notNull(),
    model: text('model').notNull(),
    /** No foreign key: `ai_run` is partitioned. */
    aiRunId: uuid('ai_run_id'),
    mock: boolean('mock').notNull().default(false),
    generatedAt: timestamptz('generated_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (table) => [
    unique('ai_element_insight_key').on(table.element, table.scopeKey, table.period, table.locale),
    index('ai_element_insight_expires_idx').on(table.expiresAt),
    index('ai_element_insight_org_idx')
      .on(table.orgId)
      .where(sql`${table.orgId} IS NOT NULL`),
    index('ai_element_insight_run_idx')
      .on(table.aiRunId)
      .where(sql`${table.aiRunId} IS NOT NULL`),
  ],
);
