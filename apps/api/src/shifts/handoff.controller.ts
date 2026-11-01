import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  ackHandoffItemSchema,
  currentHandoffSchema,
  handoffItemParamSchema,
  ackResultSchema,
  handoffSchema,
  idParamSchema,
  incomingHandoffsSchema,
  saveHandoffSchema,
  type AckHandoffItem,
  type SaveHandoff,
} from '@watchtower/shared';
import type { z } from 'zod';

import {
  AuditPiiRead,
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { HandoffService } from './handoff.service.js';

type IdParam = z.infer<typeof idParamSchema>;
type ItemParam = z.infer<typeof handoffItemParamSchema>;

@ApiTags('handoff')
@Controller('v1/handoffs')
export class HandoffController {
  constructor(@Inject(HandoffService) private readonly handoffs: HandoffService) {}

  @Get('current')
  @RequirePermission('handoff.write')
  @AuditPiiRead('handoff')
  @ApiOperation({
    summary: 'The handoff of the caller open shift',
    description:
      '`handoff` is null until `POST /v1/handoffs/prefill` makes the draft. `gate` is what AC-7 ' +
      'refuses right now (`noConfirmedHandoff`, `blockers`); `incomingCandidates` are people ' +
      'rostered to start around the end of this shift.',
  })
  @ApiOkResponse({ standardSchema: currentHandoffSchema })
  async current(@CurrentPrincipal() principal: Principal) {
    return parseResponse(currentHandoffSchema, await this.handoffs.current(principal));
  }

  @Post('prefill')
  @HttpCode(200)
  @RequirePermission('handoff.write')
  @Audited({ action: AUDIT_ACTIONS.handoffPrefill, targetType: 'handoff' })
  @ApiOperation({
    summary: 'Start the handoff draft and pre-fill it from the data',
    description:
      'Adds a `pending` item for every open ticket assigned to the caller that the draft does not ' +
      'list yet, with how many shifts it has already crossed. Made by code, not an AI. Idempotent; ' +
      'a confirmed handoff is returned unchanged. Incidents, deploys, snoozed alerts and watch items ' +
      'have no source tables yet: the person adds them by hand.',
  })
  @ApiOkResponse({ standardSchema: handoffSchema })
  @ApiConflictResponse({ description: 'Not clocked in' })
  async prefill(@CurrentPrincipal() principal: Principal) {
    return parseResponse(handoffSchema, await this.handoffs.prefill(principal));
  }

  @Get('incoming')
  @RequirePermission('handoff.ack')
  @AuditPiiRead('handoff')
  @ApiOperation({
    summary: 'Handoffs addressed to the caller, with the items to acknowledge',
    description:
      'Confirmed within the last 36 hours, naming the caller or naming nobody (then the caller must ' +
      'be clocked in). `total` / `acknowledged` give the progress; `leadAlertAt` is when the lead is ' +
      'alerted if items are still unacknowledged (confirmation + 30 minutes).',
  })
  @ApiOkResponse({ standardSchema: incomingHandoffsSchema })
  async incoming(@CurrentPrincipal() principal: Principal) {
    return parseResponse(incomingHandoffsSchema, await this.handoffs.incoming(principal));
  }

  @Put(':id')
  @RequirePermission('handoff.write')
  @Audited({ action: AUDIT_ACTIONS.handoffSave, targetType: 'handoff' })
  @ApiOperation({
    summary: 'Save the draft',
    description:
      'Replaces the item list (an item left out is removed), the incoming person, the free text and ' +
      'the message for the next shift. Only the owner, only while it is a draft and the shift is ' +
      'open. Changing the text of a prefilled item marks it `edited`.',
  })
  @ApiOkResponse({ standardSchema: handoffSchema })
  @ApiNotFoundResponse({ description: 'Not your handoff' })
  @ApiConflictResponse({ description: 'handoff_locked: confirmed or the shift ended' })
  async save(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Body({ schema: saveHandoffSchema }) body: SaveHandoff,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(handoffSchema, await this.handoffs.save(principal, params.id, body));
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @RequirePermission('handoff.write')
  @Audited({ action: AUDIT_ACTIONS.handoffConfirm, targetType: 'handoff' })
  @ApiOperation({
    summary: 'Confirm the handoff',
    description:
      'Refused with 409 `handoff_incomplete` while an open P1 or P2 ticket assigned to the caller ' +
      'is not a pending item with a next action. The message for the next shift becomes a shift note.',
  })
  @ApiOkResponse({ standardSchema: handoffSchema })
  @ApiConflictResponse({ description: 'handoff_incomplete or handoff_locked' })
  async confirm(
    @Param({ schema: idParamSchema }) params: IdParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(handoffSchema, await this.handoffs.confirm(principal, params.id));
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @RequirePermission('handoff.write')
  @Audited({ action: AUDIT_ACTIONS.handoffReopen, targetType: 'handoff' })
  @ApiOperation({
    summary: 'Back to draft, to add something',
    description: 'Refused once the incoming person has answered an item (409 `handoff_locked`).',
  })
  @ApiOkResponse({ standardSchema: handoffSchema })
  @ApiConflictResponse({ description: 'handoff_locked' })
  async reopen(
    @Param({ schema: idParamSchema }) params: IdParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(handoffSchema, await this.handoffs.reopen(principal, params.id));
  }

  @Post('items/:itemId/ack')
  @HttpCode(200)
  @RequirePermission('handoff.ack', 'ticket.handle')
  @Audited({ action: AUDIT_ACTIONS.handoffItemAck, targetType: 'handoff_item' })
  @ApiOperation({
    summary: 'Accept, reassign or question one handoff item (R-7.6)',
    description:
      '`accept` hands the ticket to the caller, `reassign` to `assigneeId`, if it still sits with ' +
      'the outgoing person; `question` (with `note`) sends a note to the outgoing person and keeps ' +
      'the item open. A question counts as acknowledged. An accepted or reassigned item cannot be ' +
      'answered again (409 `handoff_locked`). An item of a handoff not addressed to the caller is a 404.',
  })
  @ApiOkResponse({ standardSchema: ackResultSchema })
  @ApiNotFoundResponse({ description: 'No such item, or not addressed to you' })
  @ApiConflictResponse({ description: 'handoff_locked: already acknowledged' })
  async acknowledge(
    @Param({ schema: handoffItemParamSchema }) params: ItemParam,
    @Body({ schema: ackHandoffItemSchema }) body: AckHandoffItem,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      ackResultSchema,
      await this.handoffs.acknowledge(principal, params.itemId, body),
    );
  }
}
