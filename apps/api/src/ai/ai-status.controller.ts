import { Controller, Get, Inject } from '@nestjs/common';
import { ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { aiBudgetSchema, aiModelMappingSchema, aiStatusSchema } from '@watchtower/shared';

import { RequireAnyPermission, RequirePermission } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { AiBudgetService } from './ai-budget.service.js';
import { AiModelsService } from './ai-models.service.js';
import { AiStatusService } from './ai-status.service.js';

@ApiTags('ai')
@Controller('v1/ai')
export class AiStatusController {
  constructor(
    @Inject(AiStatusService) private readonly status: AiStatusService,
    @Inject(AiBudgetService) private readonly budget: AiBudgetService,
    @Inject(AiModelsService) private readonly models: AiModelsService,
  ) {}

  @Get('budget')
  @RequirePermission('ai.budget.read')
  @ApiOperation({
    summary: 'Today’s AI spend against the daily caps (lead, head)',
    description:
      'Tokens and USD used today (UTC) against `AI_DAILY_TOKEN_CAP` / `AI_DAILY_COST_CAP_USD`, the ' +
      'alert level, when the day resets, and today’s heaviest assistant users against the per-user ' +
      'token cap. At `stop` the app’s AI runs stop and answers fall back to rules until the reset. ' +
      'The mock provider is free and not counted.',
  })
  @ApiOkResponse({ standardSchema: aiBudgetSchema })
  @ApiForbiddenResponse({ description: 'Needs ai.budget.read' })
  async getBudget() {
    return parseResponse(aiBudgetSchema, await this.budget.read());
  }

  @Get('models')
  @RequirePermission('ai.budget.read')
  @ApiOperation({
    summary: 'Which model each AI agent uses, read-only (lead, head)',
    description:
      'The tier and model of every agent from `AI_MODEL_*` and `AI_AGENT_MODEL_<AGENT>`, where the ' +
      'choice came from, whether the model has a price, and whether the grader runs on a different ' +
      'model than the drafter (ADR-025 condition 7). Changed in the environment, never here.',
  })
  @ApiOkResponse({ standardSchema: aiModelMappingSchema })
  @ApiForbiddenResponse({ description: 'Needs ai.budget.read' })
  getModels() {
    return parseResponse(aiModelMappingSchema, this.models.read());
  }

  @Get('status')
  // Staff and developers see the console banner; a client (no ticket.read) does not (403).
  @RequireAnyPermission('ticket.read', 'ticket.read.masked')
  @ApiOperation({
    summary: 'Whether the AI can be reached (staff)',
    description:
      '`online`, `offline` (the AI host has no internet or its bridge is down: AI jobs wait and ' +
      'retry) or `disabled` (no real AI provider is selected). Cached for a few seconds. It never ' +
      'says where the provider is or how it signs in.',
  })
  @ApiOkResponse({ standardSchema: aiStatusSchema })
  @ApiForbiddenResponse({ description: 'A client cannot see AI internals' })
  async get() {
    return parseResponse(aiStatusSchema, await this.status.status());
  }
}
