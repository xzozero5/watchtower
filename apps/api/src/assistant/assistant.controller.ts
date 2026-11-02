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
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  assistantMessageRequestSchema,
  assistantReplySchema,
  assistantStartersQuerySchema,
  assistantStartersSchema,
  confirmProposalResponseSchema,
  conversationParamSchema,
  deleteConversationResponseSchema,
  proposalParamSchema,
  rejectProposalResponseSchema,
  type AssistantMessageRequest,
  type AssistantStartersQuery,
  type ConversationParam,
  type ProposalParam,
} from '@watchtower/shared';

import {
  Audited,
  CurrentPrincipal,
  RequireAnyPermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { forbidden } from '../auth/http-errors.js';
import { canUseAssistant } from './assistant-access.js';
import { AssistantProposals } from './assistant-proposals.js';
import { AssistantService } from './assistant.service.js';

/**
 * The door of every route. The permission decorator is `ticket.read` or `auth.session.self` (everyone who
 * signs in), and this is the real question: may the person read tickets, whole (`ticket.read`) or masked
 * (`ticket.read.masked`, the developer of T-137)? A customer holds neither and gets 403. The masked
 * permission is not named in the decorator because it does not exist on every branch yet.
 */
function assertCanUse(principal: Principal): void {
  if (!canUseAssistant(principal)) throw forbidden();
}

/**
 * The AI assistant (T-134, ADR-017). Staff only: `ticket.read` is not held by a client, so a client
 * gets 403 (po #34: the customer has no bubble, because an AI that answers a customer is N3's
 * business). What the assistant may do for a person is narrower than the route: the role and the
 * permissions behind each tool and each proposal decide, and a write only runs when that same person
 * presses a proposal.
 */
@ApiTags('assistant')
@Controller('v1/assistant')
export class AssistantController {
  constructor(
    @Inject(AssistantService) private readonly assistant: AssistantService,
    @Inject(AssistantProposals) private readonly proposals: AssistantProposals,
  ) {}

  @Get('starters')
  @RequireAnyPermission('ticket.read', 'auth.session.self')
  @ApiOperation({
    summary: 'State of the assistant and up to three starter prompts for this person',
    description:
      '`state` is `ok`, `paused` (the kill switch is on), `budget` (the day or the person is used up) ' +
      'or `unavailable` (no provider is wired); the web closes the input in the last three. Starters ' +
      'depend on the role and permissions, and prompts about "this" ticket appear only when `ticket` ' +
      'is given and the person may open it. Makes no model call and writes nothing.',
  })
  @ApiOkResponse({ standardSchema: assistantStartersSchema })
  @ApiForbiddenResponse({ description: 'A client has no assistant' })
  async starters(
    @Query({ schema: assistantStartersQuerySchema }) query: AssistantStartersQuery,
    @CurrentPrincipal() principal: Principal,
  ) {
    assertCanUse(principal);
    return parseResponse(assistantStartersSchema, await this.assistant.starters(principal, query));
  }

  @Post('messages')
  @HttpCode(200)
  @RequireAnyPermission('ticket.read', 'auth.session.self')
  @Audited({ action: AUDIT_ACTIONS.assistantMessage, targetType: 'assistant_conversation' })
  @ApiOperation({
    summary: 'Ask the assistant',
    description:
      'Answers with `claims` (each sentence with the pages that support it; one with no evidence is ' +
      '`uncited`), the `tools` it used, and `proposals`: cards for changes it suggests, each ' +
      'made of server values. A proposal does nothing until the same person confirms it. ' +
      '`context` carries the chips (page, ticket); a ticket the person cannot open is a 404. ' +
      'Replies to a customer are never written here: `reply_draft` asks for a draft that waits in ' +
      'the usual review. 200 with `state` other than `ok` when the AI is paused, over budget or not ' +
      'wired; 429 when the person sends too many messages in an hour.',
  })
  @ApiOkResponse({ standardSchema: assistantReplySchema })
  @ApiNotFoundResponse({ description: 'The conversation or the ticket in `context` is not yours' })
  @ApiTooManyRequestsResponse({ description: 'Too many messages in this hour' })
  async message(
    @Body({ schema: assistantMessageRequestSchema }) body: AssistantMessageRequest,
    @CurrentPrincipal() principal: Principal,
  ) {
    assertCanUse(principal);
    return parseResponse(assistantReplySchema, await this.assistant.message(principal, body));
  }

  @Post('proposals/:id/confirm')
  @HttpCode(200)
  @RequireAnyPermission('ticket.read', 'auth.session.self')
  @Audited({ action: AUDIT_ACTIONS.assistantProposalConfirm, targetType: 'assistant_proposal' })
  @ApiOperation({
    summary: 'Press a proposal',
    description:
      'Runs the change with the permissions of the person who presses, through the same service as ' +
      'the ordinary route, in one transaction with its audit row (`via: assistant`). Only the owner ' +
      'of the proposal can press it (anyone else: 404); it can be used once (409), expires after ten ' +
      'minutes (409), and is checked against the permission again. If the ticket changed after the ' +
      'card was made nothing runs: the answer is `outcome: stale` with the card showing the current ' +
      'values and status `expired`.',
  })
  @ApiOkResponse({ standardSchema: confirmProposalResponseSchema })
  @ApiNotFoundResponse({ description: 'No such proposal (or it is not yours)' })
  @ApiConflictResponse({ description: 'Already used, closed or expired' })
  @ApiForbiddenResponse({ description: 'You no longer hold the permission' })
  async confirm(
    @Param({ schema: proposalParamSchema }) params: ProposalParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    assertCanUse(principal);
    return parseResponse(
      confirmProposalResponseSchema,
      await this.proposals.confirm(principal, params.id),
    );
  }

  @Post('proposals/:id/reject')
  @HttpCode(200)
  @RequireAnyPermission('ticket.read', 'auth.session.self')
  @Audited({ action: AUDIT_ACTIONS.assistantProposalReject, targetType: 'assistant_proposal' })
  @ApiOperation({ summary: 'Decline a proposal', description: 'Closes it; nothing runs.' })
  @ApiOkResponse({ standardSchema: rejectProposalResponseSchema })
  @ApiNotFoundResponse({ description: 'No such proposal (or it is not yours)' })
  @ApiConflictResponse({ description: 'Already used, closed or expired' })
  async reject(
    @Param({ schema: proposalParamSchema }) params: ProposalParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    assertCanUse(principal);
    return parseResponse(
      rejectProposalResponseSchema,
      await this.proposals.reject(principal, params.id),
    );
  }

  @Delete('conversations/:id')
  @HttpCode(200)
  @RequireAnyPermission('ticket.read', 'auth.session.self')
  @Audited({
    action: AUDIT_ACTIONS.assistantConversationDelete,
    targetType: 'assistant_conversation',
  })
  @ApiOperation({
    summary: 'Delete a conversation of your own',
    description: 'With its messages and proposals. The audit log of what was pressed stays.',
  })
  @ApiOkResponse({ standardSchema: deleteConversationResponseSchema })
  @ApiNotFoundResponse({ description: 'No such conversation (or it is not yours)' })
  async remove(
    @Param({ schema: conversationParamSchema }) params: ConversationParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    assertCanUse(principal);
    await this.assistant.deleteConversation(principal, params.id);
    return parseResponse(deleteConversationResponseSchema, { deleted: true });
  }
}
