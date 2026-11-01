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
  ALERTS_AUDIT_ACTIONS,
  correlationRuleIdParamSchema,
  correlationRuleListSchema,
  correlationRuleSchema,
  createCorrelationRuleSchema,
  createHeartbeatSchema,
  heartbeatIdParamSchema,
  heartbeatListSchema,
  heartbeatSchema,
  updateCorrelationRuleSchema,
  updateHeartbeatSchema,
  type CorrelationRuleIdParam,
  type CreateCorrelationRule,
  type CreateHeartbeat,
  type HeartbeatIdParam,
  type UpdateCorrelationRule,
  type UpdateHeartbeat,
} from '@watchtower/shared';

import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { AlertsHygiene } from './hygiene.service.js';

/**
 * Heartbeats (R-3.10): expected periodic signals. Reading needs `alert.read`, changing them
 * `alert.manage`. The signal itself arrives at `POST /v1/inbound/heartbeats/:slug`.
 */
@ApiTags('alerts')
@Controller('v1/heartbeats')
export class HeartbeatsController {
  constructor(@Inject(AlertsHygiene) private readonly hygiene: AlertsHygiene) {}

  @Get()
  @RequirePermission('alert.read')
  @ApiOperation({ summary: 'Heartbeats and whether each is heard from' })
  @ApiOkResponse({ standardSchema: heartbeatListSchema })
  async list() {
    return parseResponse(heartbeatListSchema, { items: await this.hygiene.listHeartbeats() });
  }

  @Post()
  @RequirePermission('alert.manage')
  @Audited({ action: ALERTS_AUDIT_ACTIONS.heartbeatCreate, targetType: 'heartbeat' })
  @ApiOperation({
    summary: 'Add a heartbeat',
    description:
      'If nothing is heard for `expectedIntervalSeconds + graceSeconds` (database clock; a heartbeat ' +
      'never heard counts from its creation) an alert of source `heartbeat` opens and follows the ' +
      "escalation policy of the heartbeat's service. The next signal resolves it.",
  })
  @ApiCreatedResponse({ standardSchema: heartbeatSchema })
  @ApiBadRequestResponse({ description: 'Invalid body, or no such service' })
  @ApiConflictResponse({ description: 'The slug is taken' })
  async create(
    @Body({ schema: createHeartbeatSchema }) body: CreateHeartbeat,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      heartbeatSchema,
      await this.hygiene.createHeartbeat(body, principal.userId),
    );
  }

  @Patch(':id')
  @RequirePermission('alert.manage')
  @Audited({ action: ALERTS_AUDIT_ACTIONS.heartbeatUpdate, targetType: 'heartbeat' })
  @ApiOperation({ summary: 'Edit a heartbeat' })
  @ApiOkResponse({ standardSchema: heartbeatSchema })
  @ApiBadRequestResponse({ description: 'Invalid body, or no such service' })
  @ApiNotFoundResponse({ description: 'No such heartbeat' })
  @ApiConflictResponse({ description: 'The slug is taken' })
  async update(
    @Param({ schema: heartbeatIdParamSchema }) params: HeartbeatIdParam,
    @Body({ schema: updateHeartbeatSchema }) body: UpdateHeartbeat,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      heartbeatSchema,
      await this.hygiene.updateHeartbeat(params.id, body, principal.userId),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('alert.manage')
  @Audited({ action: ALERTS_AUDIT_ACTIONS.heartbeatDelete, targetType: 'heartbeat' })
  @ApiOperation({ summary: 'Remove a heartbeat', description: 'An alert it already raised stays.' })
  @ApiNoContentResponse({ description: 'Removed' })
  @ApiNotFoundResponse({ description: 'No such heartbeat' })
  async remove(
    @Param({ schema: heartbeatIdParamSchema }) params: HeartbeatIdParam,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.hygiene.deleteHeartbeat(params.id, principal.userId);
  }
}

/**
 * Correlation rules (R-3.6): which alerts count as related. Reading needs `alert.read`, changing them
 * `alert.manage`. A group is a proposal for an incident, never an incident by itself.
 */
@ApiTags('alerts')
@Controller('v1/correlation-rules')
export class CorrelationRulesController {
  constructor(@Inject(AlertsHygiene) private readonly hygiene: AlertsHygiene) {}

  @Get()
  @RequirePermission('alert.read')
  @ApiOperation({ summary: 'Correlation rules' })
  @ApiOkResponse({ standardSchema: correlationRuleListSchema })
  async list() {
    return parseResponse(correlationRuleListSchema, { items: await this.hygiene.listRules() });
  }

  @Post()
  @RequirePermission('alert.manage')
  @Audited({ action: ALERTS_AUDIT_ACTIONS.correlationRuleCreate, targetType: 'correlation_rule' })
  @ApiOperation({
    summary: 'Add a correlation rule',
    description:
      '`same_service`: when `minAlerts` alerts of one service are open and opened within ' +
      '`windowMinutes` of each other, they share a `correlationId`. Applies to alerts that open from now on.',
  })
  @ApiCreatedResponse({ standardSchema: correlationRuleSchema })
  @ApiBadRequestResponse({ description: 'Invalid body' })
  @ApiConflictResponse({ description: 'The name is taken' })
  async create(
    @Body({ schema: createCorrelationRuleSchema }) body: CreateCorrelationRule,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      correlationRuleSchema,
      await this.hygiene.createRule(body, principal.userId),
    );
  }

  @Patch(':id')
  @RequirePermission('alert.manage')
  @Audited({ action: ALERTS_AUDIT_ACTIONS.correlationRuleUpdate, targetType: 'correlation_rule' })
  @ApiOperation({ summary: 'Edit a correlation rule' })
  @ApiOkResponse({ standardSchema: correlationRuleSchema })
  @ApiBadRequestResponse({ description: 'Invalid body' })
  @ApiNotFoundResponse({ description: 'No such rule' })
  @ApiConflictResponse({ description: 'The name is taken' })
  async update(
    @Param({ schema: correlationRuleIdParamSchema }) params: CorrelationRuleIdParam,
    @Body({ schema: updateCorrelationRuleSchema }) body: UpdateCorrelationRule,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      correlationRuleSchema,
      await this.hygiene.updateRule(params.id, body, principal.userId),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('alert.manage')
  @Audited({ action: ALERTS_AUDIT_ACTIONS.correlationRuleDelete, targetType: 'correlation_rule' })
  @ApiOperation({
    summary: 'Remove a correlation rule',
    description: 'Groups already formed stay.',
  })
  @ApiNoContentResponse({ description: 'Removed' })
  @ApiNotFoundResponse({ description: 'No such rule' })
  async remove(
    @Param({ schema: correlationRuleIdParamSchema }) params: CorrelationRuleIdParam,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.hygiene.deleteRule(params.id, principal.userId);
  }
}
