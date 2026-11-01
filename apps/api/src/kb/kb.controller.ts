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
      'never returned.',
  })
  @ApiOkResponse({ standardSchema: kbSearchResultSchema })
  async search(@Query({ schema: kbSearchQuerySchema }) query: KbSearchQuery) {
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
  async list(@Query({ schema: kbArticleListQuerySchema }) query: KbArticleListQuery) {
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
  async get(@Param({ schema: idParamSchema }) params: IdParam) {
    return parseResponse(kbArticleSchema, await this.kb.get(params.id));
  }

  @Get('articles/:id/versions')
  @RequirePermission('kb.read')
  @ApiOperation({ summary: 'The versions of an article, newest first (staff)' })
  @ApiOkResponse({ standardSchema: kbVersionListSchema })
  @ApiNotFoundResponse({ description: 'No such article' })
  async versions(@Param({ schema: idParamSchema }) params: IdParam) {
    return parseResponse(kbVersionListSchema, await this.kb.versions(params.id));
  }

  @Get('articles/:id/versions/:version')
  @RequirePermission('kb.read')
  @ApiOperation({ summary: 'One version of an article with its text (staff)' })
  @ApiOkResponse({ standardSchema: kbVersionSchema })
  @ApiNotFoundResponse({ description: 'No such article or version' })
  async version(@Param({ schema: kbVersionParamSchema }) params: VersionParam) {
    return parseResponse(kbVersionSchema, await this.kb.version(params.id, params.version));
  }

  @Post('articles')
  @RequirePermission('kb.write')
  @Audited({ action: AUDIT_ACTIONS.kbArticleCreate, targetType: 'kb_article' })
  @ApiOperation({
    summary: 'Create a draft article (agent, lead, head)',
    description:
      'Starts as a draft at version 1. Nothing is searchable until an approver publishes it. ' +
      '`visibility` is `internal` (staff), `customer` (every client) or `orgs` (the listed organizations).',
  })
  @ApiCreatedResponse({ standardSchema: kbArticleSchema })
  @ApiConflictResponse({ description: 'The slug is already used' })
  async create(
    @Body({ schema: createKbArticleSchema }) body: CreateKbArticle,
    @CurrentPrincipal() principal: Principal,
  ) {
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
      'indexing; it is searchable once the worker has embedded it. `version` must still be the ' +
      'latest (409 otherwise), so nobody publishes text they have not seen.',
  })
  @ApiOkResponse({ standardSchema: kbArticleSchema })
  @ApiNotFoundResponse({ description: 'No such article' })
  @ApiConflictResponse({ description: 'Not the latest version, or the article is deprecated' })
  async publish(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Body({ schema: publishKbArticleSchema }) body: PublishKbArticle,
    @CurrentPrincipal() principal: Principal,
  ) {
    AuditScope.set({ targetId: params.id });
    const published = await this.uow.run((uow) =>
      this.kb.publish(uow, actorOf(principal), params.id, body),
    );
    return parseResponse(kbArticleSchema, published);
  }
}
