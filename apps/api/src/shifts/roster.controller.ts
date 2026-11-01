import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  createRosterEntrySchema,
  createShiftDefinitionSchema,
  idParamSchema,
  rosterEntrySchema,
  rosterListSchema,
  rosterQuerySchema,
  shiftDefinitionListSchema,
  shiftDefinitionSchema,
  updateShiftDefinitionSchema,
  type CreateRosterEntry,
  type CreateShiftDefinition,
  type RosterQuery,
  type UpdateShiftDefinition,
} from '@watchtower/shared';
import type { z } from 'zod';

import {
  Audited,
  CurrentPrincipal,
  RequireAnyPermission,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { ShiftsService } from './shifts.service.js';

type IdParam = z.infer<typeof idParamSchema>;

@ApiTags('shifts')
@Controller('v1')
export class RosterController {
  constructor(@Inject(ShiftsService) private readonly shifts: ShiftsService) {}

  @Get('shifts/definitions')
  @RequireAnyPermission('shift.clock', 'roster.manage')
  @ApiOperation({
    summary: 'Shift definitions and the time zone their times are in',
    description:
      'Wall-clock windows such as 08:00 to 17:00 (R-7.1). `timezone` is the zone of the default ' +
      'business calendar. A shift whose end is not after its start is `overnight`: it ends the next ' +
      'local day. Inactive shifts are listed so a roster can still show them.',
  })
  @ApiOkResponse({ standardSchema: shiftDefinitionListSchema })
  async definitions() {
    return parseResponse(shiftDefinitionListSchema, await this.shifts.definitions());
  }

  @Post('shifts/definitions')
  @RequirePermission('roster.manage')
  @Audited({ action: AUDIT_ACTIONS.shiftDefinitionCreate, targetType: 'shift_definition' })
  @ApiOperation({ summary: 'Create a shift definition (lead, head)' })
  @ApiCreatedResponse({ standardSchema: shiftDefinitionSchema })
  @ApiConflictResponse({ description: 'The name is taken' })
  async createDefinition(
    @Body({ schema: createShiftDefinitionSchema }) body: CreateShiftDefinition,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      shiftDefinitionSchema,
      await this.shifts.createDefinition(principal, body),
    );
  }

  @Patch('shifts/definitions/:id')
  @RequirePermission('roster.manage')
  @Audited({ action: AUDIT_ACTIONS.shiftDefinitionUpdate, targetType: 'shift_definition' })
  @ApiOperation({
    summary: 'Edit a shift definition (lead, head)',
    description:
      'Changes the times of every roster entry of the shift, past and future; a clock-in session ' +
      'keeps the window it had when the person clocked in. Set `active: false` to retire a shift.',
  })
  @ApiOkResponse({ standardSchema: shiftDefinitionSchema })
  @ApiNotFoundResponse({ description: 'No such shift' })
  async updateDefinition(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Body({ schema: updateShiftDefinitionSchema }) body: UpdateShiftDefinition,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      shiftDefinitionSchema,
      await this.shifts.updateDefinition(principal, params.id, body),
    );
  }

  @Get('roster')
  @RequireAnyPermission('shift.clock', 'roster.manage')
  @ApiOperation({
    summary: 'The roster between two dates',
    description:
      'Who works which shift on which local date (`workDate` is the date the shift starts). A lead ' +
      'or head sees everyone and may pass `userId`; anyone else gets only their own schedule. At most ' +
      '62 days.',
  })
  @ApiOkResponse({ standardSchema: rosterListSchema })
  @ApiBadRequestResponse({ description: 'to before from, or a range over 62 days' })
  async roster(
    @Query({ schema: rosterQuerySchema }) query: RosterQuery,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(rosterListSchema, await this.shifts.roster(principal, query));
  }

  @Post('roster')
  @RequirePermission('roster.manage')
  @Audited({ action: AUDIT_ACTIONS.rosterAssign, targetType: 'roster_entry' })
  @ApiOperation({
    summary: 'Put a person on a shift on a date (lead, head)',
    description: 'Idempotent: the same person, shift and date again returns the existing entry.',
  })
  @ApiCreatedResponse({ standardSchema: rosterEntrySchema })
  @ApiBadRequestResponse({ description: 'Not an active staff user, or not an active shift' })
  async assign(
    @Body({ schema: createRosterEntrySchema }) body: CreateRosterEntry,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(rosterEntrySchema, await this.shifts.assignRoster(principal, body));
  }

  @Delete('roster/:id')
  @HttpCode(204)
  @RequirePermission('roster.manage')
  @Audited({ action: AUDIT_ACTIONS.rosterRemove, targetType: 'roster_entry' })
  @ApiOperation({ summary: 'Take a person off a shift (lead, head)' })
  @ApiNoContentResponse({ description: 'Removed' })
  @ApiNotFoundResponse({ description: 'No such roster entry' })
  async remove(
    @Param({ schema: idParamSchema }) params: IdParam,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.shifts.removeRoster(principal, params.id);
  }
}
