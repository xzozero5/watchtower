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
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  assistantConversationListSchema,
  assistantFeedbackRequestSchema,
  assistantFeedbackSchema,
  assistantMemoryListSchema,
  assistantMemoryParamSchema,
  assistantMemorySchema,
  assistantMessageRequestSchema,
  assistantPhaseEventSchema,
  assistantReplySchema,
  assistantStartersQuerySchema,
  assistantStartersSchema,
  clearAssistantMemoryResponseSchema,
  confirmProposalResponseSchema,
  conversationParamSchema,
  createAssistantMemorySchema,
  deleteAssistantMemoryResponseSchema,
  deleteConversationResponseSchema,
  proposalParamSchema,
  rejectProposalResponseSchema,
  type AssistantFeedbackRequest,
  type AssistantMemoryParam,
  type AssistantMessageRequest,
  type AssistantPhaseEvent,
  type AssistantStartersQuery,
  type ConversationParam,
  type CreateAssistantMemory,
  type ProposalParam,
} from '@watchtower/shared';

import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  WorkspaceOnly,
  type Principal,
} from '../auth/decorators.js';
import type { Request, Response } from 'express';

import { ApiHttpError } from '../auth/http-errors.js';
import { parseResponse } from '../common/zod-openapi.js';
import { AssistantFeedbackService } from './assistant-feedback.js';
import { AssistantMemoryService } from './assistant-memory.js';
import { AssistantProposals } from './assistant-proposals.js';
import { AssistantService, type MessageSink } from './assistant.service.js';

/** How often an idle stream says it is alive, so a proxy does not close it while the person waits in the queue. */
const KEEP_ALIVE_MS = 15_000;

const wantsEventStream = (request: Request): boolean =>
  (request.headers.accept ?? '').toLowerCase().includes('text/event-stream');

/**
 * The AI assistant (T-134, ADR-023, ADR-029). Workspace people only: `@WorkspaceOnly()` makes the guard refuse a
 * client or a system identity with 403 before it looks at permissions, so even a granted `assistant.use` opens
 * nothing for them (po #34: the customer has no bubble, because an AI that answers a customer is N3's business).
 * Everyone else needs `assistant.use`; what the assistant reads is narrower still (each tool asks for the permission
 * of the route that serves the same data). What the assistant may do for a person is narrower than the route: the role and the
 * permissions behind each tool and each proposal decide, and a write only runs when that same person
 * presses a proposal.
 */
@ApiTags('assistant')
@WorkspaceOnly()
@Controller('v1/assistant')
export class AssistantController {
  constructor(
    @Inject(AssistantService) private readonly assistant: AssistantService,
    @Inject(AssistantProposals) private readonly proposals: AssistantProposals,
    @Inject(AssistantMemoryService) private readonly memory: AssistantMemoryService,
    @Inject(AssistantFeedbackService) private readonly feedback: AssistantFeedbackService,
  ) {}

