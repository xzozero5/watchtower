import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  createSavedViewSchema,
  savedViewListSchema,
  savedViewSchema,
  updateSavedViewSchema,
  viewIdParamSchema,
  viewListQuerySchema,
  type CreateSavedView,
  type UpdateSavedView,
  type ViewIdParam,
  type ViewListQuery,
} from '@watchtower/shared';

import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { ViewsService } from './views.service.js';

/** Saved views (T-119a, PRD R-1.8, UI spec 4.2). Staff only: a client has no queue. */
@ApiTags('views')
@Controller('v1/views')
export class ViewsController {
  constructor(@Inject(ViewsService) private readonly views: ViewsService) {}

  @Get()
  @RequirePermission('ticket.read')
  @ApiOperation({
    summary: 'The views the caller can open, each with a count',
    description:
      'The built-in views (`my_queue`, `unassigned`, `sla_at_risk`, `triage`, `waiting_on_customer`, ' +
      '`all_open`), then the ones shared with the team, then the caller\'s own. Each carries the ' +
      'filters and sort to give `GET /v1/tickets` (`assignee: "me"` is whoever asks) and, unless ' +
      '`counts=false`, how many tickets it matches for the caller. `sla_at_risk` includes breached ' +
      'tickets; `triage` is the `triage` status `[ASSUMED]`.',
  })
  @ApiOkResponse({ standardSchema: savedViewListSchema })
  async list(
    @Query({ schema: viewListQuerySchema }) query: ViewListQuery,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(savedViewListSchema, await this.views.list(principal, query.counts));
  }

  @Post()
  @RequirePermission('ticket.read')
  @Audited({ action: AUDIT_ACTIONS.viewCreate, targetType: 'saved_view' })
  @ApiOperation({
    summary: 'Save the current filters as a view',
    description:
      'Personal by default (up to 50). `shared: true` makes it the team\'s and needs `view.share`. ' +
      'A name is unique among a person\'s views and among the shared ones, ignoring case.',
  })
  @ApiCreatedResponse({ standardSchema: savedViewSchema })
  @ApiForbiddenResponse({ description: 'Sharing needs view.share' })
  @ApiConflictResponse({ description: 'The name is taken, or too many personal views' })
  async create(
    @Body({ schema: createSavedViewSchema }) body: CreateSavedView,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(savedViewSchema, await this.views.create(body, principal));
  }

  @Patch(':id')
  @RequirePermission('ticket.read')
  @Audited({ action: AUDIT_ACTIONS.viewUpdate, targetType: 'saved_view' })
  @ApiOperation({
    summary: 'Rename, change the filters or sort of, share or unshare a view',
    description:
      'Own personal views only. A shared view, and sharing or unsharing one, needs `view.share`. ' +
      'Built-in views answer 409.',
  })
  @ApiOkResponse({ standardSchema: savedViewSchema })
  @ApiNotFoundResponse({ description: 'No such view, or somebody else\'s personal view' })
  @ApiForbiddenResponse({ description: 'A shared view needs view.share' })
  @ApiConflictResponse({ description: 'The name is taken, or a built-in view' })
  async update(
    @Param({ schema: viewIdParamSchema }) params: ViewIdParam,
    @Body({ schema: updateSavedViewSchema }) body: UpdateSavedView,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(savedViewSchema, await this.views.update(params.id, body, principal));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('ticket.read')
  @Audited({ action: AUDIT_ACTIONS.viewDelete, targetType: 'saved_view' })
  @ApiOperation({
    summary: 'Delete a view',
    description: 'Own personal views; a shared view needs `view.share`. Built-in views answer 409.',
  })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiNotFoundResponse({ description: 'No such view, or somebody else\'s personal view' })
  @ApiForbiddenResponse({ description: 'A shared view needs view.share' })
  async remove(
    @Param({ schema: viewIdParamSchema }) params: ViewIdParam,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.views.remove(params.id, principal);
  }
}
