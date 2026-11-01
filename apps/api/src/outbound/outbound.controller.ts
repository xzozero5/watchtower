import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
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
  cancelSendResultSchema,
  deliveryParamSchema,
  outboundSettingsSchema,
  type DeliveryParam,
  type OutboundSettings,
} from '@watchtower/shared';

import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { forbidden } from '../auth/http-errors.js';
import { parseResponse } from '../common/zod-openapi.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { OutboundService } from './outbound.service.js';

/**
 * Undo is staff work (like `assertCanReplyAs` for replies): somebody scoped to one organization, a client,
 * never undoes a send, whatever permissions its role was given. Anybody may undo their own send; undoing
 * a colleague's needs the `ticket.cancel.any` permission, not a role name, so a head can change who
 * holds it (ADR-010 section 4, T-122e N-4).
 */
function assertCanCancel(principal: Principal): void {
  if (principal.orgScope.kind === 'org' || !principal.permissions.has('ticket.reply')) {
    throw forbidden();
  }
}
const canCancelAny = (principal: Principal): boolean =>
  principal.permissions.has('ticket.cancel.any');

@ApiTags('outbound')
@Controller('v1')
export class OutboundController {
  constructor(
    @Inject(OutboundService) private readonly outbound: OutboundService,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
  ) {}

  @Post('tickets/:id/deliveries/:deliveryId/cancel')
  @HttpCode(200)
  @RequirePermission('ticket.reply')
  @Audited({ action: AUDIT_ACTIONS.outboundCancelled, targetType: 'outbound_delivery' })
  @ApiOperation({
    summary: 'Undo a send',
    description:
      'Cancels a reply on Gmail or LINE while it is still waiting out the undo window (the ' +
      '`sendAt` of the delivery, UI spec 17 Q1). The message stays in the timeline as ' +
      '`cancelled` and nothing reaches the customer; the status the reply set stays. Only the ' +
      'sender, or a holder of `ticket.cancel.any` (lead and head by default), may undo; a client ' +
      'never. Asking again for a delivery already undone succeeds. ' +
      'Once the window has ended the message is being sent: 409 (`conflict`).',
  })
  @ApiOkResponse({ standardSchema: cancelSendResultSchema })
  @ApiNotFoundResponse({ description: 'No such delivery on this ticket' })
  @ApiForbiddenResponse({
    description: 'Not the sender and without `ticket.cancel.any`, or scoped to an organization',
  })
  @ApiConflictResponse({ description: 'The window has ended or the message was already sent' })
  async cancel(
    @Param({ schema: deliveryParamSchema }) params: DeliveryParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    assertCanCancel(principal);
    const result = await this.uow.run((uow) =>
      this.outbound.cancel(
        uow,
        { ref: params.id, deliveryId: params.deliveryId, canCancelAny: canCancelAny(principal) },
        { type: 'user', id: principal.userId },
      ),
    );
    return parseResponse(cancelSendResultSchema, result);
  }

  @Get('settings/outbound')
  @RequirePermission('ticket.reply')
  @ApiOperation({
    summary: 'Outbound settings of this instance',
    description:
      '`undoSendSeconds` (0-30, default 5) is how long a staff reply on Gmail or LINE waits before ' +
      'it is sent, so it can be undone. 0 sends at once. An automatic acknowledgment is never held.',
  })
  @ApiOkResponse({ standardSchema: outboundSettingsSchema })
  async read() {
    return parseResponse(outboundSettingsSchema, await this.outbound.readSettings());
  }

  @Put('settings/outbound')
  @RequirePermission('integration.manage')
  @Audited({ action: AUDIT_ACTIONS.outboundSettingSet, targetType: 'instance_setting' })
  @ApiOperation({
    summary: 'Change the outbound settings (head)',
    description:
      'Takes effect for replies written after the change; audited with the old and new value.',
  })
  @ApiOkResponse({ standardSchema: outboundSettingsSchema })
  async write(
    @Body({ schema: outboundSettingsSchema }) body: OutboundSettings,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await this.uow.run((uow) =>
      this.outbound.setUndoSendSeconds(uow, body.undoSendSeconds, {
        type: 'user',
        id: principal.userId,
      }),
    );
    return parseResponse(outboundSettingsSchema, result);
  }
}
