import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import {
  insightsQuerySchema,
  insightsResponseSchema,
  type InsightsQuery,
} from '@watchtower/shared';
import type { Request, Response } from 'express';

import {
  CurrentPrincipal,
  RequirePermission,
  WorkspaceOnly,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { InsightsService } from './insights.service.js';

/**
 * Embedded insights (T-416, ADR-029 section 9). Workspace people only: `@WorkspaceOnly()` makes the guard refuse a
 * client or a system identity with 403 before it looks at permissions. Then `assistant.use`; what each element
 * shows is narrower still (the rule of its GET route and the scope resolver, per element).
 */
@ApiTags('insights')
@WorkspaceOnly()
@Controller('v1/insights')
export class InsightsController {
  constructor(@Inject(InsightsService) private readonly insights: InsightsService) {}

  @Get()
  @RequirePermission('assistant.use')
  @ApiOperation({
    summary: 'AI insights embedded in screen elements',
    description:
      'For each element in `elements` (at most 12): the facts computed live, the sentences made from them by ' +
      'template in `locale`, and the stored AI narration when its `state` allows it (`system`, `paused`, `fresh`, ' +
      '`stale`, `budget`, `none`). An element the person may not read (the rule of its GET route, the scope, or the ' +
      'period) is left out, and so is one with no data: the two cannot be told apart. Reading makes no model call ' +
      'and creates no `ai_run`; it leaves a viewed mark and, when the narration is missing or out of date, a dirty ' +
      'mark in Redis for the worker. Rate limited per person (60 a minute).',
  })
  @ApiOkResponse({ standardSchema: insightsResponseSchema })
  @ApiForbiddenResponse({ description: 'A client or a system identity, or no `assistant.use`' })
  @ApiTooManyRequestsResponse({ description: 'More than 60 requests in a minute' })
  async read(
    @Query({ schema: insightsQuerySchema }) query: InsightsQuery,
    @CurrentPrincipal() principal: Principal,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const requestId = response.getHeader('x-request-id');
    return parseResponse(
      insightsResponseSchema,
      await this.insights.read(principal, query, {
        ip: request.ip ?? null,
        requestId: typeof requestId === 'string' ? requestId : null,
      }),
    );
  }
}
