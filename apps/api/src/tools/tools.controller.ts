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
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import {
  adhocDataSchema,
  adhocLogsSchema,
  createToolTemplateSchema,
  evidenceCardIdParamSchema,
  evidenceCardListSchema,
  evidenceCardSchema,
  runToolSchema,
  serviceStatusListSchema,
  ticketRefParamSchema,
  ticketToolsSchema,
  TOOLS_AUDIT_ACTIONS,
  toolTemplateIdParamSchema,
  toolTemplateListQuerySchema,
  toolTemplateListSchema,
  toolTemplateSchema,
  updateToolTemplateSchema,
  type AdhocData,
  type AdhocLogs,
  type CreateToolTemplate,
  type EvidenceCardIdParam,
  type RunTool,
  type ToolTemplateIdParam,
  type ToolTemplateListQuery,
  type UpdateToolTemplate,
} from '@watchtower/shared';
import { z } from 'zod';

import { AuditScope } from '../audit/audit-scope.js';
import { Audited, CurrentPrincipal, RequirePermission, type Principal } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { StatusPanel } from './status-panel.service.js';
import { ToolTemplates } from './templates.service.js';
import { ToolRunner } from './tool-runner.service.js';

type TicketParam = z.infer<typeof ticketRefParamSchema>;
const incidentParamSchema = z.object({ id: z.uuid() });
type IncidentParam = z.infer<typeof incidentParamSchema>;
const ticketCardParamSchema = z.object({
  id: ticketRefParamSchema.shape.id,
  cardId: z.uuid(),
});
type TicketCardParam = z.infer<typeof ticketCardParamSchema>;

const BUDGET_NOTE =
  'Each run takes one unit from the shared rate budget of the system it reads (people and the AI share ' +
  'it; the AI is capped lower). When the budget is used up the answer is 429 with Retry-After.';

/**
 * The saved templates behind the investigation buttons (R-5.1, R-5.2). Anyone who may investigate
 * can read them; only a head changes them (`integration.manage`): a template is a query against
 * customer data. Changes are audited with the template's name and the hash of its body.
 */
@ApiTags('tools')
@Controller('v1/tools/templates')
export class ToolTemplatesController {
  constructor(@Inject(ToolTemplates) private readonly templates: ToolTemplates) {}

  @Get()
  @RequirePermission('investigate.run')
  @ApiOperation({
    summary: 'The saved investigation templates',
    description: 'Filter by `intent` (key) or `kind` (`logs`, `data`). Includes the generic ones when no intent is given.',
  })
  @ApiOkResponse({ standardSchema: toolTemplateListSchema })
  async list(@Query({ schema: toolTemplateListQuerySchema }) query: ToolTemplateListQuery) {
    return parseResponse(toolTemplateListSchema, { items: await this.templates.list(query) });
  }

  @Post()
  @RequirePermission('integration.manage')
  @Audited({ action: TOOLS_AUDIT_ACTIONS.toolTemplateCreate, targetType: 'tool_template' })
  @ApiOperation({
    summary: 'Save a template (head)',
    description:
      'A `logs` body is a filter (`service="x" AND labels.org={{org_id}} severity>=ERROR`); a `data` body is ' +
      'one SELECT whose `{{name}}` placeholders become bind parameters. `{{org_id}}` and `{{ticket_id}}` ' +
      'are filled from the ticket; any other placeholder is typed in by the person pressing the button. ' +
      'A body that could never run (not a read, `EXTERNAL_QUERY`, a malformed filter) is refused.',
  })
  @ApiCreatedResponse({ standardSchema: toolTemplateSchema })
  @ApiBadRequestResponse({ description: 'Invalid body, an unknown intent, or a body that could never run' })
  @ApiConflictResponse({ description: 'A template of this kind and name exists' })
  async create(
    @Body({ schema: createToolTemplateSchema }) body: CreateToolTemplate,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(toolTemplateSchema, await this.templates.create(body, principal.userId));
  }

