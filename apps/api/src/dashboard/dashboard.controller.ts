import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { dashboardOpsSchema, dashboardQuerySchema, type DashboardQuery } from '@watchtower/shared';

import { CurrentPrincipal, RequirePermission, type Principal } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { DashboardService } from './dashboard.service.js';

/** The ops dashboard (PRD 9.1). Read only: it changes nothing, so there is nothing to audit. */
@ApiTags('dashboard')
@Controller('v1/dashboard')
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly service: DashboardService) {}

  @Get('ops')
  @RequirePermission('dashboard.ops.read')
  @ApiOperation({
    summary: 'Ops dashboard: queue and SLA health, reliability, quality, AI, team, usage',
    description:
      'Aggregates over the last `days` UTC days (today included), cached for 30 seconds. Every figure is ' +
      '`{ status: "ok", data }`, `{ status: "not_available", reason }` (nothing to compute from, or it waits ' +
      'for the Phase 3 grader: never a zero) or `{ status: "restricted", requires }` (the role lacks the ' +
      'permission). An agent sees the queue, SLA, reliability and service panel; CSAT, AI, per-agent, usage ' +
      'and Health Score need `csat.read`, `ai.run.read`, `performance.read.all`, `metric.read` and ' +
      '`org.health.read`. Durations are wall clock seconds.',
  })
  @ApiOkResponse({ standardSchema: dashboardOpsSchema })
  @ApiForbiddenResponse({
    description: 'The role has no `dashboard.ops.read` (a customer never has it)',
  })
  async ops(
    @Query({ schema: dashboardQuerySchema }) query: DashboardQuery,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(dashboardOpsSchema, await this.service.ops(query.days, principal));
  }
}
