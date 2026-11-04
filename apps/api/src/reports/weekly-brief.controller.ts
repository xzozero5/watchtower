import { Body, Controller, Get, Inject, Param, Post, Put } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  REPORTS_AUDIT_ACTIONS,
  weeklyBriefDraftSchema,
  weeklyBriefEditBodySchema,
  weeklyBriefIdParamSchema,
  weeklyBriefPublishBodySchema,
  weeklyBriefPublishResultSchema,
  weeklyBriefPublishedSchema,
  weeklyBriefSchema,
  type WeeklyBriefEditBody,
  type WeeklyBriefIdParam,
  type WeeklyBriefPublishBody,
} from '@watchtower/shared';

import { AuditScope } from '../audit/audit-scope.js';
import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { WeeklyBriefService } from './weekly-brief.service.js';

/** The AI-drafted weekly brief of the CEO view (T-305c, PRD 9.2): read by lead and head, edited and published by the head. */
@ApiTags('reports')
@Controller('v1/reports/ceo/brief')
export class WeeklyBriefController {
  constructor(@Inject(WeeklyBriefService) private readonly briefs: WeeklyBriefService) {}

  @Get()
  @RequirePermission('ceo.view')
  @ApiOperation({
    summary: 'The newest published weekly brief, or null (lead and up)',
    description:
      'Claims with the evidence behind each (tickets, incidents, figures). A claim with no evidence says so. ' +
      'The figures are the CEO view as it was when the brief was made.',
  })
  @ApiOkResponse({ standardSchema: weeklyBriefPublishedSchema })
  @ApiForbiddenResponse({ description: 'Needs `ceo.view`' })
  async published(@CurrentPrincipal() principal: Principal) {
    return parseResponse(weeklyBriefPublishedSchema, await this.briefs.published(principal));
  }

  @Get('draft')
  @RequirePermission('metric.manage')
  @ApiOperation({
    summary:
      'The newest draft of the weekly brief, with the AI text, and the default recipients (head)',
    description:
      '`aiContent` is what the model wrote and never changes; `content` is what the head has made of it.',
  })
  @ApiOkResponse({ standardSchema: weeklyBriefDraftSchema })
  @ApiForbiddenResponse({ description: 'Needs `metric.manage` (head)' })
  async draft(@CurrentPrincipal() principal: Principal) {
    return parseResponse(weeklyBriefDraftSchema, await this.briefs.draft(principal));
  }

  @Put(':id')
  @RequirePermission('metric.manage')
  @Audited({ action: REPORTS_AUDIT_ACTIONS.briefEdit, targetType: 'weekly_brief' })
  @ApiOperation({
    summary: 'Edit the draft of the weekly brief (head)',
    description:
      'Replaces the words. A claim may keep the evidence the draft had, drop it, or be a sentence with none ' +
      '(shown as uncited); evidence the draft did not have is refused. A published brief cannot be changed.',
  })
  @ApiOkResponse({ standardSchema: weeklyBriefSchema })
  @ApiBadRequestResponse({ description: 'Invalid body, or evidence the draft did not have' })
  @ApiNotFoundResponse({ description: 'No such brief' })
  @ApiConflictResponse({ description: 'Already published' })
  async edit(
    @Param({ schema: weeklyBriefIdParamSchema }) params: WeeklyBriefIdParam,
    @Body({ schema: weeklyBriefEditBodySchema }) body: WeeklyBriefEditBody,
    @CurrentPrincipal() principal: Principal,
  ) {
    AuditScope.set({ targetId: params.id });
    return parseResponse(
      weeklyBriefSchema,
      await this.briefs.edit(params.id, body.content, principal),
    );
  }

  @Post(':id/publish')
  @RequirePermission('metric.manage')
  @Audited({ action: REPORTS_AUDIT_ACTIONS.briefPublish, targetType: 'weekly_brief', always: true })
  @ApiOperation({
    summary: 'Publish the weekly brief and email it (head)',
    description:
      'Shows it on the CEO page and queues one email per recipient through the outbox (queued, not delivered). ' +
      '`recipients` absent: the instance default (`WEEKLY_BRIEF_RECIPIENTS`); an empty list publishes with no email.',
  })
  @ApiCreatedResponse({ standardSchema: weeklyBriefPublishResultSchema })
  @ApiNotFoundResponse({ description: 'No such brief' })
  @ApiConflictResponse({ description: 'Already published' })
  async publish(
    @Param({ schema: weeklyBriefIdParamSchema }) params: WeeklyBriefIdParam,
    @Body({ schema: weeklyBriefPublishBodySchema }) body: WeeklyBriefPublishBody,
    @CurrentPrincipal() principal: Principal,
  ) {
    AuditScope.set({ targetId: params.id });
    const result = await this.briefs.publish(params.id, body.recipients, principal);
    AuditScope.set({
      targetId: params.id,
      metadata: { recipients: result.brief.recipients.length, queued: result.queued },
    });
    return parseResponse(weeklyBriefPublishResultSchema, result);
  }
}
