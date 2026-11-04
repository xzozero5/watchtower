import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  procedureProposalAppliedSchema,
  procedureProposalListSchema,
  procedureProposalParamsSchema,
  ticketRefParamSchema,
} from '@watchtower/shared';
import type { z } from 'zod';

import { AuditScope } from '../audit/audit-scope.js';
import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { TicketProposalsService } from './ticket-proposals.service.js';

type RefParam = z.infer<typeof ticketRefParamSchema>;
type ProposalParam = z.infer<typeof procedureProposalParamsSchema>;

/**
 * Escalation cards of a ticket (T-303f, ADR-026 section 10): what a procedure step `escalate` proposed while the
 * AI investigated. Nothing is done until a person presses the card: `ticket.handle`.
 */
@ApiTags('procedures')
@Controller('v1/tickets/:id/procedure-proposals')
export class TicketProposalsController {
  constructor(@Inject(TicketProposalsService) private readonly proposals: TicketProposalsService) {}

  @Get()
  @RequirePermission('ticket.read')
  @ApiOperation({
    summary: 'The escalation cards of a ticket',
    description:
      'Oldest first. `status` is `pending` (can be pressed), `applied`, or `expired` (the procedure the intent runs ' +
      'now is not the one that proposed it, or the ticket is closed). A queue target moves the ticket to the queue ' +
      'and keeps the assignee; a role target tells the leads or heads on shift and leaves an internal note.',
  })
  @ApiOkResponse({ standardSchema: procedureProposalListSchema })
  @ApiForbiddenResponse({ description: 'Needs `ticket.read`' })
  @ApiNotFoundResponse({ description: 'No such ticket (or not visible to you)' })
  async list(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    const { ticketId, list } = await this.proposals.list(params.id, principal);
    AuditScope.set({ targetId: ticketId });
    return parseResponse(procedureProposalListSchema, list);
  }

  @Post(':proposalId/apply')
  @HttpCode(200)
  @RequirePermission('ticket.handle')
  @Audited({ action: AUDIT_ACTIONS.procedureEscalationApplied, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Press an escalation card (one click, by the person)',
    description:
      'Runs what the card says as the caller, with the ordinary ticket services: a queue target moves the ticket ' +
      '(the assignee stays), a role target notifies the leads or heads on shift and leaves an internal note (nobody ' +
      'is assigned); a priority the step names is set. Audited with `via=procedure`. Idempotent: a card already ' +
      'applied answers `alreadyApplied: true` and does nothing more. 409 when the ticket is closed or the procedure ' +
      'that proposed it is no longer live; 404 when the card is not on this ticket.',
  })
  @ApiOkResponse({ standardSchema: procedureProposalAppliedSchema })
  @ApiForbiddenResponse({ description: 'Needs `ticket.handle`' })
  @ApiNotFoundResponse({ description: 'No such ticket or card' })
  @ApiConflictResponse({ description: 'The card has expired' })
  async apply(
    @Param({ schema: procedureProposalParamsSchema }) params: ProposalParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    const { ticketId, applied } = await this.proposals.apply(
      params.id,
      params.proposalId,
      principal,
    );
    AuditScope.set({ targetId: ticketId });
    return parseResponse(procedureProposalAppliedSchema, applied);
  }
}