  @Patch(':id')
  @RequirePermission('integration.manage')
  @Audited({ action: TOOLS_AUDIT_ACTIONS.toolTemplateUpdate, targetType: 'tool_template' })
  @ApiOperation({ summary: 'Edit a template (head)', description: 'Send only the fields that change. `kind` and `name` never change.' })
  @ApiOkResponse({ standardSchema: toolTemplateSchema })
  @ApiBadRequestResponse({ description: 'Invalid body, or a body that could never run' })
  @ApiNotFoundResponse({ description: 'No such template' })
  async update(
    @Param({ schema: toolTemplateIdParamSchema }) params: ToolTemplateIdParam,
    @Body({ schema: updateToolTemplateSchema }) body: UpdateToolTemplate,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      toolTemplateSchema,
      await this.templates.update(params.id, body, principal.userId),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('integration.manage')
  @Audited({ action: TOOLS_AUDIT_ACTIONS.toolTemplateDelete, targetType: 'tool_template' })
  @ApiOperation({ summary: 'Delete a template (head)', description: 'Cards it produced stay and keep its name.' })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiNotFoundResponse({ description: 'No such template' })
  async remove(
    @Param({ schema: toolTemplateIdParamSchema }) params: ToolTemplateIdParam,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.templates.remove(params.id, principal.userId);
  }
}

/**
 * One click on a ticket (AC-5): the buttons of its intent, running one, and the evidence cards that
 * stay. A client has none of these permissions.
 */
@ApiTags('tools')
@Controller('v1/tickets')
export class TicketToolsController {
  constructor(@Inject(ToolRunner) private readonly runner: ToolRunner) {}

  @Get(':id/tools')
  @RequirePermission('investigate.run')
  @ApiOperation({
    summary: 'The investigation buttons of a ticket',
    description:
      'The active templates of the ticket\'s intent, then the generic ones. `inputParams` are the ' +
      'placeholders the person must give; `connected: false` means the system is not connected here; ' +
      '`mock` means the answer will come from a fake or a sandbox.',
  })
  @ApiOkResponse({ standardSchema: ticketToolsSchema })
  @ApiNotFoundResponse({ description: 'No such ticket' })
  async buttons(
    @Param({ schema: ticketRefParamSchema }) params: TicketParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    const subject = await this.runner.ticketSubject(params.id, principal);
    if (subject.kind !== 'ticket') throw new Error('unreachable');
    AuditScope.set({ targetId: subject.ticketId });
    return parseResponse(ticketToolsSchema, await this.runner.buttons(subject));
  }

  @Post(':id/tools/run')
  @RequirePermission('investigate.run')
  @Audited({ action: TOOLS_AUDIT_ACTIONS.toolRun, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Run a template on a ticket and pin what it found',
    description:
      'Runs the template with the ticket\'s organization (`org_id`, `ticket_id` are filled from the ' +
      'ticket and cannot be given), reads the system through its read-only client, and returns the ' +
      'evidence card: counts, the time range and a few lines with personal data replaced by ' +
      'placeholders. ' +
      BUDGET_NOTE,
  })
  @ApiCreatedResponse({ standardSchema: evidenceCardSchema })
  @ApiBadRequestResponse({ description: 'A missing, unknown or automatic parameter, a value that is not plain text, or another intent\'s template' })
  @ApiNotFoundResponse({ description: 'No such ticket or template' })
  @ApiTooManyRequestsResponse({ description: 'The rate budget is used up for now' })
  @ApiServiceUnavailableResponse({ description: 'That system is not connected on this instance' })
  async run(
    @Param({ schema: ticketRefParamSchema }) params: TicketParam,
    @Body({ schema: runToolSchema }) body: RunTool,
    @CurrentPrincipal() principal: Principal,
  ) {
    const subject = await this.runner.ticketSubject(params.id, principal);
    const card = await this.runner.runTemplate(subject, body, principal);
    return parseResponse(evidenceCardSchema, card);
  }

