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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  createIncidentSchema,
  deployListQuerySchema,
  deployListSchema,
  incidentDetailSchema,
  incidentIdParamSchema,
  incidentListQuerySchema,
  incidentListSchema,
  incidentNoteSchema,
  linkAlertSchema,
  linkTicketSchema,
  updateIncidentSchema,
  type CreateIncident,
  type DeployListQuery,
  type IncidentIdParam,
  type IncidentListQuery,
  type IncidentNote,
  type LinkAlert,
  type LinkTicket,
  type UpdateIncident,
} from '@watchtower/shared';
import { z } from 'zod';

import { CurrentPrincipal, RequirePermission, type Principal } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { IncidentsService } from './incidents.service.js';

const ticketParamSchema = z.object({ id: z.uuid(), ticketId: z.uuid() });
type TicketParam = z.infer<typeof ticketParamSchema>;
const changedSchema = z.object({ changed: z.boolean() });

const userOf = (principal: Principal) => ({ type: 'user', id: principal.userId }) as const;

/**
 * Incidents (R-3.12): reading needs `ticket.read` (every staff role), opening and changing one needs
 * `incident.create` (agent and up), resolving one needs `incident.manage` (lead and up). Every
 * mutation is written by the domain with its audit row; the system never opens an incident.
 */
@ApiTags('incidents')
@Controller('v1/incidents')
export class IncidentsController {
  constructor(
    @Inject(IncidentsService) private readonly incidents: IncidentsService,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
  ) {}

  @Get()
  @RequirePermission('ticket.read')
  @ApiOperation({
    summary: 'List incidents, newest first',
    description:
      'Filter by `status` or `open=true`. Keyset pagination: pass `nextCursor` back as `cursor`.',
  })
  @ApiOkResponse({ standardSchema: incidentListSchema })
  async list(@Query({ schema: incidentListQuerySchema }) query: IncidentListQuery) {
    return parseResponse(incidentListSchema, await this.incidents.list(query));
  }

  @Get(':id')
  @RequirePermission('ticket.read')
  @ApiOperation({
    summary: 'One incident with its timeline',
    description:
      'The timeline is oldest first. Entries hold ids and enumerations; a `note` holds the text a ' +
      'person wrote (internal).',
  })
  @ApiOkResponse({ standardSchema: incidentDetailSchema })
  @ApiNotFoundResponse({ description: 'No such incident' })
  async get(@Param({ schema: incidentIdParamSchema }) params: IncidentIdParam) {
    return parseResponse(incidentDetailSchema, await this.incidents.get(params.id));
  }

  @Post()
  @RequirePermission('incident.create')
  @ApiOperation({
    summary: 'Open an incident',
    description:
      'A person decides (the system only proposes: see GET /v1/alerts/correlations). Attaches the given ' +
      'alerts and tickets; the organizations of those tickets become affected organizations. The ' +
      'commander defaults to the caller. A Discord thread is queued.',
  })
  @ApiCreatedResponse({ standardSchema: incidentDetailSchema })
  @ApiBadRequestResponse({ description: 'Invalid body, an unknown service, alert or organization' })
  @ApiConflictResponse({ description: 'An alert or ticket already belongs to another incident' })
  async create(
    @Body({ schema: createIncidentSchema }) body: CreateIncident,
    @CurrentPrincipal() principal: Principal,
  ) {
    const { incidentId } = await this.uow.run((uow) =>
      this.incidents.create(uow, userOf(principal), body),
    );
    return parseResponse(incidentDetailSchema, await this.incidents.get(incidentId));
  }

