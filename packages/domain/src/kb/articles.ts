import { createHash, randomUUID } from 'node:crypto';

import { PG, pgCode, pgConstraint, schema } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  KB_JOBS,
  KB_OUTBOX_JOB_OPTIONS,
  QUEUE_NAMES,
  type CreateKbArticle,
  type KbKind,
  type KbStatus,
  type KbVisibility,
  type KbTransition,
  type UpdateKbArticle,
} from '@watchtower/shared';
import { and, asc, eq, gt, lte } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { DomainError, badRequest, conflict, invalidTransition, notFound } from '../errors.js';
import { enqueueJob } from '../outbox.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import {
  audienceWidens,
  canMove,
  canPublishFrom,
  sameAudience,
  type KbAudienceSpec,
} from './rules.js';

/** What a write tells the caller; the api reads the article back for the response. */
export interface KbWriteResult {
  readonly articleId: string;
  /** The latest version number after the write. */
  readonly version: number;
  readonly versionId: string;
  /** False when the request changed nothing (no new version, no new status). */
  readonly changed: boolean;
}

/** sha256 of title and body: an edit that changes neither is not a new version. */
export function contentHash(title: string, bodyMd: string): string {
  return createHash('sha256')
    .update(title, 'utf8')
    .update('\u0000')
    .update(bodyMd, 'utf8')
    .digest('hex');
}

async function lockArticle(tx: DbTransaction, articleId: string) {
  const [article] = await tx
    .select()
    .from(schema.kbArticle)
    .where(eq(schema.kbArticle.id, articleId))
    .for('update')
    .limit(1);
  if (article === undefined) throw notFound('No such article');
  const [current] = await tx
    .select()
    .from(schema.kbArticleVersion)
    .where(eq(schema.kbArticleVersion.id, article.currentVersionId))
    .limit(1);
  if (current === undefined) throw new Error('kb_article points at a version that does not exist');
  return { article, current };
}

