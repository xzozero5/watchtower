import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  aiDraftRefParamSchema,
  aiRequestSchema,
  rejectAiDraftSchema,
  ticketAiInsightSchema,
  ticketRefParamSchema,
  type AiRequest,
  type RejectAiDraft,
} from '@watchtower/shared';
import { z } from 'zod';

import { AuditScope } from '../audit/audit-scope.js';
import {
  Audited,
  AuditPiiRead,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { actorOf } from '../kb/kb-actor.js';
import { TicketAiService } from './ticket-ai.service.js';

type RefParam = z.infer<typeof ticketRefParamSchema>;
type DraftParam = z.infer<typeof aiDraftRefParamSchema>;

const draftIdResponse = z.object({ draftId: z.uuid() });
const acceptedResponse = z.object({ accepted: z.literal(true) });

@ApiTags('ai')
@Controller('v1/tickets')
export class TicketAiController {
  constructor(
    @Inject(TicketAiService) private readonly ai: TicketAiService,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
  ) {}

  @Get(':id/ai')
  // Staff only: `ticket.read` is not held by a client (they have `ticket.read.org`), so a customer
  // gets 403 here and AI internals are never shown to them.
  @RequirePermission('ticket.read')
  // The brief can quote the customer (placeholders restored for staff): reading it is on the audit log.
  @AuditPiiRead('ticket')
  @ApiOperation({
    summary: 'The AI brief of a ticket (staff)',
    description:
      'What the AI made of the ticket: state, one-line summary, intent with confidence, the one ' +
      'next step it suggests, the evidence cards, the investigation report and the draft reply ' +
      'that waits for a person. While the job runs, `progress` says where it is. 404 when the AI ' +
      'has not made a brief for the ticket (or the ticket is not visible to you). In ' +
      '`needs_human` the brief says why in `nextStep.label`. A draft is only returned while it ' +
      'waits for a person; once approved, sent, rejected or replaced it is gone and the state ' +
      'reads `classified`. Not available to a client (403).',
  })
  @ApiOkResponse({ standardSchema: ticketAiInsightSchema })
  @ApiNotFoundResponse({ description: 'No such ticket, or no AI brief for it yet' })
  @ApiForbiddenResponse({ description: 'A client cannot see AI internals' })
  async get(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    const { ticketId, insight } = await this.ai.insightOf(params.id, principal);
    AuditScope.set({ targetId: ticketId });
    return parseResponse(ticketAiInsightSchema, insight);
  }

  @Post(':id/ai/drafts/:draftId/reject')
  @HttpCode(200)
  @RequirePermission('ai.draft.review')
  @ApiOperation({
    summary: 'Reject an AI draft (staff)',
    description:
      'A person discards the draft with one of nine reason codes (`wrong_intent`, ' +
      '`factually_wrong`, `missing_info`, `not_grounded`, `disclosure_risk`, `tone_style`, ' +
      '`wrong_language`, `no_reply_needed`, `other`); a comment is required for `other`. The ' +
      'draft is kept for the learning loop and the brief goes back to "write it yourself". 404 ' +
      'for a ticket or draft you cannot see, 409 when the draft was already approved, sent, ' +
      'rejected or replaced. Approving is the ordinary reply with `aiDraftId`; editing is a reply ' +
      'with `editedFromDraftId`.',
  })
  @ApiOkResponse({ standardSchema: draftIdResponse })
  @ApiNotFoundResponse({ description: 'No such ticket or draft' })
  @ApiConflictResponse({ description: 'The draft was already used' })
  async reject(
    @Param({ schema: aiDraftRefParamSchema }) params: DraftParam,
    @Body({ schema: rejectAiDraftSchema }) body: RejectAiDraft,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await this.uow.run((uow) =>
      this.ai.rejectDraft(uow, params.id, params.draftId, body, principal, actorOf(principal)),
    );
    AuditScope.set({ targetId: result.ticketId });
    return parseResponse(draftIdResponse, { draftId: result.draftId });
  }

  @Post(':id/ai/requests')
  @HttpCode(202)
  @RequirePermission('ticket.handle')
  @Audited({ action: AUDIT_ACTIONS.aiRequest, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Ask the AI for a draft or a new investigation (staff)',
    description:
      '`draft` is "Draft a reply" at stage 1 (and a new draft after a reject); it needs an intent ' +
      'on the ticket at stage 1 or 2. `investigate` runs the tools again. Answers 202 at once: the ' +
      'job runs in the worker and the brief shows `investigating` with `progress` until it ends. ' +
      '409 while a job for the ticket is already running, or when the intent does not allow a ' +
      'draft. The AI never sends anything: a draft waits for a person (N3).',
  })
  @ApiAcceptedResponse({ standardSchema: acceptedResponse })
  @ApiConflictResponse({ description: 'A job is already running, or the intent does not allow a draft' })
  async request(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @Body({ schema: aiRequestSchema }) body: AiRequest,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await this.uow.run((uow) => this.ai.request(uow, params.id, body, principal));
    AuditScope.set({ targetId: result.ticketId });
    return parseResponse(acceptedResponse, { accepted: true as const });
  }
}
