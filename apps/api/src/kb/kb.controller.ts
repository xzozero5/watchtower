import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  breakGlassPublishKbArticleSchema,
  createKbArticleSchema,
  idParamSchema,
  kbArticleListQuerySchema,
  kbArticlePageSchema,
  kbArticleSchema,
  kbCustomerSearchQuerySchema,
  kbCustomerSearchResultSchema,
  kbSearchQuerySchema,
  kbSearchResultSchema,
  kbTransitionSchema,
  kbVersionListSchema,
  kbVersionParamSchema,
  kbVersionSchema,
  publishKbArticleSchema,
  updateKbArticleSchema,
  type BreakGlassPublishKbArticle,
  type CreateKbArticle,
  type KbArticleListQuery,
  type KbCustomerSearchQuery,
  type KbSearchQuery,
  type KbTransition,
  type PublishKbArticle,
  type UpdateKbArticle,
} from '@watchtower/shared';
import type { z } from 'zod';

import { AuditScope } from '../audit/audit-scope.js';
import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { forbidden } from '../auth/http-errors.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { parseResponse } from '../common/zod-openapi.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { KbService } from './kb.service.js';

type IdParam = z.infer<typeof idParamSchema>;
type VersionParam = z.infer<typeof kbVersionParamSchema>;

/** Customer searches per user per minute `[ASSUMED]`: each one may cost an embedding call. */
const CUSTOMER_SEARCH_PER_MINUTE = 30;

/** Staff searches per user per minute `[ASSUMED]`: each one embeds the query and writes an `ai_run` row. */
const STAFF_SEARCH_PER_MINUTE = 60;

/**
 * The staff routes are for staff accounts. `kb.read` and `kb.write` are not granted to a client, but
 * a client account (one organization) is also refused here in case a permission is ever granted by
 * mistake: this is defence in depth, not the first line.
 */
function staffOnly(principal: Principal): void {
  if (principal.orgScope.kind !== 'all') throw forbidden('This is for staff accounts');
}

const actorOf = (principal: Principal) => ({ type: 'user' as const, id: principal.userId });

