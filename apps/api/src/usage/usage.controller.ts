import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
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
  anomalyListSchema,
  anomalyQuerySchema,
  createMetricSchema,
  healthListQuerySchema,
  healthListSchema,
  metricIdParamSchema,
  metricListSchema,
  metricPointsSchema,
  metricSchema,
  orgHealthSchema,
  orgIdParamSchema,
  pointsQuerySchema,
  updateMetricSchema,
  type CreateMetric,
  type MetricIdParam,
  type PointsQuery,
  type UpdateMetric,
} from '@watchtower/shared';
import { z } from 'zod';

import { CurrentPrincipal, RequirePermission, type Principal } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { UsageService } from './usage.service.js';

const userOf = (principal: Principal) => ({ type: 'user', id: principal.userId }) as const;
const orgParamSchema = orgIdParamSchema;
const limitQuerySchema = anomalyQuerySchema;

/**
 * Product usage metrics (R-8.1, R-8.2). Reading needs `metric.read` (lead and up); **creating or changing a
 * metric needs `metric.manage` (head only)**, because a template is SQL against product data. The SQL text
 * is shown only to a caller who may manage metrics. A client holds none of these permissions.
 */
@ApiTags('usage')
@Controller('v1/usage')
export class UsageController {
  constructor(@Inject(UsageService) private readonly service: UsageService) {}

  @Get('metrics')
  @RequirePermission('metric.read')
  @ApiOperation({
    summary: 'List metric definitions',
    description: 'The SQL template is included for a head only.',
  })
  @ApiOkResponse({ standardSchema: metricListSchema })
  async list(@CurrentPrincipal() principal: Principal) {
    return parseResponse(metricListSchema, {
      items: await this.service.listMetrics(principal.permissions.has('metric.manage')),
    });
  }

  @Get('metrics/:id')
  @RequirePermission('metric.read')
  @ApiOperation({ summary: 'One metric definition and how its last run went' })
  @ApiOkResponse({ standardSchema: metricSchema })
  @ApiNotFoundResponse({ description: 'No such metric' })
  async get(
    @Param({ schema: metricIdParamSchema }) params: MetricIdParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      metricSchema,
      await this.service.getMetric(params.id, principal.permissions.has('metric.manage')),
    );
  }

  @Post('metrics')
  @RequirePermission('metric.manage')
  @ApiOperation({
    summary: 'Define a metric',
    description:
      'A read-only SQL template with the window bound as $1 (from) and $2 (to), the dimensions it may ' +
      'return and the anomaly rule. The template is checked for its shape here and again by the data ' +
      'client that runs it. Audited with the hash of the template.',
  })
  @ApiCreatedResponse({ standardSchema: metricSchema })
  @ApiConflictResponse({ description: 'The key is taken' })
  @ApiForbiddenResponse({ description: 'Only a head defines metrics' })
  async create(
    @Body({ schema: createMetricSchema }) body: CreateMetric,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(metricSchema, await this.service.createMetric(userOf(principal), body));
  }

  @Patch('metrics/:id')
  @RequirePermission('metric.manage')
  @ApiOperation({
    summary: 'Change a metric',
    description:
      'A new template makes a new version and is audited as `usage_metric.template_edit` with the ' +
      'SHA-256 of the old and the new text; the next run reads the whole backfill window again.',
  })
  @ApiOkResponse({ standardSchema: metricSchema })
  @ApiNotFoundResponse({ description: 'No such metric' })
  async update(
    @Param({ schema: metricIdParamSchema }) params: MetricIdParam,
    @Body({ schema: updateMetricSchema }) body: UpdateMetric,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      metricSchema,
      await this.service.updateMetric(userOf(principal), params.id, body),
    );
  }

  @Get('metrics/:id/points')
  @RequirePermission('metric.read')
  @ApiOperation({
    summary: 'Cached hourly points of a metric, newest first',
    description: "Read from Watchtower's own database; this route never reaches the product data.",
  })
  @ApiOkResponse({ standardSchema: metricPointsSchema })
  async points(
    @Param({ schema: metricIdParamSchema }) params: MetricIdParam,
    @Query({ schema: pointsQuerySchema }) query: PointsQuery,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(metricPointsSchema, {
      items: await this.service.points(params.id, query, principal.orgScope),
    });
  }

  @Get('anomalies')
  @RequirePermission('metric.read')
  @ApiOperation({ summary: 'Anomalies the rule found, newest first' })
  @ApiOkResponse({ standardSchema: anomalyListSchema })
  async anomalies(
    @Query({ schema: limitQuerySchema }) query: z.infer<typeof limitQuerySchema>,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(anomalyListSchema, {
      items: await this.service.anomalies(query.limit, principal.orgScope),
    });
  }
}

/**
 * The Client Health Score (R-8.4). Needs `org.health.read` (lead and up): a customer, whose role has no
 * `org.health.read`, sees no route here. A score says something about its own organization only; the list
 * is sorted by it but carries no rank, average or percentile.
 */
@ApiTags('usage')
@Controller('v1')
export class OrgHealthController {
  constructor(@Inject(UsageService) private readonly service: UsageService) {}

  @Get('orgs/:id/health')
  @RequirePermission('org.health.read')
  @ApiOperation({
    summary: 'The latest Health Score of an organization',
    description:
      '`snapshot` is null until one was computed. `status` is `insufficient_data` (and `score` null) when ' +
      'the organization has not been observed long enough: a score is never invented. Each component says ' +
      'whether it had data. The weights are assumed (formula version 1).',
  })
  @ApiOkResponse({ standardSchema: orgHealthSchema })
  async orgHealth(
    @Param({ schema: orgParamSchema }) params: z.infer<typeof orgParamSchema>,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(orgHealthSchema, {
      snapshot: await this.service.orgHealth(params.id, principal.orgScope),
    });
  }

  @Get('health/orgs')
  @RequirePermission('org.health.read')
  @ApiOperation({
    summary: 'Organizations by Health Score, lowest first',
    description: 'The latest snapshot of each organization; those without a score come last.',
  })
  @ApiOkResponse({ standardSchema: healthListSchema })
  async list(
    @Query({ schema: healthListQuerySchema }) query: z.infer<typeof healthListQuerySchema>,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(healthListSchema, {
      items: await this.service.healthList(query.limit, principal.orgScope),
    });
  }
}
