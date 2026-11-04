import { Controller, Get, Inject } from '@nestjs/common';
import { ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { aiStatusSchema } from '@watchtower/shared';

import { RequireAnyPermission } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { AiStatusService } from './ai-status.service.js';

@ApiTags('ai')
@Controller('v1/ai')
export class AiStatusController {
  constructor(@Inject(AiStatusService) private readonly status: AiStatusService) {}

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