  @Patch(':id')
  @RequirePermission('incident.create')
  @ApiOperation({
    summary: 'Change an incident',
    description:
      'Title, severity, status, commander, root cause. The status moves among the open ones in either ' +
      'direction and ends at `resolved`, which needs `incident.manage` and is final; the incident never ' +
      'resolves by itself when its alerts close.',
  })
  @ApiOkResponse({ standardSchema: incidentDetailSchema })
  @ApiBadRequestResponse({ description: 'Invalid change, or resolving without incident.manage' })
  @ApiNotFoundResponse({ description: 'No such incident' })
  @ApiConflictResponse({ description: 'The incident is resolved' })
  async update(
    @Param({ schema: incidentIdParamSchema }) params: IncidentIdParam,
    @Body({ schema: updateIncidentSchema }) body: UpdateIncident,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.uow.run((uow) =>
      this.incidents.update(
        uow,
        userOf(principal),
        params.id,
        body,
        principal.permissions.has('incident.manage'),
      ),
    );
    return parseResponse(incidentDetailSchema, await this.incidents.get(params.id));
  }

  @Post(':id/tickets')
  @HttpCode(200)
  @RequirePermission('incident.create')
  @ApiOperation({
    summary: 'Link a ticket',
    description:
      '`changed` is false if it was linked already. A ticket belongs to one incident (409).',
  })
  @ApiOkResponse({ standardSchema: changedSchema })
  @ApiConflictResponse({ description: 'Linked to another incident, or this one is resolved' })
  async linkTicket(
    @Param({ schema: incidentIdParamSchema }) params: IncidentIdParam,
    @Body({ schema: linkTicketSchema }) body: LinkTicket,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await this.uow.run((uow) =>
      this.incidents.linkTicket(uow, userOf(principal), params.id, body.ticketId),
    );
    return parseResponse(changedSchema, result);
  }

  @Delete(':id/tickets/:ticketId')
  @RequirePermission('incident.create')
  @ApiOperation({
    summary: 'Unlink a ticket',
    description: '`changed` is false if it was not linked.',
  })
  @ApiOkResponse({ standardSchema: changedSchema })
  async unlinkTicket(
    @Param({ schema: ticketParamSchema }) params: TicketParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await this.uow.run((uow) =>
      this.incidents.unlinkTicket(uow, userOf(principal), params.id, params.ticketId),
    );
    return parseResponse(changedSchema, result);
  }

  @Post(':id/alerts')
  @HttpCode(200)
  @RequirePermission('incident.create')
  @ApiOperation({
    summary: 'Link an alert',
    description: '`changed` is false if it was linked already.',
  })
  @ApiOkResponse({ standardSchema: changedSchema })
  @ApiConflictResponse({ description: 'Linked to another incident, or this one is resolved' })
  async linkAlert(
    @Param({ schema: incidentIdParamSchema }) params: IncidentIdParam,
    @Body({ schema: linkAlertSchema }) body: LinkAlert,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await this.uow.run((uow) =>
      this.incidents.linkAlert(uow, userOf(principal), params.id, body.alertId),
    );
    return parseResponse(changedSchema, result);
  }

  @Post(':id/notes')
  @RequirePermission('incident.create')
  @ApiOperation({
    summary: 'Add a note to the timeline',
    description: 'Internal. The text is never sent to Discord.',
  })
  @ApiCreatedResponse({ standardSchema: z.object({ timelineId: z.uuid() }) })
  @ApiConflictResponse({ description: 'The incident is resolved' })
  async note(
    @Param({ schema: incidentIdParamSchema }) params: IncidentIdParam,
    @Body({ schema: incidentNoteSchema }) body: IncidentNote,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.uow.run((uow) => this.incidents.note(uow, userOf(principal), params.id, body));
  }
}

/** The deploy feed as staff read it (R-5.4). The feed itself is `POST /v1/inbound/deploys`. */
@ApiTags('incidents')
@Controller('v1/deploys')
export class DeploysController {
  constructor(@Inject(IncidentsService) private readonly incidents: IncidentsService) {}

  @Get()
  @RequirePermission('alert.read')
  @ApiOperation({ summary: 'Deploys, newest first', description: 'Filter by `serviceId`.' })
  @ApiOkResponse({ standardSchema: deployListSchema })
  async list(@Query({ schema: deployListQuerySchema }) query: DeployListQuery) {
    return parseResponse(deployListSchema, { items: await this.incidents.deploys(query) });
  }
}