  @Get(':id/evidence')
  @RequirePermission('ticket.read')
  @ApiOperation({ summary: 'The evidence cards pinned to a ticket, newest first' })
  @ApiOkResponse({ standardSchema: evidenceCardListSchema })
  @ApiNotFoundResponse({ description: 'No such ticket' })
  async evidence(
    @Param({ schema: ticketRefParamSchema }) params: TicketParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    const subject = await this.runner.ticketSubject(params.id, principal);
    return parseResponse(evidenceCardListSchema, { items: await this.runner.listCards(subject) });
  }

  @Delete(':id/evidence/:cardId')
  @HttpCode(204)
  @RequirePermission('investigate.run')
  @Audited({ action: TOOLS_AUDIT_ACTIONS.evidenceDelete, targetType: 'evidence_card' })
  @ApiOperation({ summary: 'Unpin an evidence card from a ticket' })
  @ApiNoContentResponse({ description: 'Removed' })
  @ApiNotFoundResponse({ description: 'No such ticket or card' })
  async unpin(
    @Param({ schema: ticketCardParamSchema }) params: TicketCardParam,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    const subject = await this.runner.ticketSubject(params.id, principal);
    await this.runner.removeCard(subject, params.cardId, principal);
  }
}

/** The same, for an incident (R-5.6): the person gives any parameter the template needs. */
@ApiTags('tools')
@Controller('v1/incidents')
export class IncidentToolsController {
  constructor(@Inject(ToolRunner) private readonly runner: ToolRunner) {}

  @Post(':id/tools/run')
  @RequirePermission('investigate.run')
  @Audited({ action: TOOLS_AUDIT_ACTIONS.toolRun, targetType: 'incident' })
  @ApiOperation({
    summary: 'Run a template for an incident and pin what it found',
    description:
      'An incident has no organization of its own, so every placeholder (`org_id` too) is given in `params`. ' +
      BUDGET_NOTE,
  })
  @ApiCreatedResponse({ standardSchema: evidenceCardSchema })
  @ApiBadRequestResponse({ description: 'A missing, unknown or invalid parameter' })
  @ApiNotFoundResponse({ description: 'No such incident or template' })
  @ApiTooManyRequestsResponse({ description: 'The rate budget is used up for now' })
  @ApiServiceUnavailableResponse({ description: 'That system is not connected on this instance' })
  async run(
    @Param({ schema: incidentParamSchema }) params: IncidentParam,
    @Body({ schema: runToolSchema }) body: RunTool,
    @CurrentPrincipal() principal: Principal,
  ) {
    const subject = await this.runner.incidentSubject(params.id);
    return parseResponse(evidenceCardSchema, await this.runner.runTemplate(subject, body, principal));
  }

  @Get(':id/evidence')
  @RequirePermission('ticket.read')
  @ApiOperation({ summary: 'The evidence cards pinned to an incident, newest first' })
  @ApiOkResponse({ standardSchema: evidenceCardListSchema })
  @ApiNotFoundResponse({ description: 'No such incident' })
  async evidence(@Param({ schema: incidentParamSchema }) params: IncidentParam) {
    const subject = await this.runner.incidentSubject(params.id);
    return parseResponse(evidenceCardListSchema, { items: await this.runner.listCards(subject) });
  }

