/**
 * Knowledge base (T-107): this feature's own audit actions, ticket event types and queue names (T-123a),
 * and the API contracts of articles, versions and search (PRD R-4.1 to R-4.3).
 *
 * The task that owns this feature adds entries here and nowhere else in `packages/shared`. The
 * global `AUDIT_ACTIONS`, `TICKET_EVENT_TYPES` and `QUEUE_NAMES` are composed from these records
 * (see `./index.ts`), and importing `@watchtower/shared` throws if two features use the same key
 * or the same value. Keys are camelCase; values are lowercase strings (dotted for audit actions and
 * ticket events, the BullMQ queue name for queues). Start a value with the feature name so
 * collisions are unlikely.
 */
import { z } from 'zod';

import { cursorSchema, pageLimit } from '../common.js';

/** Audit `action` strings written by this feature. */
export const KB_AUDIT_ACTIONS = {
  /** An article was created (draft, version 1). */
  kbArticleCreate: 'kb.article.create',
  /** An article was edited: a new immutable version was added (or only its metadata changed). */
  kbArticleUpdate: 'kb.article.update',
  /** The status moved (draft, in_review, deprecated) without publishing. */
  kbArticleStatus: 'kb.article.status',
  /** A version went live (what search and customers see). */
  kbArticlePublish: 'kb.article.publish',
  /** The head published without a second person, with a reason (flagged for review). */
  kbArticlePublishBreakGlass: 'kb.article.publish_break_glass',
  /** Another approver reviewed a break-glass publication and cleared its flag. */
  kbArticleBreakGlassReview: 'kb.article.break_glass_review',
  /** A live article was shown to more people (by someone who did not write it). */
  kbArticleAudienceWiden: 'kb.article.audience_widen',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const KB_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: api, consumer: worker). */
export const KB_QUEUES = {
  /** Chunk and embed published articles (T-107b). */
  kb: 'kb',
} as const satisfies Record<string, string>;

export const KB_JOBS = {
  /** Rebuild the chunks and embeddings of one published version. `jobId` is per version. */
  embedArticle: 'embed_article',
  /** Embed again everything whose vectors are not from the active embedding index. */
  reembedAll: 'reembed_all',
} as const;

export const embedArticleJobSchema = z.object({ articleId: z.uuid(), versionId: z.uuid() });
export type EmbedArticleJob = z.infer<typeof embedArticleJobSchema>;

/** Retry with backoff; the chunks are the record, so a finished job is dropped. */
export const KB_OUTBOX_JOB_OPTIONS = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

// --- vocabulary (PRD R-4.1) ---

export const KB_LANGS = ['th', 'en'] as const;
export const kbLangSchema = z.enum(KB_LANGS);
export type KbLang = z.infer<typeof kbLangSchema>;

export const KB_KINDS = ['article', 'runbook'] as const;
export const kbKindSchema = z.enum(KB_KINDS);
export type KbKind = z.infer<typeof kbKindSchema>;

export const KB_STATUSES = ['draft', 'in_review', 'published', 'deprecated'] as const;
export const kbStatusSchema = z.enum(KB_STATUSES);
export type KbStatus = z.infer<typeof kbStatusSchema>;

/** internal: staff only. customer: every client. orgs: only the organizations listed on the article. */
export const KB_VISIBILITIES = ['internal', 'customer', 'orgs'] as const;
export const kbVisibilitySchema = z.enum(KB_VISIBILITIES);
export type KbVisibility = z.infer<typeof kbVisibilitySchema>;

/**
 * Text that Postgres can store: a NUL character (U+0000) is refused by the database, so it is
 * refused here with a 400 instead of reaching a query (and a 500 and an error log) from there.
 */
export const noNul = (schema: z.ZodString) =>
  schema.refine((value) => !value.includes('\u0000'), {
    message: 'must not contain a NUL character',
  });

/**
 * `sources[].ref` is free text, and a `url` source may hold any scheme. Like every text field and
 * every search `snippet` below, it is raw: the UI (T-107e) must escape it, render Markdown without
 * raw HTML, and open a link only when its scheme is http or https (never `javascript:`).
 */