  @Get('starters')
  @RequirePermission('assistant.use')
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
    return parseResponse(assistantStartersSchema, await this.assistant.starters(principal, query));
  }

  @Post('messages')
  @HttpCode(200)
  @RequirePermission('assistant.use')
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
      'wired; 429 when the person sends too many messages in an hour, or sends one while the last is ' +
      'unanswered (`assistant_busy`). With `Accept: text/event-stream` the answer is a stream of phase ' +
      'events instead (JSON stays the default): `queued {position}` (0 = running; again when the place changes), ' +
      '`context {chips}`, `tool {name, status}`, `answering`, then `reply {reply}` when it answered or ' +
      '`error {state, reason}` when it could not (`assistant_queue_full`, `assistant_wait_timeout`, `kill_switch_on`, ' +
      '`budget_stop`, `assistant_audit_failed` ...). Phases, not tokens: the answer is checked before anybody sees ' +
      'a word of it. The audit row is written before `reply` or `error` is sent. Errors found before the stream ' +
      'opens (404, 429) are ordinary HTTP errors. Closing the connection cancels the model call and frees its slot.',
  })
  @ApiOkResponse({
    standardSchema: assistantReplySchema,
    description:
      'JSON: the reply. SSE (`text/event-stream`): events whose `data` is an `AssistantPhaseEvent`.',
  })
  @ApiNotFoundResponse({ description: 'The conversation or the ticket in `context` is not yours' })
  @ApiTooManyRequestsResponse({
    description: 'Too many messages in this hour, or one is still being answered',
  })
  async message(
    @Body({ schema: assistantMessageRequestSchema }) body: AssistantMessageRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    // The person closed the page or pressed Stop: cancel the model call (and free its slot). `close` also fires after a
    // normal end, which is why it counts only when the response was not finished.
    const aborted = new AbortController();
    response.once('close', () => {
      if (!response.writableFinished) aborted.abort();
    });

    if (!wantsEventStream(request)) {
      const reply = await this.assistant.message(principal, body, aborted.signal);
      response.status(200).json(parseResponse(assistantReplySchema, reply));
      return;
    }
    await this.stream(principal, body, aborted.signal, response);
  }

  /**
   * The SSE answer. The stream opens when the service says the request is valid (`accepted`), not before, so a 404 or a 429 is
   * still a status code. From then on every outcome is an event: the service has written the audit row by the time it
   * returns (C-4), so `reply` and `error` leave only after it.
   */
  private async stream(
    principal: Principal,
    body: AssistantMessageRequest,
    signal: AbortSignal,
    response: Response,
  ): Promise<void> {
    const state = { open: false };
    let keepAlive: NodeJS.Timeout | undefined;
    const send = (event: AssistantPhaseEvent): void => {
      if (!state.open || response.writableEnded || response.destroyed) return;
      const checked = parseResponse(assistantPhaseEventSchema, event);
      response.write(`event: ${checked.phase}\ndata: ${JSON.stringify(checked)}\n\n`);
    };
    const sink: MessageSink = {
      accepted: () => {
        if (state.open) return;
        state.open = true;
        response.status(200);
        response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        // No transform, no proxy buffering (Caddy flushes event streams; nginx honours this header): a phase must reach
        // the person when it happens, not when the answer is done.
        response.setHeader('Cache-Control', 'no-cache, no-transform');
        response.setHeader('X-Accel-Buffering', 'no');
        response.flushHeaders();
        keepAlive = setInterval(() => {
          if (!response.writableEnded && !response.destroyed) response.write(': keep-alive\n\n');
        }, KEEP_ALIVE_MS);
        keepAlive.unref();
      },
      phase: send,
    };
    try {
      const reply = await this.assistant.message(principal, body, signal, sink);
      const checked = parseResponse(assistantReplySchema, reply);
      send(
        checked.state === 'ok'
          ? { phase: 'reply', reply: checked }
          : { phase: 'error', state: checked.state, reason: checked.reason ?? checked.state },
      );
    } catch (error) {
      // Before the stream opened this is an ordinary HTTP error (the filter answers it).
      if (!state.open) throw error;
      send({
        phase: 'error',
        state: 'unavailable',
        reason: error instanceof ApiHttpError ? error.code : 'assistant_failed',
      });
    } finally {
      if (keepAlive !== undefined) clearInterval(keepAlive);
      if (state.open && !response.writableEnded) response.end();
    }
  }

  @Get('conversations')
  @RequirePermission('assistant.use')
  @ApiOperation({
    summary: 'My conversations with the assistant, newest first',
    description:
      "Your own only (someone else's do not exist for you), within the retention period, at most 50. Each carries a " +
      'preview of the first thing you asked as it is stored: redacted, so names and addresses are placeholders.',
  })
  @ApiOkResponse({ standardSchema: assistantConversationListSchema })
  async conversations(@CurrentPrincipal() principal: Principal) {
    return parseResponse(
      assistantConversationListSchema,
      await this.assistant.conversations(principal),
    );
  }

  @Get('memory')
  @RequirePermission('assistant.use')
  @ApiOperation({
    summary: 'What I asked the assistant to remember',
    description:
      'Your own pinned facts that have not expired, newest first (at most 20). The text is the redacted text of the ' +
      'answer it came from.',
  })
  @ApiOkResponse({ standardSchema: assistantMemoryListSchema })
  async memoryList(@CurrentPrincipal() principal: Principal) {
    return parseResponse(assistantMemoryListSchema, await this.memory.list(principal));
  }

  @Post('memory')
  @RequirePermission('assistant.use')
  @Audited({ action: AUDIT_ACTIONS.assistantMemoryCreate, targetType: 'assistant_memory' })
  @ApiOperation({
    summary: 'Remember one sentence of an answer',
    description:
      'The only way to make a memory: `messageId` is an answer of yours and `claim` is the (0-based) sentence to keep. ' +
      'The server takes the text from the redacted text it stored for that turn; nothing you type is stored. It lasts ' +
      '90 days from now (using it does not extend that); 20 at most (409 `assistant_memory_full`). Pressing again on the ' +
      'same sentence returns the one you have.',
  })
  @ApiCreatedResponse({ standardSchema: assistantMemorySchema })
  @ApiNotFoundResponse({ description: 'No such answer of yours, or no such sentence in it' })
  @ApiConflictResponse({
    description: 'Twenty are kept already, or the answer said nothing to keep',
  })
  async remember(
    @Body({ schema: createAssistantMemorySchema }) body: CreateAssistantMemory,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(assistantMemorySchema, await this.memory.create(principal, body));
  }

  @Delete('memory')
  @HttpCode(200)
  @RequirePermission('assistant.use')
  @Audited({ action: AUDIT_ACTIONS.assistantMemoryDelete, targetType: 'assistant_memory' })
  @ApiOperation({
    summary: 'Forget everything of mine',
    description: 'Removes all your own pinned facts.',
  })
  @ApiOkResponse({ standardSchema: clearAssistantMemoryResponseSchema })
  async forgetAll(@CurrentPrincipal() principal: Principal) {
    return parseResponse(clearAssistantMemoryResponseSchema, {
      deleted: await this.memory.clear(principal),
    });
  }

  @Delete('memory/:id')
  @HttpCode(200)
  @RequirePermission('assistant.use')
  @Audited({ action: AUDIT_ACTIONS.assistantMemoryDelete, targetType: 'assistant_memory' })
  @ApiOperation({ summary: 'Forget one pinned fact of mine' })
  @ApiOkResponse({ standardSchema: deleteAssistantMemoryResponseSchema })
  @ApiNotFoundResponse({ description: 'No such memory (or it is not yours)' })
  async forget(
    @Param({ schema: assistantMemoryParamSchema }) params: AssistantMemoryParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.memory.remove(principal, params.id);
    return parseResponse(deleteAssistantMemoryResponseSchema, { deleted: true });
  }

  @Post('feedback')
  @HttpCode(200)
  @RequirePermission('assistant.use')
  @Audited({ action: AUDIT_ACTIONS.assistantFeedback, targetType: 'assistant_message' })
  @ApiOperation({
    summary: 'Thumbs-up or thumbs-down on an answer or an insight',
    description:
      '`target` is an answer of yours (`message`) or an embedded insight (`insight`) you can see. A thumbs-down may carry ' +
      'a reason code. One rating per person and target: sending it again replaces the first. A target you may not see ' +
      'is a 404, the same as one that does not exist.',
  })
  @ApiOkResponse({ standardSchema: assistantFeedbackSchema })
  @ApiNotFoundResponse({ description: 'No such answer or insight (or you may not see it)' })
  @ApiTooManyRequestsResponse({ description: 'Too many ratings in this hour' })
  async rate(
    @Body({ schema: assistantFeedbackRequestSchema }) body: AssistantFeedbackRequest,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(assistantFeedbackSchema, await this.feedback.rate(principal, body));
  }

  @Post('proposals/:id/confirm')
  @HttpCode(200)
  @RequirePermission('assistant.use')
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
    return parseResponse(
      confirmProposalResponseSchema,
      await this.proposals.confirm(principal, params.id),
    );
  }

  @Post('proposals/:id/reject')
  @HttpCode(200)
  @RequirePermission('assistant.use')
  @Audited({ action: AUDIT_ACTIONS.assistantProposalReject, targetType: 'assistant_proposal' })
  @ApiOperation({ summary: 'Decline a proposal', description: 'Closes it; nothing runs.' })
  @ApiOkResponse({ standardSchema: rejectProposalResponseSchema })
  @ApiNotFoundResponse({ description: 'No such proposal (or it is not yours)' })
  @ApiConflictResponse({ description: 'Already used, closed or expired' })
  async reject(
    @Param({ schema: proposalParamSchema }) params: ProposalParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      rejectProposalResponseSchema,
      await this.proposals.reject(principal, params.id),
    );
  }

  @Delete('conversations/:id')
  @HttpCode(200)
  @RequirePermission('assistant.use')
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
    await this.assistant.deleteConversation(principal, params.id);
    return parseResponse(deleteConversationResponseSchema, { deleted: true });
  }
}
