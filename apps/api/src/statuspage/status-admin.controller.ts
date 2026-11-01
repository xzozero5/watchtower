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
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  createStatusComponentSchema,
  createStatusMaintenanceSchema,
  createStatusPostSchema,
  draftFromIncidentSchema,
  publishResultSchema,
  statusComponentListSchema,
  statusComponentSchema,
  statusIdParamSchema,
  statusMaintenanceListSchema,
  statusMaintenanceStaffSchema,
  statusPostListQuerySchema,
  statusPostListSchema,
  statusPostStaffSchema,
  subscriberSummarySchema,
  updateStatusComponentSchema,
  updateStatusMaintenanceSchema,
  updateStatusPostSchema,
  type CreateStatusComponent,
  type CreateStatusMaintenance,
  type CreateStatusPost,
  type DraftFromIncident,
  type StatusIdParam,
  type StatusPostListQuery,
  type UpdateStatusComponent,
  type UpdateStatusMaintenance,
  type UpdateStatusPost,
} from '@watchtower/shared';
import { z } from 'zod';

import { CurrentPrincipal, RequirePermission, type Principal } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { StatusAdminService } from './status-admin.service.js';

const userOf = (principal: Principal) => ({ type: 'user', id: principal.userId }) as const;
const deletedSchema = z.object({ deleted: z.boolean() });
const publishMaintenanceResultSchema = z.object({
  maintenance: statusMaintenanceStaffSchema,
  subscribers: z.number().int(),
});

/**
 * Staff administration of the status page (R-6.1, R-6.3). Drafting is for whoever may open an incident
 * (`incident.create`: agent and up); **publishing, and changing anything already public, needs
 * `incident.manage`** (lead and up) and a signed-in person: the AI and the system are refused in the
 * domain whoever drafted (N3). Components are part of the service catalog's admin (`service.manage`).
 * Reading is for every staff role (`ticket.read`); a customer holds none of these.
 */
@ApiTags('status page admin')
@Controller('v1/status-page')
export class StatusAdminController {
  constructor(@Inject(StatusAdminService) private readonly service: StatusAdminService) {}

  // --- components ---

  @Get('components')
  @RequirePermission('ticket.read')
  @ApiOperation({ summary: 'List components (public or not)' })
  @ApiOkResponse({ standardSchema: statusComponentListSchema })
  async listComponents() {
    return parseResponse(statusComponentListSchema, { items: await this.service.listComponents() });
  }

