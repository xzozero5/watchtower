import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  DEFAULT_AI_DAILY_TOKEN_CAP,
  KbSearchTimeoutError,
  searchKb,
  type Actor,
  type Domain,
  type KbAudience,
} from '@watchtower/domain';
import type {
  CreateKbArticle,
  KbArticle,
  KbArticleListQuery,
  KbArticlePage,
  KbArticleSummary,
  KbCustomerSearchResult,
  KbSearchQuery,
  KbSearchResult,
  KbTransition,
  KbVersion,
  KbVersionList,
  BreakGlassPublishKbArticle,
  PublishKbArticle,
  ReviewKbBreakGlass,
  UpdateKbArticle,
} from '@watchtower/shared';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { kbSearchTimeout, notFound } from '../auth/http-errors.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { beforeCursor, decodeCursor, preciseTimestamp, toPage } from '../common/keyset.js';
import { DATABASE } from '../database/database.module.js';
import { domainContext, settle } from '../domain/domain-context.js';
import { translating } from '../domain/domain-errors.js';
import { DOMAIN } from '../domain/domain.module.js';
import type { UnitOfWork } from '../realtime/unit-of-work.js';
import { KbEmbeddingService } from './kb-embedding.service.js';
import { KbSearchError } from './kb-errors.js';

/**
 * `[ASSUMED]` Budget of customer search embeddings (po decision): customers draw on the app's AI
 * budget, so they get their own daily slice. The slice is 20% of the daily token cap
 * (`config/budgets.yaml` `app_ai_daily.tokens`), spent at a worst-case estimate of 100 tokens per
 * query (a query is at most 500 characters; typical ones are a tenth of that), and one organization
 * may use at most `CUSTOMER_EMBEDS_PER_ORG_PER_DAY` of it. When either is used up the search carries
 * on by keyword only, with no error. The day is the UTC day, like the budget itself.
 */
export const CUSTOMER_EMBED_BUDGET_SHARE = 0.2;
export const ESTIMATED_TOKENS_PER_QUERY = 100;
export const CUSTOMER_EMBEDS_PER_ORG_PER_DAY = 200;
const DAY_SECONDS = 24 * 60 * 60 + 3600;

/** How many customer query embeddings the whole instance may make in one UTC day. */
export function customerEmbedsPerDay(dailyTokenCap: number | undefined): number {
  return Math.max(
    1,
    Math.floor(
      ((dailyTokenCap ?? DEFAULT_AI_DAILY_TOKEN_CAP) * CUSTOMER_EMBED_BUDGET_SHARE) /
        ESTIMATED_TOKENS_PER_QUERY,
    ),
  );
}

type Reader = Pick<Database['db'], 'select'>;
type ArticleRow = typeof schema.kbArticle.$inferSelect;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function summaryOf(
  article: ArticleRow,
  current: { id: string; version: number; title: string },
  publishedVersion: number | null,
): KbArticleSummary {
  return {
    id: article.id,
    slug: article.slug,
    title: current.title,
    kind: article.kind as KbArticleSummary['kind'],
    lang: article.lang as KbArticleSummary['lang'],
    status: article.status as KbArticleSummary['status'],
    visibility: article.visibility as KbArticleSummary['visibility'],
    intentTags: article.intentTags,
    version: current.version,
    publishedVersion,
    hasUnpublishedChanges: publishedVersion !== current.version,
    // A draft sent for review is `in_review`; a live article names the version in review_version_id.
    reviewRequested:
      article.status === 'in_review' ||
      (article.status === 'published' && article.reviewVersionId === current.id),
    breakGlassPending: article.breakGlassPending,
    lastVerifiedAt: iso(article.lastVerifiedAt),
    updatedAt: article.updatedAt.toISOString(),
  };
}

/**
 * Knowledge base articles and search for the api (T-107). The rules live in `@watchtower/domain`
 * (ADR-009); this is the Nest face of it: it reads for display, hands the audit mark to the request
 * and answers the domain's refusals with the api's HTTP errors.
 */
