import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  intentGradeMetricsQuerySchema,
  intentGradeMetricsResponseSchema,
  type IntentGradeMetricsQuery,
} from '@watchtower/shared';

import { RequirePermission } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { AiGradesService } from './ai-grades.service.js';

@ApiTags('ai')
@Controller('v1/ai/grades')
export class AiGradesController {
  constructor(@Inject(AiGradesService) private readonly grades: AiGradesService) {}

  @Get('metrics')
  // [ASSUMED] Lead and up, as the other measurements (usage metrics); a client holds no `metric.read`.
  @RequirePermission('metric.read')
  @ApiOperation({
    summary: 'Grader results per intent (lead and up)',
    description:
      'For each intent, over the last `days` days: how many resolved tickets the grader looked at, ' +
      'how many were verified, contained or assumed, the mean quality of the AI draft against the ' +
      'reply that was sent, policy violations, KB gaps, reopens, CSAT, and what people did with the ' +
      'drafts. Numbers only: it never says an intent is ready for a higher stage.',
  })
  @ApiOkResponse({ standardSchema: intentGradeMetricsResponseSchema })
  @ApiForbiddenResponse({ description: 'Needs `metric.read`' })
  async metrics(@Query({ schema: intentGradeMetricsQuerySchema }) query: IntentGradeMetricsQuery) {
    return parseResponse(intentGradeMetricsResponseSchema, await this.grades.metrics(query.days));
  }
}
