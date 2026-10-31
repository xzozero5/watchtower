import { Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AUDIT_ACTIONS, portalRevokeResultSchema, ticketRefParamSchema } from '@watchtower/shared';
import type { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { PortalTokensService } from './portal-tokens.service.js';

type RefParam = z.infer<typeof ticketRefParamSchema>;

/** Staff controls over the portal links of a ticket. */
@ApiTags('portal')
@Controller('v1/tickets')
export class PortalStaffController {
  constructor(
    @Inject(PortalTokensService) private readonly tokens: PortalTokensService,
    @Inject(TicketsService) private readonly tickets: TicketsService,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Post(':id/portal-links/revoke')
  @HttpCode(200)
  @RequirePermission('ticket.handle')
  @Audited({ action: AUDIT_ACTIONS.portalLinksRevoke, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Revoke every live tracking link of a ticket',
    description:
      'For a link that went to the wrong person. The customer can ask for a new one by email ' +
      '(`POST /v1/portal/track/resend`), which only the ticket requester receives.',
  })
  @ApiOkResponse({ standardSchema: portalRevokeResultSchema })
  @ApiNotFoundResponse({ description: 'No such ticket' })
  async revoke(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    const revoked = await this.uow.run(async (uow) => {
      const ticket = await this.tickets.lock(uow.tx, params.id);
      const count = await this.tokens.revokeForTicket(uow.tx, ticket.id);
      await this.audit.recordInTransaction(uow.tx, {
        actor: { type: 'user', id: principal.userId },
        action: AUDIT_ACTIONS.portalLinksRevoke,
        targetType: 'ticket',
        targetId: ticket.id,
        metadata: { revoked: count },
      });
      return count;
    });
    return parseResponse(portalRevokeResultSchema, { revoked });
  }
}