@Injectable()
export class KbService {
  constructor(
    @Inject(DOMAIN) private readonly domain: Domain,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(KbEmbeddingService) private readonly embeddings: KbEmbeddingService,
    @Inject(APP_CONFIG)
    private readonly config: Pick<ApiConfig, 'KB_MIN_VECTOR_SIMILARITY' | 'AI_DAILY_TOKEN_CAP'>,
    @Inject(RateLimiter) private readonly limiter: Pick<RateLimiter, 'hit'>,
  ) {}

  /**
   * True while this customer's organization and the customers as a whole are within their daily
   * slice of the AI budget. A counter that cannot be read (Redis down) counts as used up: spending
   * is the thing that fails closed, the search itself goes on by keyword.
   */
  private async customerMayEmbed(orgId: string): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10);
    try {
      const org = await this.limiter.hit(
        'kb-customer-embed-org',
        `${orgId}:${day}`,
        CUSTOMER_EMBEDS_PER_ORG_PER_DAY,
        DAY_SECONDS,
      );
      if (!org.allowed) return false;
      const all = await this.limiter.hit(
        'kb-customer-embed-day',
        day,
        customerEmbedsPerDay(this.config.AI_DAILY_TOKEN_CAP),
        DAY_SECONDS,
      );
      return all.allowed;
    } catch {
      return false;
    }
  }

  // --- reads ---

  async list(query: KbArticleListQuery): Promise<KbArticlePage> {
    const { kbArticle: article, kbArticleVersion: version } = schema;
    const published = alias(schema.kbArticleVersion, 'published_version');
    const rows = await this.database.db
      .select({
        article,
        current: { id: version.id, version: version.version, title: version.title },
        publishedVersion: published.version,
        sortKey: preciseTimestamp(article.updatedAt),
      })
      .from(article)
      .innerJoin(version, eq(version.id, article.currentVersionId))
      .leftJoin(published, eq(published.id, article.publishedVersionId))
      .where(
        and(
          query.status === undefined ? undefined : eq(article.status, query.status),
          query.visibility === undefined ? undefined : eq(article.visibility, query.visibility),
          query.lang === undefined ? undefined : eq(article.lang, query.lang),
          query.kind === undefined ? undefined : eq(article.kind, query.kind),
          query.breakGlassPending === undefined
            ? undefined
            : eq(article.breakGlassPending, query.breakGlassPending),
          query.intentTag === undefined
            ? undefined
            : sql`${query.intentTag} = ANY(${article.intentTags})`,
          query.cursor === undefined
            ? undefined
            : beforeCursor(article.updatedAt, article.id, decodeCursor(query.cursor)),
        ),
      )
      .orderBy(desc(article.updatedAt), desc(article.id))
      .limit(query.limit + 1);
    const page = toPage(
      rows.map((row) => ({ ...row, id: row.article.id })),
      query.limit,
    );
    return {
      items: page.rows.map((row) => summaryOf(row.article, row.current, row.publishedVersion)),
      nextCursor: page.nextCursor,
    };
  }

  async get(id: string, reader: Reader = this.database.db): Promise<KbArticle> {
    const { kbArticle: article, kbArticleVersion: version } = schema;
    const published = alias(schema.kbArticleVersion, 'published_version');
    const breakGlassVersion = alias(schema.kbArticleVersion, 'break_glass_version');
    const [row] = await reader
      .select({
        article,
        current: version,
        publishedVersion: published.version,
        breakGlassVersion: breakGlassVersion.version,
      })
      .from(article)
      .innerJoin(version, eq(version.id, article.currentVersionId))
      .leftJoin(published, eq(published.id, article.publishedVersionId))
      .leftJoin(breakGlassVersion, eq(breakGlassVersion.id, article.breakGlassVersionId))
      .where(eq(article.id, id))
      .limit(1);
    if (row === undefined) throw notFound('No such article');
    const orgs = await reader
      .select({ orgId: schema.kbArticleOrg.orgId })
      .from(schema.kbArticleOrg)
      .where(eq(schema.kbArticleOrg.articleId, id))
      .orderBy(asc(schema.kbArticleOrg.orgId));
    return {
      ...summaryOf(row.article, row.current, row.publishedVersion),
      bodyMd: row.current.bodyMd,
      orgIds: orgs.map((org) => org.orgId),
      sources: row.article.sources as KbArticle['sources'],
      authorId: row.article.authorId,
      reviewerId: row.article.reviewerId,
      publishedAt: iso(row.article.publishedAt),
      breakGlass:
        row.article.breakGlassAt === null
          ? null
          : {
              pending: row.article.breakGlassPending,
              version: row.breakGlassVersion,
              by: row.article.breakGlassBy,
              at: iso(row.article.breakGlassAt),
              reason: row.article.breakGlassReason,
              reviewedBy: row.article.breakGlassReviewedBy,
              reviewedAt: iso(row.article.breakGlassReviewedAt),
            },
      createdAt: row.article.createdAt.toISOString(),
    };
  }

  async versions(id: string): Promise<KbVersionList> {
    const { kbArticle: article, kbArticleVersion: version } = schema;
    const [found] = await this.database.db
      .select({
        currentVersionId: article.currentVersionId,
        publishedVersionId: article.publishedVersionId,
      })
      .from(article)
      .where(eq(article.id, id))
      .limit(1);
    if (found === undefined) throw notFound('No such article');
    const rows = await this.database.db
      .select({
        id: version.id,
        version: version.version,
        title: version.title,
        changeNote: version.changeNote,
        createdBy: version.createdBy,
        createdAt: version.createdAt,
      })
      .from(version)
      .where(eq(version.articleId, id))
      .orderBy(desc(version.version));
    return {
      items: rows.map((row) => ({
        version: row.version,
        title: row.title,
        changeNote: row.changeNote,
        createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(),
        isCurrent: row.id === found.currentVersionId,
        isPublished: row.id === found.publishedVersionId,
      })),
    };
  }

  async version(id: string, number: number): Promise<KbVersion> {
    const { kbArticle: article, kbArticleVersion: version } = schema;
    const [row] = await this.database.db
      .select({
        version,
        currentVersionId: article.currentVersionId,
        publishedVersionId: article.publishedVersionId,
      })
      .from(version)
      .innerJoin(article, eq(article.id, version.articleId))
      .where(and(eq(version.articleId, id), eq(version.version, number)))
      .limit(1);
    if (row === undefined) throw notFound('No such version');
    return {
      version: row.version.version,
      title: row.version.title,
      bodyMd: row.version.bodyMd,
      changeNote: row.version.changeNote,
      createdBy: row.version.createdBy,
      createdAt: row.version.createdAt.toISOString(),
      isCurrent: row.version.id === row.currentVersionId,
      isPublished: row.version.id === row.publishedVersionId,
    };
  }

  // --- search ---

  /**
   * Staff search. `audience: 'customer'` answers what a customer would see (a preview, and what the
   * AI may cite to a customer); with `orgId` it applies that organization's audience as well.
   */
  async search(query: KbSearchQuery): Promise<KbSearchResult> {
    const audience: KbAudience =
      query.audience === 'staff'
        ? { kind: 'staff' }
        : { kind: 'customer', orgId: query.orgId ?? null };
    return this.run(query.q, audience, query.limit, query.lang);
  }

  /** Customer search: only what the caller's organization may read (never an internal article). */
  async searchForCustomer(
    orgId: string,
    query: { q: string; limit: number; lang?: KbSearchQuery['lang'] },
  ): Promise<KbCustomerSearchResult> {
    const result = await this.run(
      query.q,
      { kind: 'customer', orgId },
      query.limit,
      query.lang,
      await this.customerMayEmbed(orgId),
    );
    // Strip down to what a customer may see: no status, tags, scores or internal ids.
    return {
      hits: result.hits.map((hit) => ({
        articleId: hit.articleId,
        slug: hit.slug,
        title: hit.title,
        lang: hit.lang,
        section: hit.section,
        snippet: hit.snippet,
      })),
    };
  }

  private async run(
    q: string,
    audience: KbAudience,
    limit: number,
    lang: KbSearchQuery['lang'],
    mayEmbed = true,
  ): Promise<KbSearchResult> {
    const embedding = mayEmbed ? await this.embeddings.embedQuery(q) : undefined;
    try {
      const outcome = await searchKb(this.database.db, {
        query: q,
        audience,
        limit,
        lang,
        embedding,
        minVectorSimilarity: this.config.KB_MIN_VECTOR_SIMILARITY,
      });
      return { mode: outcome.mode, hits: outcome.hits };
    } catch (error) {
      if (error instanceof KbSearchTimeoutError) throw kbSearchTimeout();
      // The driver's message holds the statement and the customer's words: log a code only.
      throw new KbSearchError(error);
    }
  }

  // --- writes ---

  async create(uow: UnitOfWork, actor: Actor, input: CreateKbArticle): Promise<KbArticle> {
    const result = await translating(async () =>
      settle(uow, await this.domain.kb.create(uow.tx, domainContext(this.domain, actor), input)),
    );
    return this.get(result.articleId, uow.tx);
  }

  async update(
    uow: UnitOfWork,
    actor: Actor,
    id: string,
    patch: UpdateKbArticle,
    canApprove: boolean,
  ): Promise<KbArticle> {
    const result = await translating(async () =>
      settle(
        uow,
        await this.domain.kb.update(uow.tx, domainContext(this.domain, actor), {
          articleId: id,
          patch,
          canApprove,
        }),
      ),
    );
    return this.get(result.articleId, uow.tx);
  }

  async transition(
    uow: UnitOfWork,
    actor: Actor,
    id: string,
    input: KbTransition,
  ): Promise<KbArticle> {
    const result = await translating(async () =>
      settle(
        uow,
        await this.domain.kb.transition(uow.tx, domainContext(this.domain, actor), {
          articleId: id,
          ...input,
        }),
      ),
    );
    return this.get(result.articleId, uow.tx);
  }

  async publish(
    uow: UnitOfWork,
    actor: Actor,
    id: string,
    input: PublishKbArticle,
  ): Promise<KbArticle> {
    const result = await translating(async () =>
      settle(
        uow,
        await this.domain.kb.publish(uow.tx, domainContext(this.domain, actor), {
          articleId: id,
          version: input.version,
          audience: { visibility: input.visibility, orgIds: input.orgIds },
        }),
      ),
    );
    return this.get(result.articleId, uow.tx);
  }

  async publishBreakGlass(
    uow: UnitOfWork,
    actor: Actor,
    id: string,
    input: BreakGlassPublishKbArticle,
  ): Promise<KbArticle> {
    const result = await translating(async () =>
      settle(
        uow,
        await this.domain.kb.publishBreakGlass(uow.tx, domainContext(this.domain, actor), {
          articleId: id,
          version: input.version,
          audience: { visibility: input.visibility, orgIds: input.orgIds },
          reason: input.reason,
        }),
      ),
    );
    return this.get(result.articleId, uow.tx);
  }

  async reviewBreakGlass(
    uow: UnitOfWork,
    actor: Actor,
    id: string,
    input: ReviewKbBreakGlass,
  ): Promise<KbArticle> {
    const result = await translating(async () =>
      settle(
        uow,
        await this.domain.kb.reviewBreakGlass(uow.tx, domainContext(this.domain, actor), {
          articleId: id,
          breakGlassAt: new Date(input.breakGlassAt),
        }),
      ),
    );
    return this.get(result.articleId, uow.tx);
  }
}
