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
  createEscalationPolicySchema,
  createServiceSchema,
  escalationPolicyIdParamSchema,
  escalationPolicyListSchema,
  escalationPolicySchema,
  serviceIdParamSchema,
  serviceListSchema,
  serviceSchema,
  updateEscalationPolicySchema,
  updateServiceSchema,
  type CreateEscalationPolicy,
  type CreateService,
  type EscalationPolicyIdParam,
  type ServiceIdParam,
  type UpdateEscalationPolicy,
  type UpdateService,
} from '@watchtower/shared';

import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { AlertsCatalog } from './catalog.service.js';

/**
 * The service catalog (R-3.7): reading needs `alert.read`, changing it `service.manage`. A service
 * says who owns it, where its runbook is and which alerts are its (`matchRules`).
 */
@ApiTags('alerts')
@Controller('v1/services')
export class ServicesController {
  constructor(@Inject(AlertsCatalog) private readonly catalog: AlertsCatalog) {}

  @Get()
  @RequirePermission('alert.read')
  @ApiOperation({ summary: 'The service catalog, by slug' })
  @ApiOkResponse({ standardSchema: serviceListSchema })
  async list() {
    return parseResponse(serviceListSchema, { items: await this.catalog.listServices() });
  }

  @Get(':id')
  @RequirePermission('alert.read')
  @ApiOperation({ summary: 'One service' })
  @ApiOkResponse({ standardSchema: serviceSchema })
  @ApiNotFoundResponse({ description: 'No such service' })
  async get(@Param({ schema: serviceIdParamSchema }) params: ServiceIdParam) {
    return parseResponse(serviceSchema, await this.catalog.getService(params.id));
  }

  @Post()
  @RequirePermission('service.manage')
  @Audited({ action: ALERTS_AUDIT_ACTIONS.serviceCreate, targetType: 'service' })
  @ApiOperation({
    summary: 'Add a service to the catalog',
    description:
      '`matchRules` map alerts to the service: each rule names a source, a policy name or alertname, ' +
      'and/or labels (only the label keys alerts keep); a rule matches when everything it names holds. ' +
      'Without `escalationPolicyId` the default escalation policy applies.',
  })
  @ApiCreatedResponse({ standardSchema: serviceSchema })
  @ApiBadRequestResponse({
    description: 'Invalid body, or a queue/policy/article that does not exist',
  })
  @ApiConflictResponse({ description: 'The slug is taken' })
  async create(
    @Body({ schema: createServiceSchema }) body: CreateService,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(serviceSchema, await this.catalog.createService(body, principal.userId));
  }

  @Patch(':id')
  @RequirePermission('service.manage')
  @Audited({ action: ALERTS_AUDIT_ACTIONS.serviceUpdate, targetType: 'service' })
  @ApiOperation({ summary: 'Edit a service', description: 'Send only the fields that change.' })
  @ApiOkResponse({ standardSchema: serviceSchema })
  @ApiBadRequestResponse({
    description: 'Invalid body, or a queue/policy/article that does not exist',
  })
  @ApiNotFoundResponse({ description: 'No such service' })
  @ApiConflictResponse({ description: 'The slug is taken' })
  async update(
    @Param({ schema: serviceIdParamSchema }) params: ServiceIdParam,
    @Body({ schema: updateServiceSchema }) body: UpdateService,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      serviceSchema,
      await this.catalog.updateService(params.id, body, principal.userId),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('service.manage')
  @Audited({ action: ALERTS_AUDIT_ACTIONS.serviceDelete, targetType: 'service' })
  @ApiOperation({
    summary: 'Remove a service',
    description: 'Its alerts stay and become unmapped.',
  })
  @ApiNoContentResponse({ description: 'Removed' })
  @ApiNotFoundResponse({ description: 'No such service' })
  async remove(
    @Param({ schema: serviceIdParamSchema }) params: ServiceIdParam,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.catalog.deleteService(params.id, principal.userId);
  }
}

/**
 * Escalation policies (R-3.8): who is told, and after how long. Reading needs `alert.read`, changing
 * them `alert.manage`. The sweep that follows the steps is T-201d.
 */
@ApiTags('alerts')
@Controller('v1/escalation-policies')
export class EscalationPoliciesController {
  constructor(@Inject(AlertsCatalog) private readonly catalog: AlertsCatalog) {}

  @Get()
  @RequirePermission('alert.read')
  @ApiOperation({ summary: 'Escalation policies; exactly one is the default' })
  @ApiOkResponse({ standardSchema: escalationPolicyListSchema })
  async list() {
    return parseResponse(escalationPolicyListSchema, { items: await this.catalog.listPolicies() });
  }

  @Post()
  @RequirePermission('alert.manage')
  @Audited({ action: ALERTS_AUDIT_ACTIONS.escalationPolicyCreate, targetType: 'escalation_policy' })
  @ApiOperation({
    summary: 'Add an escalation policy',
    description:
      '`steps` are `{ target: "on_shift" | "lead" | "head", afterSeconds }`: the first at 0, the ' +
      'rest in strictly increasing time order, at most 5.',
  })
  @ApiCreatedResponse({ standardSchema: escalationPolicySchema })
  @ApiBadRequestResponse({ description: 'Invalid steps' })
  @ApiConflictResponse({ description: 'The name is taken' })
  async create(
    @Body({ schema: createEscalationPolicySchema }) body: CreateEscalationPolicy,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      escalationPolicySchema,
      await this.catalog.createPolicy(body, principal.userId),
    );
  }

  @Patch(':id')
  @RequirePermission('alert.manage')
  @Audited({ action: ALERTS_AUDIT_ACTIONS.escalationPolicyUpdate, targetType: 'escalation_policy' })
  @ApiOperation({ summary: 'Edit an escalation policy' })
  @ApiOkResponse({ standardSchema: escalationPolicySchema })
  @ApiBadRequestResponse({ description: 'Invalid steps' })
  @ApiNotFoundResponse({ description: 'No such policy' })
  @ApiConflictResponse({ description: 'The name is taken' })
  async update(
    @Param({ schema: escalationPolicyIdParamSchema }) params: EscalationPolicyIdParam,
    @Body({ schema: updateEscalationPolicySchema }) body: UpdateEscalationPolicy,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      escalationPolicySchema,
      await this.catalog.updatePolicy(params.id, body, principal.userId),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('alert.manage')
  @Audited({ action: ALERTS_AUDIT_ACTIONS.escalationPolicyDelete, targetType: 'escalation_policy' })
  @ApiOperation({
    summary: 'Remove an escalation policy',
    description: 'Its services fall back to the default policy. The default one cannot be removed.',
  })
  @ApiNoContentResponse({ description: 'Removed' })
  @ApiNotFoundResponse({ description: 'No such policy' })
  @ApiConflictResponse({ description: 'The default policy cannot be removed' })
  async remove(
    @Param({ schema: escalationPolicyIdParamSchema }) params: EscalationPolicyIdParam,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.catalog.deletePolicy(params.id, principal.userId);
  }
}
