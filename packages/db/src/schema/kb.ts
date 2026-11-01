// Knowledge base articles, versions, chunks and embeddings (T-107a, migration 0015). The SQL file
// is the source of truth (triggers, privileges, composite foreign keys and CHECKs live there); keep
// both in step by hand and let the integration tests catch drift.
import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
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
import { organization } from './ticketing.js';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * pgvector `vector` with no fixed dimension (models differ; a trigger checks the dimension against
 * the embedding index). The driver sends and returns the text form `[0.1,0.2]`.
 */
export const vectorAny = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (value) => `[${value.join(',')}]`,
  fromDriver: (value) => {
    const inner = value.slice(1, -1);
    return inner === '' ? [] : inner.split(',').map(Number);
  },
});

/** Which model made a set of vectors. At most one row is active (partial unique index). */
export const kbEmbeddingIndex = pgTable(
  'kb_embedding_index',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    isActive: boolean('is_active').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    activatedAt: timestamptz('activated_at'),
  },
  (table) => [
    uniqueIndex('kb_embedding_index_model_key').on(table.provider, table.model, table.dimensions),
    uniqueIndex('kb_embedding_index_active_key')
      .on(table.isActive)
      .where(sql`${table.isActive}`),
  ],
);

export const kbArticle = pgTable(
  'kb_article',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    kind: text('kind').notNull().default('article'),
    lang: text('lang').notNull(),
    status: text('status').notNull().default('draft'),
    visibility: text('visibility').notNull().default('internal'),
    intentTags: text('intent_tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    reviewerId: uuid('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
    lastVerifiedAt: timestamptz('last_verified_at'),
    sources: jsonb('sources')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<{ type: string; ref: string }[]>(),
    /** No `.references()` here: the composite foreign keys (version, article) are in the SQL file. */
    currentVersionId: uuid('current_version_id').notNull(),
    publishedVersionId: uuid('published_version_id'),
    publishedAt: timestamptz('published_at'),
    breakGlassPending: boolean('break_glass_pending').notNull().default(false),
    breakGlassBy: uuid('break_glass_by'),
    breakGlassAt: timestamptz('break_glass_at'),
    breakGlassReason: text('break_glass_reason'),
    breakGlassVersionId: uuid('break_glass_version_id'),
    breakGlassPrevVersion: integer('break_glass_prev_version'),
    /** Everybody who used break-glass while the flag is up; none of them may review it. */
    breakGlassPublishers: uuid('break_glass_publishers')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    reviewVersionId: uuid('review_version_id'),
    breakGlassReviewedBy: uuid('break_glass_reviewed_by'),
    breakGlassReviewedAt: timestamptz('break_glass_reviewed_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('kb_article_slug_key').on(table.slug),
    index('kb_article_status_idx').on(table.status, table.updatedAt.desc()),
  ],
);

/** Immutable: the application role has no UPDATE or DELETE and a trigger rejects both. */
export const kbArticleVersion = pgTable(
  'kb_article_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => kbArticle.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    bodyMd: text('body_md').notNull(),
    changeNote: text('change_note'),
    contentHash: text('content_hash').notNull(),
    createdBy: uuid('created_by'),
    /** Not written by a signed-in person (an AI or a system identity): never published by break-glass. */
    authoredByMachine: boolean('authored_by_machine').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('kb_article_version_number_key').on(table.articleId, table.version)],
);

export const kbArticleOrg = pgTable(
  'kb_article_org',
  {
    articleId: uuid('article_id')
      .notNull()
      .references(() => kbArticle.id, { onDelete: 'restrict' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.articleId, table.orgId] }),
    index('kb_article_org_org_idx').on(table.orgId),
  ],
);

/** A section-sized slice of one version, with its embedding when one exists. Derived data. */
export const kbChunk = pgTable(
  'kb_chunk',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => kbArticle.id, { onDelete: 'restrict' }),
    versionId: uuid('version_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    section: text('section').notNull().default(''),
    text: text('text').notNull(),
    charStart: integer('char_start').notNull(),
    charEnd: integer('char_end').notNull(),
    embedding: vectorAny('embedding'),
    embeddingIndexId: uuid('embedding_index_id').references(() => kbEmbeddingIndex.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('kb_chunk_position_key').on(table.versionId, table.ordinal),
    index('kb_chunk_article_idx').on(table.articleId),
  ],
);