export const KB_SOURCE_TYPES = ['ticket', 'incident', 'commit', 'runbook', 'url'] as const;
export const kbSourceSchema = z.object({
  type: z.enum(KB_SOURCE_TYPES),
  ref: noNul(z.string().trim().min(1).max(500)),
});
export type KbSource = z.infer<typeof kbSourceSchema>;

export const KB_SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,118}[a-z0-9])?$/;
export const kbSlugSchema = z
  .string()
  .regex(KB_SLUG_PATTERN, 'lowercase letters, digits and hyphens, up to 120 characters');

const INTENT_TAG = /^[a-z][a-z0-9_]{1,62}$/;
export const kbTitleSchema = noNul(z.string().trim().min(1).max(300));
/**
 * 30,000 characters `[ASSUMED]`: about 5,000 words, far above a help article. It also keeps a
 * request (Thai takes 3 bytes a character in UTF-8) under the 100 kB default JSON limit of the api;
 * raising it means raising that limit first.
 */
export const KB_MAX_BODY_CHARS = 30_000;
export const kbBodySchema = noNul(z.string().max(KB_MAX_BODY_CHARS));

// --- articles ---

const articleFields = {
  title: kbTitleSchema,
  bodyMd: kbBodySchema,
  lang: kbLangSchema,
  kind: kbKindSchema.default('article'),
  visibility: kbVisibilitySchema.default('internal'),
  /** The organizations that may see the article; used (and required) when `visibility` is `orgs`. */
  orgIds: z.array(z.uuid()).max(500).default([]),
  intentTags: z.array(z.string().regex(INTENT_TAG)).max(50).default([]),
  sources: z.array(kbSourceSchema).max(100).default([]),
};

export const createKbArticleSchema = z
  .object({
    slug: kbSlugSchema,
    ...articleFields,
    changeNote: noNul(z.string().trim().max(500)).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.visibility === 'orgs' && value.orgIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['orgIds'],
        message: 'visibility "orgs" needs at least one organization',
      });
    }
  });
export type CreateKbArticle = z.infer<typeof createKbArticleSchema>;

export const updateKbArticleSchema = z
  .object({
    title: articleFields.title,
    bodyMd: articleFields.bodyMd,
    kind: kbKindSchema,
    visibility: kbVisibilitySchema,
    orgIds: z.array(z.uuid()).max(500),
    intentTags: z.array(z.string().regex(INTENT_TAG)).max(50),
    sources: z.array(kbSourceSchema).max(100),
    /** Set when a person has checked the article against reality (R-4.1 "last verified"). */
    lastVerifiedAt: z.iso.datetime().nullable(),
    changeNote: noNul(z.string().trim().max(500)),
    /**
     * The version the editor was looking at. When another edit came in meanwhile the request is
     * refused with 409 instead of silently overwriting it.
     */
    expectedVersion: z.number().int().positive(),
  })
  .partial()
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'expectedVersion' && key !== 'changeNote'),
    { message: 'nothing to update' },
  );
export type UpdateKbArticle = z.infer<typeof updateKbArticleSchema>;

export const KB_TRANSITIONS = ['draft', 'in_review', 'deprecated'] as const;
export const kbTransitionSchema = z.object({
  to: z.enum(KB_TRANSITIONS),
  reason: noNul(z.string().trim().max(500)).optional(),
});
export type KbTransition = z.infer<typeof kbTransitionSchema>;

export const publishKbArticleSchema = z.object({
  /** The version to publish. Refused with 409 if it is no longer the latest, so no one publishes unseen text. */
  version: z.number().int().positive(),
  /**
   * Who will be able to read it, as the approver saw it (`visibility` and `orgIds` of the article).
   * Refused with 409 if the audience changed since, so no one publishes to an audience they did not see.
   */
  visibility: kbVisibilitySchema,
  orgIds: z.array(z.uuid()).max(500).default([]),
});
export type PublishKbArticle = z.infer<typeof publishKbArticleSchema>;