/** True when `userId` wrote a version of the article numbered above `after` (and up to `upTo`, if given). */
async function wroteVersion(
  tx: DbTransaction,
  articleId: string,
  userId: string,
  after = 0,
  upTo?: number,
): Promise<boolean> {
  const rows = await tx
    .select({ id: schema.kbArticleVersion.id })
    .from(schema.kbArticleVersion)
    .where(
      and(
        eq(schema.kbArticleVersion.articleId, articleId),
        gt(schema.kbArticleVersion.version, after),
        upTo === undefined ? undefined : lte(schema.kbArticleVersion.version, upTo),
        eq(schema.kbArticleVersion.createdBy, userId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function orgIdsOf(tx: DbTransaction, articleId: string): Promise<string[]> {
  const rows = await tx
    .select({ orgId: schema.kbArticleOrg.orgId })
    .from(schema.kbArticleOrg)
    .where(eq(schema.kbArticleOrg.articleId, articleId))
    .orderBy(asc(schema.kbArticleOrg.orgId));
  return rows.map((row) => row.orgId);
}

async function setOrgs(tx: DbTransaction, articleId: string, orgIds: readonly string[]) {
  const wanted = [...new Set(orgIds)];
  const have = new Set(await orgIdsOf(tx, articleId));
  for (const orgId of have) {
    if (!wanted.includes(orgId)) {
      await tx
        .delete(schema.kbArticleOrg)
        .where(
          and(eq(schema.kbArticleOrg.articleId, articleId), eq(schema.kbArticleOrg.orgId, orgId)),
        );
    }
  }
  const missing = wanted.filter((orgId) => !have.has(orgId));
  if (missing.length > 0) {
    try {
      await tx.insert(schema.kbArticleOrg).values(missing.map((orgId) => ({ articleId, orgId })));
    } catch (error) {
      if (pgCode(error) === PG.foreignKeyViolation) throw badRequest('Unknown organization');
      throw error;
    }
  }
}

/** Asks the worker to (re)build the chunks of an article, or to drop them when it is no longer live. */
async function enqueueEmbed(
  tx: DbTransaction,
  ctx: DomainContext,
  articleId: string,
  versionId: string,
): Promise<void> {
  await enqueueJob(tx, ctx.config, {
    queue: QUEUE_NAMES.kb,
    name: KB_JOBS.embedArticle,
    // The clock makes publishing the same version again (after a deprecation) a new job.
    jobId: `kb-embed-${versionId}-${String(ctx.now().getTime())}`,
    payload: { articleId, versionId },
    options: KB_OUTBOX_JOB_OPTIONS,
  });
}

/**
 * Creates a draft article with its first version. The slug is the stable public name; it is
 * unique, and a clash answers `conflict`.
 */
export async function createKbArticle(
  tx: DbTransaction,
  ctx: DomainContext,
  input: CreateKbArticle,
): Promise<DomainResult<KbWriteResult>> {
  const fx = new Effects();
  if (input.visibility === 'orgs' && input.orgIds.length === 0) {
    throw badRequest('Visibility "orgs" needs at least one organization');
  }
  const articleId = randomUUID();
  const versionId = randomUUID();
  try {
    // The article points at its first version through a deferred foreign key, so it goes in first.
    await tx.insert(schema.kbArticle).values({
      id: articleId,
      slug: input.slug,
      kind: input.kind,
      lang: input.lang,
      visibility: input.visibility,
      intentTags: input.intentTags,
      sources: input.sources,
      authorId: ctx.actor.id,
      currentVersionId: versionId,
    });
  } catch (error) {
    if (pgCode(error) === PG.uniqueViolation && pgConstraint(error) === 'kb_article_slug_key') {
      throw conflict('That slug is already used by another article');
    }
    throw error;
  }
  await tx.insert(schema.kbArticleVersion).values({
    id: versionId,
    articleId,
    version: 1,
    title: input.title,
    bodyMd: input.bodyMd,
    changeNote: input.changeNote ?? null,
    contentHash: contentHash(input.title, input.bodyMd),
    createdBy: ctx.actor.id,
  });
  if (input.visibility === 'orgs') await setOrgs(tx, articleId, input.orgIds);
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.kbArticleCreate,
    targetType: 'kb_article',
    targetId: articleId,
    after: {
      slug: input.slug,
      lang: input.lang,
      kind: input.kind,
      visibility: input.visibility,
      title: input.title,
    },
  });
  return fx.result({ articleId, version: 1, versionId, changed: true });
}

export interface UpdateKbArticleInput {
  readonly articleId: string;
  readonly patch: UpdateKbArticle;
  /**
   * The caller holds `kb.approve`. Without it, widening the audience of an article is refused, at
   * any status: an approver decides who may read it (and publishing is bound to the audience the
   * approver saw, so a change in between is refused there as well).
   */
  readonly canApprove: boolean;
}

/**
 * Edits an article. A change of title or body adds an immutable version and moves the "latest"
 * pointer; it never changes what is live (that is `publishKbArticle`). A change of metadata only
 * (visibility, organizations, tags, sources, last verified) rewrites the article row, and takes
 * effect at once because visibility is read at search time.
 */
export async function updateKbArticle(
  tx: DbTransaction,
  ctx: DomainContext,
  input: UpdateKbArticleInput,
): Promise<DomainResult<KbWriteResult>> {
  const fx = new Effects();
  const { patch } = input;
  const { article, current } = await lockArticle(tx, input.articleId);
  if (article.status === 'deprecated') {
    throw conflict('A deprecated article cannot be edited; move it back to draft first');
  }
  if (patch.expectedVersion !== undefined && patch.expectedVersion !== current.version) {
    throw conflict(
      `The article changed meanwhile: it is now at version ${String(current.version)}`,
    );
  }

  const title = patch.title ?? current.title;
  const bodyMd = patch.bodyMd ?? current.bodyMd;
  const hash = contentHash(title, bodyMd);
  const contentChanged = hash !== current.contentHash;

  const oldOrgs = await orgIdsOf(tx, article.id);
  const visibility = patch.visibility ?? (article.visibility as KbVisibility);
  const orgs = visibility === 'orgs' ? [...new Set(patch.orgIds ?? oldOrgs)].sort() : [];
  if (visibility === 'orgs' && orgs.length === 0) {
    throw badRequest('Visibility "orgs" needs at least one organization');
  }
  const audienceChanged =
    visibility !== article.visibility || orgs.join(',') !== [...oldOrgs].sort().join(',');
  if (
    audienceChanged &&
    !input.canApprove &&
    audienceWidens(
      { visibility: article.visibility as KbVisibility, orgIds: oldOrgs },
      { visibility, orgIds: orgs },
    )
  ) {
    throw new DomainError(
      'policy_denied',
      'Showing an article to more people needs an approver, whatever its status',
      { reason: 'kb_audience_requires_approval' },
    );
  }

  // A live article reaches more people at once, with no publication to put a second pair of eyes
  // on it. So the person who wrote it cannot do it alone: somebody who wrote none of its versions
  // must. (Narrowing is the safe direction and stays immediate.)
  const wideningLive =
    audienceChanged &&
    article.status === 'published' &&
    audienceWidens(
      { visibility: article.visibility as KbVisibility, orgIds: oldOrgs },
      { visibility, orgIds: orgs },
    );
  if (wideningLive && ctx.actor.id !== null && (await wroteVersion(tx, article.id, ctx.actor.id))) {
    throw new DomainError(
      'policy_denied',
      'You wrote this article, so another approver has to show it to more people',
      { reason: 'kb_audience_widen_by_author' },
    );
  }

  const intentTags = patch.intentTags ?? article.intentTags;
  const sources = patch.sources ?? article.sources;
  const kind = patch.kind ?? (article.kind as KbKind);
  const lastVerifiedAt =
    patch.lastVerifiedAt === undefined
      ? article.lastVerifiedAt
      : patch.lastVerifiedAt === null
        ? null
        : new Date(patch.lastVerifiedAt);
  const metadataChanged =
    audienceChanged ||
    kind !== article.kind ||
    JSON.stringify(intentTags) !== JSON.stringify(article.intentTags) ||
    JSON.stringify(sources) !== JSON.stringify(article.sources) ||
    (lastVerifiedAt?.getTime() ?? null) !== (article.lastVerifiedAt?.getTime() ?? null);

  if (!contentChanged && !metadataChanged) {
    return fx.result({
      articleId: article.id,
      version: current.version,
      versionId: current.id,
      changed: false,
    });
  }

  let versionId = current.id;
  let version = current.version;
  if (contentChanged) {
    version = current.version + 1;
    versionId = randomUUID();
    await tx.insert(schema.kbArticleVersion).values({
      id: versionId,
      articleId: article.id,
      version,
      title,
      bodyMd,
      changeNote: patch.changeNote ?? null,
      contentHash: hash,
      createdBy: ctx.actor.id,
    });
  }
  if (audienceChanged) await setOrgs(tx, article.id, orgs);
  await tx
    .update(schema.kbArticle)
    .set({
      currentVersionId: versionId,
      kind,
      visibility,
      intentTags,
      sources,
      lastVerifiedAt,
      updatedAt: ctx.now(),
    })
    .where(eq(schema.kbArticle.id, article.id));

  await recordAuditInTx(tx, ctx, fx, {
    action: wideningLive ? AUDIT_ACTIONS.kbArticleAudienceWiden : AUDIT_ACTIONS.kbArticleUpdate,
    targetType: 'kb_article',
    targetId: article.id,
    before: { version: current.version, visibility: article.visibility, orgIds: oldOrgs },
    after: { version, visibility, orgIds: orgs },
    metadata: { contentChanged, metadataChanged, status: article.status },
  });
  return fx.result({ articleId: article.id, version, versionId, changed: true });
}

export interface TransitionKbArticleInput extends KbTransition {
  readonly articleId: string;
}

/**
 * Moves an article between statuses without publishing. Deprecating a live article takes it out of
 * search at once (search only reads `published`) and asks the worker to drop its chunks.
 */
export async function transitionKbArticle(
  tx: DbTransaction,
  ctx: DomainContext,
  input: TransitionKbArticleInput,
): Promise<DomainResult<KbWriteResult>> {
  const fx = new Effects();
  const { article, current } = await lockArticle(tx, input.articleId);
  const from = article.status as KbStatus;
  if (from === input.to) {
    return fx.result({
      articleId: article.id,
      version: current.version,
      versionId: current.id,
      changed: false,
    });
  }
  if (from === 'published' && input.to === 'in_review') {
    // A live article stays live (and searchable) while its newer version is reviewed.
    if (article.publishedVersionId === current.id) {
      throw invalidTransition('There is no newer version to review');
    }
    if (article.reviewVersionId === current.id) {
      return fx.result({
        articleId: article.id,
        version: current.version,
        versionId: current.id,
        changed: false,
      });
    }
    await tx
      .update(schema.kbArticle)
      .set({ reviewVersionId: current.id, updatedAt: ctx.now() })
      .where(eq(schema.kbArticle.id, article.id));
    await recordAuditInTx(tx, ctx, fx, {
      action: AUDIT_ACTIONS.kbArticleStatus,
      targetType: 'kb_article',
      targetId: article.id,
      before: { status: from, reviewVersionId: article.reviewVersionId },
      after: { status: from, reviewVersionId: current.id },
      metadata: { reviewRequested: true, version: current.version },
    });
    return fx.result({
      articleId: article.id,
      version: current.version,
      versionId: current.id,
      changed: true,
    });
  }
  if (!canMove(from, input.to)) {
    throw invalidTransition(`An article cannot go from ${from} to ${input.to}`);
  }
  await tx
    .update(schema.kbArticle)
    .set({
      status: input.to,
      reviewVersionId: null,
      // A deprecated article has no live version; the text stays in its history.
      ...(input.to === 'deprecated' ? { publishedVersionId: null } : {}),
      updatedAt: ctx.now(),
    })
    .where(eq(schema.kbArticle.id, article.id));
  if (from === 'published' && input.to === 'deprecated') {
    await enqueueEmbed(tx, ctx, article.id, current.id);
  }
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.kbArticleStatus,
    targetType: 'kb_article',
    targetId: article.id,
    before: { status: from },
    after: { status: input.to },
    metadata: input.reason === undefined ? {} : { reason: input.reason },
  });
  return fx.result({
    articleId: article.id,
    version: current.version,
    versionId: current.id,
    changed: true,
  });
}

