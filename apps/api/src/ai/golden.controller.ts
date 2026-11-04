import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
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
  AUDIT_ACTIONS,
  goldenAnswerListSchema,
  goldenAnswerSchema,
  goldenIdParamSchema,
  goldenListQuerySchema,
  markGoldenSchema,
  ticketGradeResponseSchema,
  ticketRefParamSchema,
  type GoldenListQuery,
  type MarkGolden,
} from '@watchtower/shared';
import { z } from 'zod';

import { AuditScope } from '../audit/audit-scope.js';
import {
  Audited,
  AuditPiiRead,
  CurrentPrincipal,
  RequireAnyPermission,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { GoldenService } from './golden.service.js';

type RefParam = z.infer<typeof ticketRefParamSchema>;
type IdParam = z.infer<typeof goldenIdParamSchema>;

const removedResponse = z.object({ id: z.uuid() });

/**
 * The grader's verdict on a ticket (T-301d) and golden answers (T-302a). A golden answer is a sent reply a
 * lead or head keeps as an example for the drafter; it is stored redacted and removed by soft delete.
 */
@ApiTags('ai')
@Controller('v1')
export class GoldenController {
  constructor(@Inject(GoldenService) private readonly golden: GoldenService) {}

  @Get('tickets/:id/ai/grade')
  // Staff and developers, as the AI brief: a client holds neither permission. A developer gets the text redacted.
  @RequireAnyPermission('ticket.read', 'ticket.read.masked')
  @AuditPiiRead('ticket')
  @ApiOperation({
    summary: 'The grader result of a resolved ticket (staff)',
    description:
      'How the latest resolution of the ticket was graded: verified, contained or assumed, with the ' +
      'reasons as claims that cite their evidence, the quality of the AI draft against the reply that ' +
      'was sent, policy violations and whether the ticket shows a knowledge-base gap. `grade` is null ' +
      'while the grader has not looked at the ticket. A developer reads it redacted. Not available to a client (403).',
  })
  @ApiOkResponse({ standardSchema: ticketGradeResponseSchema })
  @ApiNotFoundResponse({ description: 'No such ticket' })
  @ApiForbiddenResponse({ description: 'A client cannot see AI internals' })
  async grade(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    const { ticketId, grade } = await this.golden.gradeOf(params.id, principal);
    AuditScope.set({ targetId: ticketId });
    return parseResponse(ticketGradeResponseSchema, { grade });
  }

  @Get('tickets/:id/golden')
  @RequirePermission('ai.golden.manage')
  @ApiOperation({
    summary: 'Golden answers kept from a ticket (lead and head)',
    description:
      'Which replies of the ticket are marked, so the console can show the mark. Redacted text.',
  })
  @ApiOkResponse({ standardSchema: goldenAnswerListSchema })
  @ApiNotFoundResponse({ description: 'No such ticket' })
  async ofTicket(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    const { items } = await this.golden.ofTicket(params.id, principal);
    return parseResponse(goldenAnswerListSchema, { items });
  }

  @Post('tickets/:id/golden')
  @HttpCode(201)
  @RequirePermission('ai.golden.manage')
  @Audited({ action: AUDIT_ACTIONS.aiGoldenMark, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Mark a sent reply as a golden answer (lead and head)',
    description:
      'Keeps the reply, redacted with the same redactor that runs before the LLM, as an example for the ' +
      'drafter of the ticket intent. The original text is not copied. 400 for a message that is not a ' +
      'reply sent to the customer, or text that cannot be redacted safely; 409 when the ticket has no ' +
      'intent or the reply is already marked.',
  })
  @ApiCreatedResponse({ standardSchema: goldenAnswerSchema })
  @ApiBadRequestResponse({ description: 'Not a sent reply, or it cannot be redacted safely' })
  @ApiConflictResponse({ description: 'No intent on the ticket, or already marked' })
  @ApiNotFoundResponse({ description: 'No such ticket or message' })
  async mark(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @Body({ schema: markGoldenSchema }) body: MarkGolden,
    @CurrentPrincipal() principal: Principal,
  ) {
    const { ticketId, golden } = await this.golden.mark(
      params.id,
      body.messageId,
      principal,
      body.shareable === true,
    );
    AuditScope.set({
      targetId: ticketId,
      metadata: {
        goldenId: golden.id,
        messageId: golden.messageId,
        intent: golden.intent.key,
        shareable: body.shareable === true,
      },
    });
    return parseResponse(goldenAnswerSchema, golden);
  }

  @Get('ai/golden')
  @RequirePermission('ai.golden.manage')
  @ApiOperation({
    summary: 'Golden answers (lead and head)',
    description: 'Every live golden answer, newest first, optionally of one intent. Redacted text.',
  })
  @ApiOkResponse({ standardSchema: goldenAnswerListSchema })
  async list(@Query({ schema: goldenListQuerySchema }) query: GoldenListQuery) {
    return parseResponse(goldenAnswerListSchema, {
      items: await this.golden.list({
        limit: query.limit,
        ...(query.intent === undefined ? {} : { intentKey: query.intent }),
      }),
    });
  }

  @Delete('ai/golden/:id')
  @HttpCode(200)
  @RequirePermission('ai.golden.manage')
  @Audited({ action: AUDIT_ACTIONS.aiGoldenDelete, targetType: 'golden_answer' })
  @ApiOperation({
    summary: 'Remove a golden answer (lead and head)',
    description: 'Soft delete: the drafter stops using it; the row stays for the audit trail.',
  })
  @ApiOkResponse({ standardSchema: removedResponse })
  @ApiNotFoundResponse({ description: 'No such golden answer' })
  async remove(
    @Param({ schema: goldenIdParamSchema }) params: IdParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    const removed = await this.golden.remove(params.id, principal);
    AuditScope.set({ targetId: removed.id, metadata: { ticketId: removed.ticketId } });
    return parseResponse(removedResponse, { id: removed.id });
  }
}