/** Break-glass: the same as a publication, with the reason the second person was skipped. */
export const breakGlassPublishKbArticleSchema = publishKbArticleSchema.extend({
  reason: noNul(z.string().trim().min(1).max(1000)),
});
export type BreakGlassPublishKbArticle = z.infer<typeof breakGlassPublishKbArticleSchema>;

/** What the reviewer saw: which break-glass publication this review is about. */
export const reviewKbBreakGlassSchema = z.object({
  /** `breakGlass.at` of the article as the reviewer saw it. A newer break-glass publication is another one (409). */
  breakGlassAt: z.iso.datetime(),
});
export type ReviewKbBreakGlass = z.infer<typeof reviewKbBreakGlassSchema>;

export const kbBreakGlassSchema = z.object({
  /** True until another approver has reviewed the publication. */
  pending: z.boolean(),
  /** The version number that went live break-glass. */
  version: z.number().int().nullable(),
  by: z.uuid().nullable(),
  at: z.iso.datetime().nullable(),
  reason: z.string().nullable(),
  reviewedBy: z.uuid().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
});
export type KbBreakGlass = z.infer<typeof kbBreakGlassSchema>;

export const kbArticleSummarySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  kind: kbKindSchema,
  lang: kbLangSchema,
  status: kbStatusSchema,
  visibility: kbVisibilitySchema,
  intentTags: z.array(z.string()),
  /** Latest edit. */
  version: z.number().int(),
  /** The version that is live, if any. */
  publishedVersion: z.number().int().nullable(),
  /** True when the latest edit is not the live one yet. */
  hasUnpublishedChanges: z.boolean(),
  /**
   * The latest edit was sent for review and waits for an approver. A live article with a newer
   * version needs this before it can be published (status stays `published`).
   */
  reviewRequested: z.boolean(),
  /** The live version was published break-glass and no other approver has reviewed it yet. */
  breakGlassPending: z.boolean(),
  lastVerifiedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});
export type KbArticleSummary = z.infer<typeof kbArticleSummarySchema>;

export const kbArticleSchema = kbArticleSummarySchema.extend({
  /** Latest edit, which is what an editor works on. */
  bodyMd: z.string(),
  orgIds: z.array(z.uuid()),
  sources: z.array(kbSourceSchema),
  authorId: z.uuid().nullable(),
  reviewerId: z.uuid().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  /** Null unless the article was ever published break-glass. */
  breakGlass: kbBreakGlassSchema.nullable(),
  createdAt: z.iso.datetime(),
});
export type KbArticle = z.infer<typeof kbArticleSchema>;

export const kbArticleListQuerySchema = z.object({
  status: kbStatusSchema.optional(),
  visibility: kbVisibilitySchema.optional(),
  lang: kbLangSchema.optional(),
  kind: kbKindSchema.optional(),
  intentTag: z.string().regex(INTENT_TAG).optional(),
  /** `true`: only articles whose break-glass publication still waits for a review. */
  breakGlassPending: z.stringbool().optional(),
  limit: pageLimit(50, 100),
  cursor: cursorSchema.optional(),
});
export type KbArticleListQuery = z.infer<typeof kbArticleListQuerySchema>;

export const kbArticlePageSchema = z.object({
  items: z.array(kbArticleSummarySchema),
  nextCursor: z.string().nullable(),
});
export type KbArticlePage = z.infer<typeof kbArticlePageSchema>;

export const kbVersionSummarySchema = z.object({
  version: z.number().int(),
  title: z.string(),
  changeNote: z.string().nullable(),
  createdBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  isCurrent: z.boolean(),
  isPublished: z.boolean(),
});
export type KbVersionSummary = z.infer<typeof kbVersionSummarySchema>;

export const kbVersionSchema = kbVersionSummarySchema.extend({ bodyMd: z.string() });
export type KbVersion = z.infer<typeof kbVersionSchema>;

export const kbVersionListSchema = z.object({ items: z.array(kbVersionSummarySchema) });
export type KbVersionList = z.infer<typeof kbVersionListSchema>;

export const kbVersionParamSchema = z.object({
  id: z.uuid(),
  version: z.coerce.number().int().positive(),
});