export interface PublishKbArticleInput {
  readonly articleId: string;
  /** The version the approver looked at. It must still be the latest. */
  readonly version: number;
  /** The audience the approver looked at. It must still be the article's audience. */
  readonly audience: KbAudienceSpec;
}

export interface BreakGlassPublishKbArticleInput extends PublishKbArticleInput {
  /** Why the second person was skipped. Required, and written to the audit log. */
  readonly reason: string;
}

type PublishMode =
  { readonly kind: 'normal' } | { readonly kind: 'break_glass'; readonly reason: string };

/**
 * Only a person publishes. An AI or a system identity never does, whatever permission it holds;
 * AI drafts (T-108e) go to `in_review` and wait for a human approver who is not the requester.
 * TODO(T-108e): record the requester of an AI draft and refuse that person as its approver.
 */
function requireHuman(ctx: DomainContext): string {
  if (ctx.actor.type !== 'user' || ctx.actor.id === null) {
    throw new DomainError('policy_denied', 'Only a signed-in person can publish an article', {
      reason: 'kb_publisher_not_human',
    });
  }
  return ctx.actor.id;
}

async function publishWith(
  tx: DbTransaction,
  ctx: DomainContext,
  input: PublishKbArticleInput,
  mode: PublishMode,
): Promise<DomainResult<KbWriteResult>> {
  const fx = new Effects();
  const publisherId = requireHuman(ctx);
  if (mode.kind === 'break_glass' && mode.reason.trim() === '') {
    throw badRequest('Publishing break-glass needs a reason');
  }
  const { article, current } = await lockArticle(tx, input.articleId);
  if (!canPublishFrom(article.status as KbStatus)) {
    throw invalidTransition(
      'A deprecated article must go back to draft before it can be published',
    );
  }
  if (input.version !== current.version) {
    throw conflict(
      `Version ${String(input.version)} is not the latest (${String(current.version)}); look at the latest first`,
    );
  }
  const orgIds = await orgIdsOf(tx, article.id);
  if (!sameAudience(input.audience, { visibility: article.visibility as KbVisibility, orgIds })) {
    throw conflict('The audience of this article changed since you looked at it; look at it again');
  }
  if (article.status === 'published' && article.publishedVersionId === current.id) {
    return fx.result({
      articleId: article.id,
      version: current.version,
      versionId: current.id,
      changed: false,
    });
  }

  const [live] =
    article.publishedVersionId === null
      ? []
      : await tx
          .select({ version: schema.kbArticleVersion.version })
          .from(schema.kbArticleVersion)
          .where(eq(schema.kbArticleVersion.id, article.publishedVersionId))
          .limit(1);
  const liveVersion = live?.version ?? 0;

  if (mode.kind === 'normal') {
    // Two people: the version must have been sent for review (a draft is `in_review`; a live
    // article names the version sent in `review_version_id`), and the publisher wrote none of the
    // text that goes live.
    const sentForReview =
      article.status === 'in_review' ||
      (article.status === 'published' && article.reviewVersionId === current.id);
    if (!sentForReview) {
      throw invalidTransition('Send this version for review before it is published');
    }
    if (await wroteVersion(tx, article.id, publisherId, liveVersion)) {
      throw new DomainError(
        'policy_denied',
        'You wrote part of this text, so another approver has to publish it',
        { reason: 'kb_publisher_is_author' },
      );
    }
  }

  const now = ctx.now();
  const breakGlass =
    mode.kind === 'break_glass'
      ? {
          breakGlassPending: true,
          breakGlassBy: publisherId,
          breakGlassAt: now,
          breakGlassReason: mode.reason.trim(),
          breakGlassReviewedBy: null,
          breakGlassReviewedAt: null,
        }
      : {};
  await tx
    .update(schema.kbArticle)
    .set({
      status: 'published',
      publishedVersionId: current.id,
      publishedAt: now,
      reviewerId: publisherId,
      reviewVersionId: null,
      updatedAt: now,
      ...breakGlass,
      ...(mode.kind === 'break_glass'
        ? { breakGlassVersionId: current.id, breakGlassPrevVersion: liveVersion }
        : {}),
    })
    .where(eq(schema.kbArticle.id, article.id));
  await enqueueEmbed(tx, ctx, article.id, current.id);
  await recordAuditInTx(tx, ctx, fx, {
    action:
      mode.kind === 'break_glass'
        ? AUDIT_ACTIONS.kbArticlePublishBreakGlass
        : AUDIT_ACTIONS.kbArticlePublish,
    targetType: 'kb_article',
    targetId: article.id,
    before: { status: article.status, publishedVersionId: article.publishedVersionId },
    after: { status: 'published', publishedVersionId: current.id, version: current.version },
    metadata:
      mode.kind === 'break_glass'
        ? { reason: mode.reason.trim(), visibility: article.visibility, orgIds }
        : { visibility: article.visibility, orgIds },
  });
  return fx.result({
    articleId: article.id,
    version: current.version,
    versionId: current.id,
    changed: true,
  });
}

