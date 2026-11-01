import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  createShiftNoteSchema,
  idParamSchema,
  shiftNotePageSchema,
  shiftNoteQuerySchema,
  shiftNoteSchema,
  type CreateShiftNote,
  type ShiftNoteQuery,
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
import { ShiftNotes } from './shift-notes.service.js';

type IdParam = z.infer<typeof idParamSchema>;

@ApiTags('shifts')
@Controller('v1/shift-notes')
export class ShiftNotesController {
  constructor(@Inject(ShiftNotes) private readonly notes: ShiftNotes) {}

  @Get()
  @RequirePermission('shift.note.write')
  @AuditPiiRead('shift_note')
  @ApiOperation({
    summary: 'Shift notes: the inbox or the ones the caller sent',
    description:
      '`box=inbox` (default): notes to the caller, notes to the next shift written by someone else in ' +
      'the last 48 hours, and notes for a date and time that has come. `unread=true` keeps the ones not ' +
      'marked read. `unreadCount` is always the inbox count. Keyset paginated.',
  })
  @ApiOkResponse({ standardSchema: shiftNotePageSchema })
  async list(
    @Query({ schema: shiftNoteQuerySchema }) query: ShiftNoteQuery,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(shiftNotePageSchema, await this.notes.list(principal, query));
  }

  @Post()
  @RequirePermission('shift.note.write')
  @Audited({ action: AUDIT_ACTIONS.shiftNoteCreate, targetType: 'shift_note' })
  @ApiOperation({
    summary: 'Leave a note for the next shift, a person, or a date and time',
    description:
      '`person` needs `toUserId`; `datetime` needs `deliverAt` (and may name `toUserId`).',
  })
  @ApiCreatedResponse({ standardSchema: shiftNoteSchema })
  async create(
    @Body({ schema: createShiftNoteSchema }) body: CreateShiftNote,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(shiftNoteSchema, await this.notes.create(principal, body));
  }

  @Post(':id/read')
  @HttpCode(200)
  @RequirePermission('shift.note.write')
  @Audited({ action: AUDIT_ACTIONS.shiftNoteRead, targetType: 'shift_note' })
  @ApiOperation({ summary: 'Mark a note of the inbox read' })
  @ApiOkResponse({ standardSchema: shiftNoteSchema })
  @ApiNotFoundResponse({ description: 'No such note in your inbox' })
  async markRead(
    @Param({ schema: idParamSchema }) params: IdParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(shiftNoteSchema, await this.notes.markRead(principal, params.id));
  }
}