  @Post('components')
  @RequirePermission('service.manage')
  @ApiOperation({
    summary: 'Add a component',
    description: 'Off the page until `public` is set. May point at a service of the catalog.',
  })
  @ApiCreatedResponse({ standardSchema: statusComponentSchema })
  @ApiConflictResponse({ description: 'The slug is taken' })
  async createComponent(
    @Body({ schema: createStatusComponentSchema }) body: CreateStatusComponent,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      statusComponentSchema,
      await this.service.createComponent(userOf(principal), body),
    );
  }

  @Patch('components/:id')
  @RequirePermission('service.manage')
  @ApiOperation({
    summary: 'Change a component',
    description: 'Its name, whether it is public, its position and its current status.',
  })
  @ApiOkResponse({ standardSchema: statusComponentSchema })
  @ApiNotFoundResponse({ description: 'No such component' })
  async updateComponent(
    @Param({ schema: statusIdParamSchema }) params: StatusIdParam,
    @Body({ schema: updateStatusComponentSchema }) body: UpdateStatusComponent,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      statusComponentSchema,
      await this.service.updateComponent(userOf(principal), params.id, body),
    );
  }

  @Delete('components/:id')
  @RequirePermission('service.manage')
  @ApiOperation({ summary: 'Remove a component (posts and windows lose the link)' })
  @ApiOkResponse({ standardSchema: deletedSchema })
  async deleteComponent(
    @Param({ schema: statusIdParamSchema }) params: StatusIdParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      deletedSchema,
      await this.service.deleteComponent(userOf(principal), params.id),
    );
  }

  // --- posts ---

  @Get('posts')
  @RequirePermission('ticket.read')
  @ApiOperation({ summary: 'List posts, newest first', description: 'Filter by `state`.' })
  @ApiOkResponse({ standardSchema: statusPostListSchema })
  async listPosts(@Query({ schema: statusPostListQuerySchema }) query: StatusPostListQuery) {
    return parseResponse(statusPostListSchema, await this.service.listPosts(query));
  }

  @Get('posts/:id')
  @RequirePermission('ticket.read')
  @ApiOperation({ summary: 'One post' })
  @ApiOkResponse({ standardSchema: statusPostStaffSchema })
  @ApiNotFoundResponse({ description: 'No such post' })
  async getPost(@Param({ schema: statusIdParamSchema }) params: StatusIdParam) {
    return parseResponse(statusPostStaffSchema, await this.service.getPost(params.id));
  }

  @Post('posts')
  @RequirePermission('incident.create')
  @ApiOperation({
    summary: 'Write a draft',
    description:
      'A draft is invisible to the public page and tells nobody. `incidentId` only links the draft to ' +
      'an incident for staff.',
  })
  @ApiCreatedResponse({ standardSchema: statusPostStaffSchema })
  async draftPost(
    @Body({ schema: createStatusPostSchema }) body: CreateStatusPost,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      statusPostStaffSchema,
      await this.service.draftPost(userOf(principal), body),
    );
  }

  @Post('posts/from-incident')
  @RequirePermission('incident.create')
  @ApiOperation({
    summary: 'Write a draft for an incident from the template of its phase',
    description:
      'The wording names the affected components and nothing else: no title, cause, system, count or ' +
      'time of the incident reaches it. A person edits it and publishes it.',
  })
  @ApiCreatedResponse({ standardSchema: statusPostStaffSchema })
  async draftFromIncident(
    @Body({ schema: draftFromIncidentSchema }) body: DraftFromIncident,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      statusPostStaffSchema,
      await this.service.draftFromIncident(userOf(principal), body),
    );
  }

  @Patch('posts/:id')
  @RequirePermission('incident.create')
  @ApiOperation({
    summary: 'Change a post',
    description: 'A draft: anyone who may draft. A post that is already public: `incident.manage`.',
  })
  @ApiOkResponse({ standardSchema: statusPostStaffSchema })
  @ApiForbiddenResponse({ description: 'The post is public and the caller may not publish' })
  async updatePost(
    @Param({ schema: statusIdParamSchema }) params: StatusIdParam,
    @Body({ schema: updateStatusPostSchema }) body: UpdateStatusPost,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      statusPostStaffSchema,
      await this.service.updatePost(
        userOf(principal),
        params.id,
        body,
        principal.permissions.has('incident.manage'),
      ),
    );
  }

  @Post('posts/:id/publish')
  @HttpCode(200)
  @RequirePermission('incident.manage')
  @ApiOperation({
    summary: 'Publish a post (a person presses)',
    description:
      'Makes the draft public and queues one email to each confirmed subscriber. Needs a signed-in ' +
      'person with `incident.manage`; whoever or whatever drafted the words, the AI cannot publish.',
  })
  @ApiOkResponse({ standardSchema: publishResultSchema })
  @ApiConflictResponse({ description: 'Already published' })
  async publishPost(
    @Param({ schema: statusIdParamSchema }) params: StatusIdParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      publishResultSchema,
      await this.service.publishPost(userOf(principal), params.id),
    );
  }

  @Delete('posts/:id')
  @RequirePermission('incident.create')
  @ApiOperation({
    summary: 'Delete a draft',
    description: 'A published post cannot be deleted (409).',
  })
  @ApiOkResponse({ standardSchema: deletedSchema })
  @ApiConflictResponse({ description: 'The post is published' })
  async deletePost(
    @Param({ schema: statusIdParamSchema }) params: StatusIdParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      deletedSchema,
      await this.service.deletePost(userOf(principal), params.id),
    );
  }

  // --- maintenance ---

  @Get('maintenance')
  @RequirePermission('ticket.read')
  @ApiOperation({ summary: 'List maintenance windows' })
  @ApiOkResponse({ standardSchema: statusMaintenanceListSchema })
  async listMaintenance() {
    return parseResponse(statusMaintenanceListSchema, {
      items: await this.service.listMaintenance(),
    });
  }

  @Post('maintenance')
  @RequirePermission('incident.create')
  @ApiOperation({ summary: 'Write a draft maintenance window' })
  @ApiCreatedResponse({ standardSchema: statusMaintenanceStaffSchema })
  async draftMaintenance(
    @Body({ schema: createStatusMaintenanceSchema }) body: CreateStatusMaintenance,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      statusMaintenanceStaffSchema,
      await this.service.draftMaintenance(userOf(principal), body),
    );
  }

  @Patch('maintenance/:id')
  @RequirePermission('incident.create')
  @ApiOperation({
    summary: 'Change a maintenance window',
    description: 'A draft: anyone who may draft. A published one: `incident.manage`.',
  })
  @ApiOkResponse({ standardSchema: statusMaintenanceStaffSchema })
  async updateMaintenance(
    @Param({ schema: statusIdParamSchema }) params: StatusIdParam,
    @Body({ schema: updateStatusMaintenanceSchema }) body: UpdateStatusMaintenance,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      statusMaintenanceStaffSchema,
      await this.service.updateMaintenance(
        userOf(principal),
        params.id,
        body,
        principal.permissions.has('incident.manage'),
      ),
    );
  }

  @Post('maintenance/:id/publish')
  @HttpCode(200)
  @RequirePermission('incident.manage')
  @ApiOperation({
    summary: 'Publish a maintenance window (a person presses)',
    description: 'Same rule as a post: a signed-in person with `incident.manage`.',
  })
  @ApiOkResponse({ standardSchema: publishMaintenanceResultSchema })
  @ApiConflictResponse({ description: 'Not a draft' })
  async publishMaintenance(
    @Param({ schema: statusIdParamSchema }) params: StatusIdParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      publishMaintenanceResultSchema,
      await this.service.publishMaintenance(userOf(principal), params.id),
    );
  }

  @Post('maintenance/:id/cancel')
  @HttpCode(200)
  @RequirePermission('incident.manage')
  @ApiOperation({ summary: 'Cancel a maintenance window' })
  @ApiOkResponse({ standardSchema: statusMaintenanceStaffSchema })
  async cancelMaintenance(
    @Param({ schema: statusIdParamSchema }) params: StatusIdParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      statusMaintenanceStaffSchema,
      await this.service.cancelMaintenance(userOf(principal), params.id),
    );
  }

  // --- subscribers ---

  @Get('subscribers')
  @RequirePermission('incident.manage')
  @ApiOperation({
    summary: 'How many people follow the page',
    description: 'Counts by state. The addresses are not listed.',
  })
  @ApiOkResponse({ standardSchema: subscriberSummarySchema })
  async subscribers() {
    return parseResponse(subscriberSummarySchema, await this.service.subscriberSummary());
  }
}
