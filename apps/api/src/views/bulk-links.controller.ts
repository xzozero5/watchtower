import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
  bulkRequestSchema,
  bulkResultSchema,
  createTicketLinkSchema,
  ticketLinkListSchema,
  ticketLinkParamSchema,
  ticketLinkSchema,
  ticketRefParamSchema,
  type BulkRequest,
  type CreateTicketLink,
  type TicketLinkParam,
} from '@watchtower/shared';
import type { z } from 'zod';

import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { BulkService } from './bulk.service.js';
import { LinksService } from './links.service.js';

type RefParam = z.infer<typeof ticketRefParamSchema>;

/** Bulk actions on tickets (T-119b, PRD R-1.8). */
@ApiTags('tickets')
@Controller('v1/tickets/bulk')
export class BulkController {
  constructor(@Inject(BulkService) private readonly bulk: BulkService) {}

  @Post()
  @HttpCode(200)
  @RequirePermission('ticket.handle')
  // The units of work write one audit row per ticket change; this route's own row is the summary.
  @Audited({ action: AUDIT_ACTIONS.ticketBulk, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Assign, change the status or priority of, or merge up to 100 tickets at once',
    description:
      'Each ticket is a separate change made as the caller, through the same rules as the single ' +
      'routes: the caller must be able to see it (404 for that ticket otherwise), the workflow must ' +
      'allow the status, a merge stays inside one organization. One ticket failing does not undo ' +
      "the others; the answer is 200 with every ticket's outcome (`ok`, or `error` with the same " +
      '`code` the single route would have answered). Every change writes its own ticket event and ' +
      'audit row with the caller as actor, so the shift handoff reads a bulk reassignment or ' +
      'downgrade exactly like a single one (AC-7). There is no reply action: nothing here reaches a ' +
      'customer, and the policy gate for customer sends is not involved. `merge` merges every ' +
      'selected ticket into `intoTicketId`, which must not be one of them. One summary audit row ' +
      '(`ticket.bulk`) lists the outcomes.',
  })
  @ApiOkResponse({ standardSchema: bulkResultSchema })
  @ApiBadRequestResponse({ description: 'Invalid body, or the merge target is a selected ticket' })
  @ApiNotFoundResponse({ description: 'The merge target does not exist or is not visible' })
  async run(
    @Body({ schema: bulkRequestSchema }) body: BulkRequest,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(bulkResultSchema, await this.bulk.run(body, principal));
  }
}

/** Links between tickets: duplicate and related (T-119c, PRD R-1.1). */
@ApiTags('tickets')
@Controller('v1/tickets/:id/links')
export class LinksController {
  constructor(@Inject(LinksService) private readonly links: LinksService) {}

  @Get()
  @RequirePermission('ticket.read')
  @ApiOperation({
    summary: 'Tickets this one is linked to',
    description:
      'Each link says how the other ticket relates to this one: `duplicate_of` (this ticket is a ' +
      'duplicate of it), `has_duplicate` (it is a duplicate of this one) or `related`. Staff only.',
  })
  @ApiOkResponse({ standardSchema: ticketLinkListSchema })
  @ApiNotFoundResponse({ description: 'No such ticket' })
  async list(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(ticketLinkListSchema, await this.links.list(params.id, principal));
  }

  @Post()
  @RequirePermission('ticket.handle')
  @Audited({ action: AUDIT_ACTIONS.ticketLink, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Link this ticket to another as a duplicate or as related',
    description:
      '`kind: duplicate` marks this ticket as a duplicate of `ticketId`; `related` is symmetric. ' +
      'Nothing is merged: both tickets stay as they are. Both must belong to the same organization ' +
      '(409 otherwise), and the same pair cannot be linked twice. Writes an internal event on both tickets.',
  })
  @ApiCreatedResponse({ standardSchema: ticketLinkSchema })
  @ApiConflictResponse({
    description: 'Different organizations, already linked, or a reverse duplicate',
  })
  @ApiNotFoundResponse({ description: 'No such ticket' })
  async create(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @Body({ schema: createTicketLinkSchema }) body: CreateTicketLink,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(ticketLinkSchema, await this.links.create(params.id, body, principal));
  }

  @Delete(':linkId')
  @HttpCode(204)
  @RequirePermission('ticket.handle')
  @Audited({ action: AUDIT_ACTIONS.ticketUnlink, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Remove a link',
    description: 'Writes an internal event on both tickets.',
  })
  @ApiNoContentResponse({ description: 'Removed' })
  @ApiNotFoundResponse({ description: 'No such ticket, or no such link on it' })
  @ApiForbiddenResponse({ description: 'Missing ticket.handle' })
  async remove(
    @Param({ schema: ticketLinkParamSchema }) params: TicketLinkParam,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.links.remove(params.id, params.linkId, principal);
  }
}