@ApiTags('kb')
@Controller('v1/kb')
export class KbController {
  constructor(
    @Inject(KbService) private readonly kb: KbService,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  // --- search ---

  @Get('search')
  @RequirePermission('kb.read')
  @ApiOperation({
    summary: 'Search the published knowledge base (staff)',
    description:
      'Hybrid search over the sections of published articles: keyword (pg_trgm, works on Thai) ' +
      'and vector (cosine) ranked together with Reciprocal Rank Fusion. `mode` says whether ' +
      'vectors were used: `keyword` means no embedding was available (nothing indexed yet, the ' +
      'provider is off, the AI kill switch or the daily budget stopped it), never a silent ' +
      'downgrade. `audience=customer` shows what a customer would get (with `orgId`, that ' +
      "organization's audience too). Drafts, deprecated articles and superseded versions are " +
      'never returned. Rate limited per user. `snippet`, `section` and `title` are raw text from ' +
      'the article (Markdown): a client must escape them, not inject them as HTML.',
  })
  @ApiOkResponse({ standardSchema: kbSearchResultSchema })
  @ApiTooManyRequestsResponse({ description: 'Too many searches in a minute' })
  async search(
    @Query({ schema: kbSearchQuerySchema }) query: KbSearchQuery,
    @CurrentPrincipal() principal: Principal,
  ) {
    staffOnly(principal);
    await this.limiter.enforce('kb-search', principal.userId, STAFF_SEARCH_PER_MINUTE, 60);
    return parseResponse(kbSearchResultSchema, await this.kb.search(query));
  }

  @Get('customer/search')
  @RequirePermission('kb.read.customer')
  @ApiOperation({
    summary: 'Search the customer-visible knowledge base (client)',
    description:
      "Only articles a customer may read: visible to every client, or listing the caller's own " +
      'organization. An internal article is never returned. The answer holds title, section ' +
      'and snippet, nothing else. Rate limited per user.',
  })
  @ApiOkResponse({ standardSchema: kbCustomerSearchResultSchema })
  @ApiForbiddenResponse({ description: 'Not a client' })
  @ApiTooManyRequestsResponse({ description: 'Too many searches in a minute' })
  async customerSearch(
    @Query({ schema: kbCustomerSearchQuerySchema }) query: KbCustomerSearchQuery,
    @CurrentPrincipal() principal: Principal,
  ) {
    if (principal.orgScope.kind !== 'org') {
      throw forbidden('Customer search is for client accounts');
    }
    await this.limiter.enforce(
      'kb-customer-search',
      principal.userId,
      CUSTOMER_SEARCH_PER_MINUTE,
      60,
    );
    return parseResponse(
      kbCustomerSearchResultSchema,
      await this.kb.searchForCustomer(principal.orgScope.orgId, query),
    );
  }

  // --- articles ---

  @Get('articles')
  @RequirePermission('kb.read')
  @ApiOperation({
    summary: 'List articles, newest edit first (staff)',
    description:
      'Drafts and deprecated articles included. Keyset paginated: pass `nextCursor` back as `cursor`.',
  })
  @ApiOkResponse({ standardSchema: kbArticlePageSchema })
  async list(
    @Query({ schema: kbArticleListQuerySchema }) query: KbArticleListQuery,
    @CurrentPrincipal() principal: Principal,
  ) {
    staffOnly(principal);
    return parseResponse(kbArticlePageSchema, await this.kb.list(query));
  }

  @Get('articles/:id')
  @RequirePermission('kb.read')
  @ApiOperation({
    summary: 'One article with its latest text (staff)',
    description:
      '`version` is the latest edit, `publishedVersion` the one that is live; ' +
      '`hasUnpublishedChanges` is true when they differ.',
  })
  @ApiOkResponse({ standardSchema: kbArticleSchema })
  @ApiNotFoundResponse({ description: 'No such article' })
  async get(
    @Param({ schema: idParamSchema }) params: IdParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    staffOnly(principal);
    return parseResponse(kbArticleSchema, await this.kb.get(params.id));
  }

  @Get('articles/:id/versions')
  @RequirePermission('kb.read')
  @ApiOperation({ summary: 'The versions of an article, newest first (staff)' })
  @ApiOkResponse({ standardSchema: kbVersionListSchema })
  @ApiNotFoundResponse({ description: 'No such article' })
  async versions(
    @Param({ schema: idParamSchema }) params: IdParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    staffOnly(principal);
    return parseResponse(kbVersionListSchema, await this.kb.versions(params.id));
  }

  @Get('articles/:id/versions/:version')
  @RequirePermission('kb.read')
  @ApiOperation({ summary: 'One version of an article with its text (staff)' })
  @ApiOkResponse({ standardSchema: kbVersionSchema })
  @ApiNotFoundResponse({ description: 'No such article or version' })
  async version(
    @Param({ schema: kbVersionParamSchema }) params: VersionParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    staffOnly(principal);
    return parseResponse(kbVersionSchema, await this.kb.version(params.id, params.version));
  }

  @Post('articles')
  @RequirePermission('kb.write')
  @Audited({ action: AUDIT_ACTIONS.kbArticleCreate, targetType: 'kb_article' })
  @ApiOperation({
    summary: 'Create a draft article (agent, lead, head)',
    description:
      'Starts as a draft at version 1. Nothing is searchable until an approver publishes it. ' +
      '`visibility` is `internal` (staff), `customer` (every client) or `orgs` (the listed ' +
      'organizations). Text fields, including `sources[].ref` (any URL scheme), are stored raw: ' +
      'a client must escape them, render Markdown without raw HTML, and link only http(s).',
  })
  @ApiCreatedResponse({ standardSchema: kbArticleSchema })
  @ApiConflictResponse({ description: 'The slug is already used' })
  async create(
    @Body({ schema: createKbArticleSchema }) body: CreateKbArticle,
    @CurrentPrincipal() principal: Principal,
  ) {
    staffOnly(principal);
    const created = await this.uow.run((uow) => this.kb.create(uow, actorOf(principal), body));
    AuditScope.set({ targetId: created.id });
    return parseResponse(kbArticleSchema, created);
  }

  @Patch('articles/:id')
  @RequirePermission('kb.write')
  @Audited({ action: AUDIT_ACTIONS.kbArticleUpdate, targetType: 'kb_article' })
  @ApiOperation({
    summary: 'Edit an article (agent, lead, head)',
    description:
      'A change of title or text adds an immutable version and never changes what is live. ' +
      'Send `expectedVersion` to be refused (409) if someone else edited meanwhile. Showing a ' +
      'published article to more people (visibility or organizations) needs `kb.approve` (403).',
  })
  @ApiOkResponse({ standardSchema: kbArticleSchema })
  @ApiNotFoundResponse({ description: 'No such article' })
  @ApiConflictResponse({ description: 'Edited meanwhile, or the article is deprecated' })
  @ApiForbiddenResponse({ description: 'Widening a published article needs kb.approve' })
  async update(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Body({ schema: updateKbArticleSchema }) body: UpdateKbArticle,
    @CurrentPrincipal() principal: Principal,
  ) {
    staffOnly(principal);
    AuditScope.set({ targetId: params.id });
    const updated = await this.uow.run((uow) =>
      this.kb.update(
        uow,
        actorOf(principal),
        params.id,
        body,
        principal.permissions.has('kb.approve'),
      ),
    );
    return parseResponse(kbArticleSchema, updated);
  }

  @Post('articles/:id/transition')
  @HttpCode(200)
  @RequirePermission('kb.write')
  @Audited({ action: AUDIT_ACTIONS.kbArticleStatus, targetType: 'kb_article' })
  @ApiOperation({
    summary: 'Move an article between draft, in review and deprecated',
    description:
      'draft to in_review (submit) and back, any unpublished or published article to ' +
      'deprecated (needs `kb.approve`), deprecated back to draft. Publishing has its own route. ' +
      'Deprecating a live article removes it from search at once.',
  })
  @ApiOkResponse({ standardSchema: kbArticleSchema })
  @ApiNotFoundResponse({ description: 'No such article' })
  @ApiConflictResponse({ description: 'That move is not allowed from the current status' })
  @ApiForbiddenResponse({ description: 'Deprecating needs kb.approve' })
  async transition(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Body({ schema: kbTransitionSchema }) body: KbTransition,
    @CurrentPrincipal() principal: Principal,
  ) {
    staffOnly(principal);
    if (body.to === 'deprecated' && !principal.permissions.has('kb.approve')) {
      throw forbidden('Deprecating an article needs an approver');
    }
    AuditScope.set({ targetId: params.id });
    const moved = await this.uow.run((uow) =>
      this.kb.transition(uow, actorOf(principal), params.id, body),
    );
    return parseResponse(kbArticleSchema, moved);
  }

  @Post('articles/:id/publish')
  @HttpCode(200)
  @RequirePermission('kb.approve')
  @Audited({ action: AUDIT_ACTIONS.kbArticlePublish, targetType: 'kb_article' })
  @ApiOperation({
    summary: 'Publish the latest version (lead, head)',
    description:
      'Makes the version you looked at the live one, records you as reviewer and queues ' +
      'indexing; it is searchable once the worker has embedded it. Two people: the article must ' +
      'be in review (send it with `transition` to `in_review`), and you must not have written any ' +
      'version newer than the live one (403 `policy_denied`: someone else publishes it). ' +
      '`version` must still be the latest and `visibility` / `orgIds` must still be the ' +
      "article's audience (409 otherwise), so nobody publishes text, or to people, they have not seen.",
  })
  @ApiOkResponse({ standardSchema: kbArticleSchema })
  @ApiNotFoundResponse({ description: 'No such article' })
  @ApiConflictResponse({
    description:
      'Not the latest version, the audience changed, or the article is deprecated or not in review',
  })
  @ApiForbiddenResponse({
    description: 'You wrote part of this text: another approver publishes it',
  })
  async publish(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Body({ schema: publishKbArticleSchema }) body: PublishKbArticle,
    @CurrentPrincipal() principal: Principal,
  ) {
    staffOnly(principal);
    AuditScope.set({ targetId: params.id });
    const published = await this.uow.run((uow) =>
      this.kb.publish(uow, actorOf(principal), params.id, body),
    );
    return parseResponse(kbArticleSchema, published);
  }

  @Post('articles/:id/publish-break-glass')
  @HttpCode(200)
  @RequirePermission('kb.publish.break_glass')
  @Audited({ action: AUDIT_ACTIONS.kbArticlePublishBreakGlass, targetType: 'kb_article' })
  @ApiOperation({
    summary: 'Publish without a second person, with a reason (head)',
    description:
      'The emergency path: it skips the review and the rule that the publisher did not write the ' +
      'text. A non-empty `reason` is required and goes to the audit log; the article is flagged ' +
      '(`breakGlassPending`) until another approver clears it with `break-glass-review`. Same ' +
      'checks on `version` and the audience as `publish`.',
  })
  @ApiOkResponse({ standardSchema: kbArticleSchema })
  @ApiNotFoundResponse({ description: 'No such article' })
  @ApiConflictResponse({
    description: 'Not the latest version, the audience changed, or deprecated',
  })
  @ApiForbiddenResponse({ description: 'Head only' })
  async publishBreakGlass(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Body({ schema: breakGlassPublishKbArticleSchema }) body: BreakGlassPublishKbArticle,
    @CurrentPrincipal() principal: Principal,
  ) {
    staffOnly(principal);
    AuditScope.set({ targetId: params.id });
    const published = await this.uow.run((uow) =>
      this.kb.publishBreakGlass(uow, actorOf(principal), params.id, body),
    );
    return parseResponse(kbArticleSchema, published);
  }

  @Post('articles/:id/break-glass-review')
  @HttpCode(200)
  @RequirePermission('kb.approve')
  @Audited({ action: AUDIT_ACTIONS.kbArticleBreakGlassReview, targetType: 'kb_article' })
  @ApiOperation({
    summary: 'Review a break-glass publication (lead, head)',
    description:
      'Clears the `breakGlassPending` flag. Another approver than the one who published it: ' +
      '403 for the publisher. List the waiting ones with `GET /v1/kb/articles?breakGlassPending=true`.',
  })
  @ApiOkResponse({ standardSchema: kbArticleSchema })
  @ApiNotFoundResponse({ description: 'No such article' })
  @ApiConflictResponse({ description: 'Nothing to review' })
  @ApiForbiddenResponse({ description: 'You published it yourself' })
  async reviewBreakGlass(
    @Param({ schema: idParamSchema }) params: IdParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    staffOnly(principal);
    AuditScope.set({ targetId: params.id });
    const reviewed = await this.uow.run((uow) =>
      this.kb.reviewBreakGlass(uow, actorOf(principal), params.id),
    );
    return parseResponse(kbArticleSchema, reviewed);
  }
}