  @Delete(':id/evidence/:cardId')
  @HttpCode(204)
  @RequirePermission('investigate.run')
  @Audited({ action: TOOLS_AUDIT_ACTIONS.evidenceDelete, targetType: 'evidence_card' })
  @ApiOperation({ summary: 'Unpin an evidence card from an incident' })
  @ApiNoContentResponse({ description: 'Removed' })
  @ApiNotFoundResponse({ description: 'No such incident or card' })
  async unpin(
    @Param({ schema: evidenceCardIdParamSchema }) params: EvidenceCardIdParam,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    const subject = await this.runner.incidentSubject(params.id);
    await this.runner.removeCard(subject, params.cardId, principal);
  }
}

/**
 * A filter or a statement of the person's own (R-5.1, R-5.2). For lead and head only
 * (`investigate.adhoc`): there is no template to bound what is asked, so the guardrails are the
 * connector's (reads only, row cap, timeout, column masking, `EXTERNAL_QUERY` off) and the audit row
 * (who, when, the hash of the statement; never its text or its result).
 */
@ApiTags('tools')
@Controller('v1/investigate/adhoc')
export class AdhocController {
  constructor(@Inject(ToolRunner) private readonly runner: ToolRunner) {}

  @Post('logs')
  @RequirePermission('investigate.adhoc')
  @Audited({ action: TOOLS_AUDIT_ACTIONS.toolAdhoc, targetType: 'evidence_card' })
  @ApiOperation({
    summary: 'Run a log filter of your own and pin the result (lead, head)',
    description:
      'The filter is in the subset the connectors read (`service="x" AND labels.k="v" severity>=ERROR "text"`) ' +
      'and the range is at most 24 hours. Pin it to a ticket (`ticketId`) or an incident (`incidentId`). ' +
      BUDGET_NOTE,
  })
  @ApiCreatedResponse({ standardSchema: evidenceCardSchema })
  @ApiBadRequestResponse({ description: 'A filter the client cannot read, or no ticket or incident to pin to' })
  @ApiTooManyRequestsResponse({ description: 'The rate budget is used up for now' })
  @ApiServiceUnavailableResponse({ description: 'Logs are not connected on this instance' })
  async logs(
    @Body({ schema: adhocLogsSchema }) body: AdhocLogs,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(evidenceCardSchema, await this.runner.runAdhocLogs(body, principal));
  }

  @Post('data')
  @RequirePermission('investigate.adhoc')
  @Audited({ action: TOOLS_AUDIT_ACTIONS.toolAdhoc, targetType: 'evidence_card' })
  @ApiOperation({
    summary: 'Run a SELECT of your own and pin the result (lead, head)',
    description:
      'One SELECT with `$1..$n` bind parameters. Runs in a read-only transaction with a timeout and a row ' +
      'cap; columns that are not on the allow-list come back hidden; `EXTERNAL_QUERY` is refused. ' +
      BUDGET_NOTE,
  })
  @ApiCreatedResponse({ standardSchema: evidenceCardSchema })
  @ApiBadRequestResponse({ description: 'Not a read, a column the login may not read, or no ticket or incident to pin to' })
  @ApiTooManyRequestsResponse({ description: 'The rate budget is used up for now' })
  @ApiServiceUnavailableResponse({ description: 'No product database is connected on this instance' })
  async data(
    @Body({ schema: adhocDataSchema }) body: AdhocData,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(evidenceCardSchema, await this.runner.runAdhocData(body, principal));
  }
}

/** The service status panel of the ops view (R-5.7). */
@ApiTags('tools')
@Controller('v1/ops')
export class OpsController {
  constructor(@Inject(StatusPanel) private readonly panel: StatusPanel) {}

  @Get('services')
  @RequirePermission('dashboard.ops.read')
  @ApiOperation({
    summary: 'Service status panel',
    description:
      'Per active service: alert state, error rate and p95 latency of the last 24 hours (30-minute ' +
      'steps), the last deploy and the open incidents. The numbers are read through the metrics ' +
      'client and cached for a minute; a service the rate budget refused shows `rate_limited` and ' +
      'one the client cannot reach shows `not_connected`, with no numbers (never a guess).',
  })
  @ApiOkResponse({ standardSchema: serviceStatusListSchema })
  async services() {
    return parseResponse(serviceStatusListSchema, await this.panel.list());
  }
}
