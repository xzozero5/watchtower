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
} from '@nestjs/common';
import {
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
  businessCalendarListSchema,
  businessCalendarSchema,
  createBusinessCalendarSchema,
  createSlaPolicySchema,
  idParamSchema,
  slaPolicyListSchema,
  slaPolicySchema,
  updateBusinessCalendarSchema,
  updateSlaPolicySchema,
  type CreateBusinessCalendar,
  type CreateSlaPolicy,
  type UpdateBusinessCalendar,
  type UpdateSlaPolicy,
} from '@watchtower/shared';
import type { z } from 'zod';

import { Audited, RequirePermission } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { SlaAdminService } from './sla-admin.service.js';

type IdParam = z.infer<typeof idParamSchema>;

@ApiTags('sla')
@Controller('v1/sla-policies')
export class SlaPoliciesController {
  constructor(@Inject(SlaAdminService) private readonly sla: SlaAdminService) {}

  @Get()
  @RequirePermission('ticket.read')
  @ApiOperation({ summary: 'List SLA policies (staff)' })
  @ApiOkResponse({ standardSchema: slaPolicyListSchema })
  async list() {
    return parseResponse(slaPolicyListSchema, { policies: await this.sla.listPolicies() });
  }

  @Get(':id')
  @RequirePermission('ticket.read')
  @ApiOperation({ summary: 'One SLA policy (staff)' })
  @ApiOkResponse({ standardSchema: slaPolicySchema })
  @ApiNotFoundResponse({ description: 'No such policy' })
  async get(@Param({ schema: idParamSchema }) params: IdParam) {
    return parseResponse(slaPolicySchema, await this.sla.getPolicy(params.id));
  }

  @Post()
  @RequirePermission('sla.manage')
  @Audited({ action: AUDIT_ACTIONS.slaPolicyCreate, targetType: 'sla_policy' })
  @ApiOperation({
    summary: 'Create an SLA policy',
    description:
      '`targets` maps a priority (P1 to P4) to `first_response_min`, `resolution_min` and the ' +
      'clock (`business` or `24x7`). A policy with a `tier` is the default for organizations of that tier.',
  })
  @ApiCreatedResponse({ standardSchema: slaPolicySchema })
  @ApiConflictResponse({ description: 'The name, or the tier, already has a policy' })
  async create(@Body({ schema: createSlaPolicySchema }) body: CreateSlaPolicy) {
    return parseResponse(slaPolicySchema, await this.sla.createPolicy(body));
  }

  @Patch(':id')
  @RequirePermission('sla.manage')
  @Audited({ action: AUDIT_ACTIONS.slaPolicyUpdate, targetType: 'sla_policy' })
  @ApiOperation({
    summary: 'Edit an SLA policy',
    description: 'Tickets already created keep the due dates they were given.',
  })
  @ApiOkResponse({ standardSchema: slaPolicySchema })
  @ApiNotFoundResponse({ description: 'No such policy' })
  async update(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Body({ schema: updateSlaPolicySchema }) body: UpdateSlaPolicy,
  ) {
    return parseResponse(slaPolicySchema, await this.sla.updatePolicy(params.id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('sla.manage')
  @Audited({ action: AUDIT_ACTIONS.slaPolicyDelete, targetType: 'sla_policy' })
  @ApiOperation({ summary: 'Delete an SLA policy nothing uses' })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiConflictResponse({ description: 'Organizations or tickets use the policy' })
  async remove(@Param({ schema: idParamSchema }) params: IdParam): Promise<void> {
    await this.sla.removePolicy(params.id);
  }
}

@ApiTags('sla')
@Controller('v1/business-calendars')
export class BusinessCalendarsController {
  constructor(@Inject(SlaAdminService) private readonly sla: SlaAdminService) {}

  @Get()
  @RequirePermission('ticket.read')
  @ApiOperation({ summary: 'List business calendars (staff)' })
  @ApiOkResponse({ standardSchema: businessCalendarListSchema })
  async list() {
    return parseResponse(businessCalendarListSchema, { calendars: await this.sla.listCalendars() });
  }

  @Get(':id')
  @RequirePermission('ticket.read')
  @ApiOperation({ summary: 'One business calendar (staff)' })
  @ApiOkResponse({ standardSchema: businessCalendarSchema })
  @ApiNotFoundResponse({ description: 'No such calendar' })
  async get(@Param({ schema: idParamSchema }) params: IdParam) {
    return parseResponse(businessCalendarSchema, await this.sla.getCalendar(params.id));
  }

  @Post()
  @RequirePermission('sla.manage')
  @Audited({ action: AUDIT_ACTIONS.calendarCreate, targetType: 'business_calendar' })
  @ApiOperation({
    summary: 'Create a business calendar',
    description:
      'Weekly hours and holidays in the calendar timezone (an IANA name such as Asia/Bangkok). ' +
      'The default calendar serves every SLA policy that names none.',
  })
  @ApiCreatedResponse({ standardSchema: businessCalendarSchema })
  @ApiConflictResponse({ description: 'The name is taken' })
  async create(@Body({ schema: createBusinessCalendarSchema }) body: CreateBusinessCalendar) {
    return parseResponse(businessCalendarSchema, await this.sla.createCalendar(body));
  }

  @Patch(':id')
  @RequirePermission('sla.manage')
  @Audited({ action: AUDIT_ACTIONS.calendarUpdate, targetType: 'business_calendar' })
  @ApiOperation({ summary: 'Edit a business calendar' })
  @ApiOkResponse({ standardSchema: businessCalendarSchema })
  @ApiNotFoundResponse({ description: 'No such calendar' })
  async update(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Body({ schema: updateBusinessCalendarSchema }) body: UpdateBusinessCalendar,
  ) {
    return parseResponse(businessCalendarSchema, await this.sla.updateCalendar(params.id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('sla.manage')
  @Audited({ action: AUDIT_ACTIONS.calendarDelete, targetType: 'business_calendar' })
  @ApiOperation({ summary: 'Delete a calendar no SLA policy uses' })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiConflictResponse({ description: 'An SLA policy uses the calendar' })
  async remove(@Param({ schema: idParamSchema }) params: IdParam): Promise<void> {
    await this.sla.removeCalendar(params.id);
  }
}
