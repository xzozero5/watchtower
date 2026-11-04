import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  applyRosterPlanResultSchema,
  applyRosterPlanSchema,
  createRosterPlanSchema,
  editRosterPlanSchema,
  explainRosterPlanSchema,
  idParamSchema,
  rosterPlanDefaultsQuerySchema,
  rosterPlanDefaultsSchema,
  rosterPlanListSchema,
  rosterPlanSchema,
  type ApplyRosterPlan,
  type CreateRosterPlan,
  type EditRosterPlan,
  type ExplainRosterPlan,
  type RosterPlanDefaultsQuery,
} from '@watchtower/shared';
import type { z } from 'zod';

import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { RosterPlanService } from './roster-plan.service.js';

type IdParam = z.infer<typeof idParamSchema>;

/**
 * The roster planner (T-305e, PRD R-7.2), lead and head only (`roster.manage`). The plan is made by a
 * deterministic solver; the AI only explains it. Nothing reaches the roster until a person applies the plan.
 */
@ApiTags('shifts')
@Controller('v1/roster/plans')
export class RosterPlanController {
  constructor(@Inject(RosterPlanService) private readonly plans: RosterPlanService) {}

  @Get()
  @RequirePermission('roster.manage')
  @ApiOperation({ summary: 'Recent roster plans, newest first (at most 30)' })
  @ApiOkResponse({ standardSchema: rosterPlanListSchema })
  async list() {
    return parseResponse(rosterPlanListSchema, await this.plans.list());
  }

  @Get('defaults')
  @RequirePermission('roster.manage')
  @ApiOperation({
    summary: 'What a new plan starts from',
    description:
      'The people who can be rostered with their queues, the active shifts, the default rules, and the coverage ' +
      '(how many people each shift needs) guessed from the tickets of the past 28 days `[ASSUMED]`: a guess, the ' +
      'lead edits it.',
  })
  @ApiOkResponse({ standardSchema: rosterPlanDefaultsSchema })
  async defaults(@Query({ schema: rosterPlanDefaultsQuerySchema }) query: RosterPlanDefaultsQuery) {
    return parseResponse(rosterPlanDefaultsSchema, await this.plans.defaults(query.weekStart));
  }

  @Post()
  @RequirePermission('roster.manage')
  @Audited({ action: AUDIT_ACTIONS.rosterPlanCreate, targetType: 'roster_plan' })
  @ApiOperation({
    summary: 'Make a draft plan for a week',
    description:
      'Runs the deterministic solver (no model decides anything) on the people, leave, coverage and rules. The ' +
      'answer carries the plan and a constraint report: each hard rule, each coverage need and the fairness of ' +
      'nights and weekends, pass or fail with the reason. When no plan can meet the coverage the plan is the best ' +
      'one found and `solver.status` says whether that was proven (`no_solution`) or the search stopped early ' +
      '(`unproven`). Shifts that have started are not planned. Nothing is written to the roster.',
  })
  @ApiCreatedResponse({ standardSchema: rosterPlanSchema })
  @ApiBadRequestResponse({
    description: 'A week that is over, nobody to roster, an unknown shift or queue',
  })
  async create(
    @Body({ schema: createRosterPlanSchema }) body: CreateRosterPlan,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(rosterPlanSchema, await this.plans.create(principal, body));
  }

  @Get(':id')
  @RequirePermission('roster.manage')
  @ApiOperation({
    summary: 'A plan with its constraint report',
    description:
      'The report is computed again on every read against the roster as it is now. `diff` is what applying would ' +
      'do: add, remove (not started, of people in the plan), keep, and the locked ones that stay.',
  })
  @ApiOkResponse({ standardSchema: rosterPlanSchema })
  @ApiNotFoundResponse({ description: 'No such plan' })
  async get(@Param({ schema: idParamSchema }) params: IdParam) {
    return parseResponse(rosterPlanSchema, await this.plans.get(params.id));
  }

  @Patch(':id/entries')
  @RequirePermission('roster.manage')
  @Audited({ action: AUDIT_ACTIONS.rosterPlanEdit, targetType: 'roster_plan' })
  @ApiOperation({
    summary: 'Edit a draft plan by hand',
    description:
      'Adds and removes shifts of the plan and checks it again with the same rules; a rule the edit breaks shows ' +
      'in the report. An explanation written before is cleared. Only a draft can be edited.',
  })
  @ApiOkResponse({ standardSchema: rosterPlanSchema })
  @ApiBadRequestResponse({
    description: 'A shift outside the week, of someone not in the plan, or already started',
  })
  @ApiConflictResponse({ description: 'The plan is not a draft' })
  async edit(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Body({ schema: editRosterPlanSchema }) body: EditRosterPlan,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(rosterPlanSchema, await this.plans.edit(principal, params.id, body));
  }

  @Post(':id/explain')
  @HttpCode(200)
  @RequirePermission('roster.manage')
  @Audited({ action: AUDIT_ACTIONS.rosterPlanExplain, targetType: 'roster_plan' })
  @ApiOperation({
    summary: 'Ask the AI to explain the plan',
    description:
      'The roster_planner agent gets the facts of the plan with people as labels (no names), through redaction and ' +
      'the audited runtime, and writes a short explanation. It cannot change the plan. 503 `ai_unavailable` while ' +
      'the AI is off, offline or over budget: the plan stands without it and can be explained later.',
  })
  @ApiOkResponse({ standardSchema: rosterPlanSchema })
  @ApiResponse({
    status: 502,
    description: 'The answer did not fit the expected form (`ai_unavailable`)',
  })
  @ApiResponse({ status: 503, description: 'The AI is not available (`ai_unavailable`)' })
  async explain(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Body({ schema: explainRosterPlanSchema }) body: ExplainRosterPlan,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(rosterPlanSchema, await this.plans.explain(principal, params.id, body));
  }

  @Post(':id/apply')
  @HttpCode(200)
  @RequirePermission('roster.manage')
  @Audited({ action: AUDIT_ACTIONS.rosterPlanApply, targetType: 'roster_plan' })
  @ApiOperation({
    summary: 'Apply the plan to the roster (a person decides)',
    description:
      'Writes the plan through the roster service, one audit row per shift: shifts of the plan are added, and ' +
      'shifts of people in the plan that have not started and are not in the plan are removed. A shift that has ' +
      'started or has a clock-in is never touched; a plan that holds one is refused. A broken hard rule refuses ' +
      'the plan; fewer people than needed on some shift needs `acceptShortfall`.',
  })
  @ApiOkResponse({ standardSchema: applyRosterPlanResultSchema })
  @ApiConflictResponse({
    description:
      'Not a draft, a planned shift has started, a hard rule is broken, or a shortfall not accepted',
  })
  async apply(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Body({ schema: applyRosterPlanSchema }) body: ApplyRosterPlan,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      applyRosterPlanResultSchema,
      await this.plans.apply(principal, params.id, body),
    );
  }

  @Post(':id/discard')
  @HttpCode(200)
  @RequirePermission('roster.manage')
  @Audited({ action: AUDIT_ACTIONS.rosterPlanDiscard, targetType: 'roster_plan' })
  @ApiOperation({ summary: 'Throw a draft plan away' })
  @ApiOkResponse({ standardSchema: rosterPlanSchema })
  @ApiConflictResponse({ description: 'The plan is not a draft' })
  async discard(
    @Param({ schema: idParamSchema }) params: IdParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(rosterPlanSchema, await this.plans.discard(principal, params.id));
  }
}
