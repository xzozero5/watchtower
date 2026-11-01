import { Controller, Get, Inject, Param } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ticketAiInsightSchema, ticketRefParamSchema } from '@watchtower/shared';
import type { z } from 'zod';

import { AuditScope } from '../audit/audit-scope.js';
import {
  AuditPiiRead,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { TicketAiService } from './ticket-ai.service.js';

type RefParam = z.infer<typeof ticketRefParamSchema>;

@ApiTags('ai')
@Controller('v1/tickets')
export class TicketAiController {
  constructor(@Inject(TicketAiService) private readonly ai: TicketAiService) {}

  @Get(':id/ai')
  // Staff only: `ticket.read` is not held by a client (they have `ticket.read.org`), so a customer
  // gets 403 here and AI internals are never shown to them.
  @RequirePermission('ticket.read')
  // The brief can quote the customer (placeholders restored for staff): reading it is on the audit log.
  @AuditPiiRead('ticket')
  @ApiOperation({
    summary: 'The AI brief of a ticket (staff)',
    description:
      'What the AI made of the ticket: state, one-line summary, intent with confidence, the one ' +
      'next step it suggests, evidence and the draft reference. 404 when the AI has not made a ' +
      'brief for the ticket (or the ticket is not visible to you). In `needs_human` the brief says ' +
      'why in `nextStep.label` and holds no summary. Not available to a client (403).',
  })
  @ApiOkResponse({ standardSchema: ticketAiInsightSchema })
  @ApiNotFoundResponse({ description: 'No such ticket, or no AI brief for it yet' })
  @ApiForbiddenResponse({ description: 'A client cannot see AI internals' })
  async get(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    const { ticketId, insight } = await this.ai.insightOf(params.id, principal);
    AuditScope.set({ targetId: ticketId });
    return parseResponse(ticketAiInsightSchema, insight);
  }
}