/**
 * Puts the latest version live: what search and customers see becomes this text, the publisher is
 * recorded as reviewer, and the worker is asked to chunk and embed it. Segregation of duties:
 * the article must be in review (or already live with a newer version waiting), and the publisher
 * must not have written any version newer than the live one; the approver who edits during review
 * becomes its author, so another approver publishes. Asking for a version that is no longer the
 * latest, or for an audience that is no longer the article's, answers `conflict`, so nobody
 * publishes text, or to people, they have not seen. Publishing what is already live changes nothing.
 */
export function publishKbArticle(
  tx: DbTransaction,
  ctx: DomainContext,
  input: PublishKbArticleInput,
): Promise<DomainResult<KbWriteResult>> {
  return publishWith(tx, ctx, input, { kind: 'normal' });
}

/**
 * The emergency path: publishes without a second person and without review, with a mandatory
 * reason, audited as its own action, and flags the article until another approver reviews it
 * (`reviewKbBreakGlass`). Who may use it (the head) is the caller's check; the domain only refuses
 * a non-person and an empty reason. An AI never can.
 */
export function publishKbArticleBreakGlass(
  tx: DbTransaction,
  ctx: DomainContext,
  input: BreakGlassPublishKbArticleInput,
): Promise<DomainResult<KbWriteResult>> {
  return publishWith(tx, ctx, input, { kind: 'break_glass', reason: input.reason });
}