// --- search (R-4.2) ---

export const KB_SEARCH_AUDIENCES = ['staff', 'customer'] as const;

/** `hybrid`: keyword and vector were fused. `keyword`: no usable embedding, so keyword only (N5: it says so). */
export const KB_SEARCH_MODES = ['hybrid', 'keyword'] as const;
export const kbSearchModeSchema = z.enum(KB_SEARCH_MODES);
export type KbSearchMode = z.infer<typeof kbSearchModeSchema>;

const searchQuery = noNul(z.string().trim().min(1).max(500));

export const kbSearchQuerySchema = z.object({
  q: searchQuery,
  limit: pageLimit(8, 20),
  lang: kbLangSchema.optional(),
  /**
   * `customer` shows what a customer would get (preview for staff, and what the AI may cite to a
   * customer). With `orgId` it applies that organization's audience too.
   */
  audience: z.enum(KB_SEARCH_AUDIENCES).default('staff'),
  orgId: z.uuid().optional(),
});
export type KbSearchQuery = z.infer<typeof kbSearchQuerySchema>;

export const kbCustomerSearchQuerySchema = z.object({
  q: searchQuery,
  limit: pageLimit(5, 10),
  lang: kbLangSchema.optional(),
});
export type KbCustomerSearchQuery = z.infer<typeof kbCustomerSearchQuerySchema>;

/** What a customer may see of a hit: no status, no internal tags, no scores. */
export const kbCustomerHitSchema = z.object({
  articleId: z.uuid(),
  slug: z.string(),
  title: z.string(),
  lang: kbLangSchema,
  /** Heading path of the section, for a citation down to section level. */
  section: z.string(),
  snippet: z.string(),
});
export type KbCustomerHit = z.infer<typeof kbCustomerHitSchema>;

export const kbSearchHitSchema = kbCustomerHitSchema.extend({
  chunkId: z.uuid(),
  versionId: z.uuid(),
  version: z.number().int(),
  kind: kbKindSchema,
  visibility: kbVisibilitySchema,
  intentTags: z.array(z.string()),
  lastVerifiedAt: z.iso.datetime().nullable(),
  /** Reciprocal Rank Fusion score (higher is better). Only comparable within one response. */
  score: z.number(),
  /** 1-based rank of this chunk in each list, absent when it was not in that list. */
  keywordRank: z.number().int().positive().nullable(),
  vectorRank: z.number().int().positive().nullable(),
});
export type KbSearchHit = z.infer<typeof kbSearchHitSchema>;

export const kbSearchResultSchema = z.object({
  mode: kbSearchModeSchema,
  hits: z.array(kbSearchHitSchema),
});
export type KbSearchResult = z.infer<typeof kbSearchResultSchema>;

export const kbCustomerSearchResultSchema = z.object({ hits: z.array(kbCustomerHitSchema) });
export type KbCustomerSearchResult = z.infer<typeof kbCustomerSearchResultSchema>;

/** Chunking limits in characters `[ASSUMED]`; the worker reads overrides from its environment. */
export const KB_CHUNK_DEFAULTS = {
  /** Aim for chunks about this long. */
  targetChars: 900,
  /** Never longer than this (a longer paragraph is split at a sentence or grapheme boundary). */
  maxChars: 1400,
  /** A chunk this short is merged into its neighbour of the same section. */
  minChars: 120,
  /** Tail of the previous chunk repeated at the start of the next one when a section is split. */
  overlapChars: 120,
} as const;

/**
 * Live embedding (Vertex) needs credentials and an egress decision, which are the owner's
 * (`[ASK-HUMAN]`), so only `mock` is wired. A different `EMBEDDING_PROVIDER` stops the api and the
 * worker at boot with this message instead of being ignored and silently searching by keyword (N5).
 */
export function assertKbEmbeddingProvider(provider: string): void {
  if (provider !== 'mock') {
    throw new Error(
      `EMBEDDING_PROVIDER=${provider} is not wired yet: only "mock" is available until live embedding is approved by the owner. Set EMBEDDING_PROVIDER=mock.`,
    );
  }
}
