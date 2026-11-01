import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  assigneeListSchema,
  assigneeQuerySchema,
  clockInSchema,
  clockOutResultSchema,
  clockOutSchema,
  shiftBriefSchema,
  shiftOverviewSchema,
  shiftSessionSchema,
  shiftStatusSchema,
  type AssigneeQuery,
  type ClockIn,
  type ClockOut,
} from '@watchtower/shared';

import {
  AuditPiiRead,
  Audited,
  CurrentPrincipal,
  RequireAnyPermission,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { BriefService } from './brief.service.js';
import { ShiftsService } from './shifts.service.js';

@ApiTags('shifts')
@Controller('v1')
export class ShiftsController {
  constructor(
    @Inject(ShiftsService) private readonly shifts: ShiftsService,
    @Inject(BriefService) private readonly brief: BriefService,
  ) {}

  @Get('shifts/status')
  @RequirePermission('shift.clock')
  @ApiOperation({
    summary: 'The caller shift state, for the shift chip',
    description:
      'The open session (null when off shift), the rostered shifts around now, minutes to the end of ' +
      'the shift (negative once it has passed), the handoff state, why a clock out would be refused ' +
      '(`clockOutBlocked`, AC-7), unread notes and handoff items still to acknowledge.',
  })
  @ApiOkResponse({ standardSchema: shiftStatusSchema })
  async status(@CurrentPrincipal() principal: Principal) {
    return parseResponse(shiftStatusSchema, await this.shifts.status(principal));
  }

  @Post('shifts/clock-in')
  @RequirePermission('shift.clock')
  @Audited({ action: AUDIT_ACTIONS.shiftClockIn, targetType: 'shift_session' })
  @ApiOperation({
    summary: 'Clock in',
    description:
      'Attaches the rostered shift that is running or starts within an hour. Without one the person ' +
      'still clocks in (`onRoster: false`). `lateMinutes` counts from the scheduled start; `late` is ' +
      'true past a 5 minute grace period. Location is a consent flag only, no position is stored.',
  })
  @ApiOkResponse({ standardSchema: shiftSessionSchema })
  @ApiConflictResponse({ description: 'Already clocked in' })
  @HttpCode(200)
  async clockIn(
    @Body({ schema: clockInSchema }) body: ClockIn,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(shiftSessionSchema, await this.shifts.clockIn(principal, body));
  }

  @Post('shifts/clock-out')
  @RequirePermission('shift.clock')
  @Audited({ action: AUDIT_ACTIONS.shiftClockOut, targetType: 'shift_session' })
  @ApiOperation({
    summary: 'Clock out (blocked until the handoff is complete, AC-7)',
    description:
      'Refused with 409 `handoff_incomplete` (body: `noConfirmedHandoff`, `blockers`) unless the ' +
      'handoff is confirmed and every open P1/P2 ticket assigned to the person is in it with a next ' +
      'action. A lead or head may pass `override.reason` (10 to 500 characters) to clock out anyway; ' +
      'the reason and what was missing are audited (`shift.clock_out_override`). `userId` clocks out ' +
      'someone else (lead, head).',
  })
  @ApiOkResponse({ standardSchema: clockOutResultSchema })
  @ApiConflictResponse({ description: 'Not clocked in, or handoff_incomplete' })
  @ApiForbiddenResponse({ description: 'override or userId without roster.manage' })
  @HttpCode(200)
  async clockOut(
    @Body({ schema: clockOutSchema }) body: ClockOut,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(clockOutResultSchema, await this.shifts.clockOut(principal, body));
  }

  @Get('shifts/overview')
  @RequireAnyPermission('roster.manage', 'performance.read.all')
  @AuditPiiRead('shift_overview')
  @ApiOperation({
    summary:
      "The lead's view: who is on shift, no-shows, unacknowledged handoff items (lead, head)",
    description:
      'After the incoming shift acknowledges every item, `unacknowledged.count` is 0 (AC-7). ' +
      '`overdue` counts items whose handoff was confirmed more than 30 minutes ago.',
  })
  @ApiOkResponse({ standardSchema: shiftOverviewSchema })
  async overview() {
    return parseResponse(shiftOverviewSchema, await this.shifts.overview());
  }

  @Get('shifts/brief')
  @RequirePermission('shift.clock')
  @AuditPiiRead('shift_brief')
  @ApiOperation({
    summary: 'The daily brief',
    description:
      'Made from data, not by an AI. Section 1 is the handoff from the previous shift, which is ' +
      'enough to meet AC-7; the others follow the order of UI spec 9.2. `aiSummary` is reserved and ' +
      'null today.',
  })
  @ApiOkResponse({ standardSchema: shiftBriefSchema })
  async getBrief(@CurrentPrincipal() principal: Principal) {
    return parseResponse(shiftBriefSchema, await this.brief.brief(principal));
  }

  @Post('shifts/brief/read')
  @HttpCode(200)
  @RequirePermission('shift.clock')
  @Audited({ action: AUDIT_ACTIONS.shiftBriefRead, targetType: 'shift_session' })
  @ApiOperation({ summary: 'Mark the brief read (stamps the open session)' })
  @ApiOkResponse({ standardSchema: shiftSessionSchema })
  @ApiConflictResponse({ description: 'Not clocked in' })
  async markBriefRead(@CurrentPrincipal() principal: Principal) {
    return parseResponse(shiftSessionSchema, await this.shifts.markBriefRead(principal));
  }

  @Get('assignees')
  @RequirePermission('ticket.handle')
  @ApiOperation({
    summary: 'Staff a ticket can be assigned to (for agents, who may not list users)',
    description:
      'Name and role only. `onShift` is true for people who are clocked in; `openTickets` is their ' +
      'load; `inQueue` marks members of the queue given as `queueId`. Assignment by turns, by load ' +
      'or to the last handler only picks people who are on shift; a manual assignment may pick anyone.',
  })
  @ApiOkResponse({ standardSchema: assigneeListSchema })
  async assignees(@Query({ schema: assigneeQuerySchema }) query: AssigneeQuery) {
    return parseResponse(assigneeListSchema, await this.brief.assignees(query));
  }
}