export interface ReviewKbBreakGlassInput {
  readonly articleId: string;
  /** `breakGlassAt` of the publication the reviewer looked at. A newer one is a different publication. */
  readonly breakGlassAt: Date;
}

/**
 * Another approver confirms a break-glass publication was right (or that it has been corrected),
 * which clears the flag. The person who published it cannot review it.
 */
export async function reviewKbBreakGlass(
  tx: DbTransaction,
  ctx: DomainContext,
  input: ReviewKbBreakGlassInput,
): Promise<DomainResult<KbWriteResult>> {
  const fx = new Effects();
  const reviewerId = requireHuman(ctx);
  const { article, current } = await lockArticle(tx, input.articleId);
  if (!article.breakGlassPending) {
    throw conflict('This article has no break-glass publication to review');
  }
  if (article.breakGlassAt?.getTime() !== input.breakGlassAt.getTime()) {
    throw conflict(
      'The break-glass publication changed since you looked at it; look at the latest one',
    );
  }
  if (article.breakGlassBy === reviewerId) {
    throw new DomainError(
      'policy_denied',
      'You published this break-glass, so another approver has to review it',
      { reason: 'kb_review_is_publisher' },
    );
  }
  // Nor can somebody who wrote any of the text that went live, which is every version after the one
  // that was live before, up to the break-glass one.
  const [published] =
    article.breakGlassVersionId === null
      ? []
      : await tx
          .select({ version: schema.kbArticleVersion.version })
          .from(schema.kbArticleVersion)
          .where(eq(schema.kbArticleVersion.id, article.breakGlassVersionId))
          .limit(1);
  if (
    published !== undefined &&
    (await wroteVersion(
      tx,
      article.id,
      reviewerId,
      article.breakGlassPrevVersion ?? 0,
      published.version,
    ))
  ) {
    throw new DomainError(
      'policy_denied',
      'You wrote part of the text that went live, so another approver has to review it',
      { reason: 'kb_reviewer_is_author' },
    );
  }
  const now = ctx.now();
  await tx
    .update(schema.kbArticle)
    .set({
      breakGlassPending: false,
      breakGlassReviewedBy: reviewerId,
      breakGlassReviewedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.kbArticle.id, article.id));
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.kbArticleBreakGlassReview,
    targetType: 'kb_article',
    targetId: article.id,
    metadata: {
      publishedBy: article.breakGlassBy,
      publishedAt: article.breakGlassAt?.toISOString() ?? null,
    },
  });
  return fx.result({
    articleId: article.id,
    version: current.version,
    versionId: current.id,
    changed: true,
  });
}
