import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  assignTicketSchema,
  changeStatusSchema,
  createManualTicketSchema,
  createTicketLinkSchema,
  createTicketSchema,
  duplicateSuggestionsSchema,
  mergeResultSchema,
  manualTicketResultSchema,
  mergeTicketSchema,
  noteSchema,
  replyResultSchema,
  replySchema,
  similarTicketsQuerySchema,
  similarTicketsSchema,
  ticketDetailResponseSchema,
  ticketLinkParamSchema,
  ticketListQuerySchema,
  ticketListSchema,
  ticketRefParamSchema,
  ticketStatsQuerySchema,
  ticketStatsSchema,
  timelinePageSchema,
  timelineQuerySchema,
  updateTicketSchema,
  type AssignTicket,
  type ChannelType,
  type ChangeStatus,
  type CreateManualTicket,
  type CreateTicket,
  type CreateTicketLink,
  type MergeTicket,
  type Message,
  type Note,
  type Reply,
  type SimilarTicketsQuery,
  type TicketListQuery,
  type TicketStatsQuery,
  type TimelineQuery,
  type UpdateTicket,
} from '@watchtower/shared';
import { toDeliverySummary } from '@watchtower/domain';
import type { z } from 'zod';

import { AuditScope } from '../audit/audit-scope.js';
import {
  AuditPiiRead,
  Audited,
  CurrentPrincipal,
  RequireAnyPermission,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { badRequest, forbidden } from '../auth/http-errors.js';
import { parseResponse } from '../common/zod-openapi.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { maskMessage, toMessage } from './message-view.js';
import { TICKET_KEYS, type TicketKeys } from './ticket-keys.js';
import { createMaskingSession } from '../masking/pii-masker.js';
import { TicketReader, assertCanRead, isClient, isMasked } from './ticket-reader.js';
import {
  TicketsService,
  type Actor,
  type CreateTicketCommand,
  type Sender,
} from './tickets.service.js';
import { TimelineService } from './timeline.service.js';

type RefParam = z.infer<typeof ticketRefParamSchema>;
type LinkParam = z.infer<typeof ticketLinkParamSchema>;

const actorOf = (principal: Principal): Actor => ({ type: 'user', id: principal.userId });

/** Fields only staff may set when filing a ticket. A client who sends one is told so, not ignored. */
const STAFF_ONLY_CREATE_FIELDS = [
  // A client's intent is not a confirmation: it would pick the autonomy stage the gate reads and
  // open the AI's tools for the ticket (SR108-1). The AI or a staff member sets it.
  'intentId',
  'intentKey',
  'requesterContactId',
  'requester',
  'priority',
  'queueId',
  'assigneeId',
  'tags',
  'customFields',
] as const satisfies readonly (keyof CreateTicket)[];

@ApiTags('tickets')
@Controller('v1/tickets')
export class TicketsController {
  constructor(
    @Inject(TicketsService) private readonly tickets: TicketsService,
    @Inject(TicketReader) private readonly reader: TicketReader,
    @Inject(TimelineService) private readonly timelines: TimelineService,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(TICKET_KEYS) private readonly keys: TicketKeys,
  ) {}

  @Get()
  @RequireAnyPermission('ticket.read', 'ticket.read.org', 'ticket.read.masked')
  // A list carries the requester's name and a search can reveal who wrote about what: it is on the
  // audit log (`pii.read`, no target id) just like reading one ticket.
  @AuditPiiRead('ticket')
  @ApiOperation({
    summary: 'List tickets with filters, search and cursor pagination',
    description:
      'Staff see every ticket; a client sees only tickets of their own organization, in a reduced ' +
      'shape (no assignee, queue, SLA, tags or internal fields). `q` searches the subject and the ' +
      'text of messages (Thai included) and matches an exact ticket number such as OPS-1234; a ' +
      "client's search never matches an internal note. `q` needs at least 2 characters; below 3 " +
      'the trigram index cannot be used, so combine it with another filter. Pass `nextCursor` ' +
      'back as `cursor`. Every list is on the audit log (`pii.read`). A developer (`ticket.read.masked`) ' +
      'gets the same list with personal data masked: no text search (a ticket number only), ' +
      'subjects through the redactor, custom fields left out. `devOwner` filters by the developer ' +
      'who picked a ticket up.',
  })
  @ApiOkResponse({ standardSchema: ticketListSchema })
  async list(
    @Query({ schema: ticketListQuerySchema }) query: TicketListQuery,
    @CurrentPrincipal() principal: Principal,
  ) {
    const page = await this.reader.list(query, principal);
    AuditScope.set({ metadata: { resultCount: page.items.length } });
    return parseResponse(ticketListSchema, page);
  }

  // Declared before `:id` so that "stats" is not read as a ticket reference.
  @Get('stats')
  @RequirePermission('ticket.read')
  @ApiOperation({
    summary: 'Ticket counts by status, queue, assignee, priority and SLA state (staff)',
    description:
      'Takes the filters of the list (not paging or sorting) and counts the tickets they match. ' +
      'Every group carries `count`, `open` and `sla` (`ok`, `at_risk`, `breached`, `paused`) ' +
      'for the SLA target that is running now. At risk = 25 % of the target or 30 minutes left, ' +
      'whichever is first, measured in business time on the policy calendar; paused = the SLA ' +
      'clock is stopped; a ticket with no running target is in no SLA state. Assignee `null` = ' +
      'unassigned, queue `null` = no queue. Groups with no ticket are left out. Not available to ' +
      'a client (403): the counts are about assignees and SLA. Counts only, no personal data, so ' +
      'it is not on the audit log.',
  })
  @ApiOkResponse({ standardSchema: ticketStatsSchema })
  async stats(
    @Query({ schema: ticketStatsQuerySchema }) query: TicketStatsQuery,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(ticketStatsSchema, await this.reader.stats(query, principal));
  }

  // Declared before `:id` so that "similar" is not read as a ticket reference.
  @Get('similar')
  @RequirePermission('ticket.read')
  @AuditPiiRead('ticket')
  @ApiOperation({
    summary: 'Open tickets that may be the same request as the one being filed (staff)',
    description:
      'For the form that files a ticket by hand: open tickets of the organization whose subject is ' +
      'similar (trigram similarity, same requester first). Up to 5. A developer or a client gets 403.',
  })
  @ApiOkResponse({ standardSchema: similarTicketsSchema })
  async similar(
    @Query({ schema: similarTicketsQuerySchema }) query: SimilarTicketsQuery,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await this.reader.similar(query, principal);
    AuditScope.set({ metadata: { resultCount: result.items.length } });
    return parseResponse(similarTicketsSchema, result);
  }

  @Post('manual')
  @RequirePermission('ticket.create', 'ticket.handle')
  @Audited({ action: AUDIT_ACTIONS.ticketCreate, targetType: 'ticket' })
  @ApiOperation({
    summary: 'File a ticket by hand: a phone call, a visit, a chat that is not connected (staff)',
    description:
      'Needs an organization, a contact (an existing one, or a new one by address; a new contact is ' +
      'created unverified), a subject, what the customer said and the channel (`phone`, `walk_in`, ' +
      '`chat`, `other`). The SLA clock starts now. The customer gets an automatic "we received your ' +
      'request" email by default when the contact already existed; for a new address set ' +
      '`sendConfirmation: true` (the person ticks the box). `confirmation.status` says what happened. ' +
      'Nothing can be replied on these channels: a public reply answers 409 `channel_no_outbound`; ' +
      'record the call as an internal note. A client or a developer gets 403.',
  })
  @ApiCreatedResponse({ standardSchema: manualTicketResultSchema })
  async createManual(
    @Body({ schema: createManualTicketSchema }) body: CreateManualTicket,
    @CurrentPrincipal() principal: Principal,
  ) {
    if (principal.orgScope.kind === 'org') throw forbidden();
    const created = await this.uow.run((uow) =>
      this.tickets.createManual(uow, body, actorOf(principal)),
    );
    AuditScope.set({ metadata: { channel: body.channel, confirmation: created.confirmation } });
    return parseResponse(manualTicketResultSchema, {
      ticket: await this.reader.staffDetail(
        await this.reader.viewById(created.ticket.id, principal),
      ),
      contact: { id: created.contact.id, created: created.contactCreated },
      confirmation: { status: created.confirmation },
    });
  }

  @Post()
  @RequirePermission('ticket.create')
  @Audited({ action: AUDIT_ACTIONS.ticketCreate, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Create a ticket',
    description:
      'Staff give `orgId` and who is asking (`requesterContactId`, or `requester` to find or create ' +
      'the contact by address). A client files for their own organization with `subject`, `body` ' +
      'and optionally an intent; staff-only fields are refused. The ticket gets the next number ' +
      '(OPS-1234), SLA due dates and, in a round-robin queue, an assignee, all in one transaction.',
  })
  @ApiCreatedResponse({ standardSchema: ticketDetailResponseSchema })
  async create(
    @Body({ schema: createTicketSchema }) body: CreateTicket,
    @CurrentPrincipal() principal: Principal,
  ) {
    let command: CreateTicketCommand;
    if (principal.orgScope.kind === 'org') {
      const forbiddenFields = STAFF_ONLY_CREATE_FIELDS.filter((field) => body[field] !== undefined);
      if (forbiddenFields.length > 0) {
        throw forbidden(`A client cannot set ${forbiddenFields.join(', ')}`);
      }
      if (body.orgId !== undefined && body.orgId !== principal.orgScope.orgId) {
        throw forbidden('A client can only file tickets for their own organization');
      }
      command = {
        actor: actorOf(principal),
        orgId: principal.orgScope.orgId,
        subject: body.subject,
        body: body.body,
        requester: { email: principal.email, name: principal.name },
        senderUserId: principal.userId,
      };
    } else {
      if (body.orgId === undefined) throw badRequest('orgId is required');
      if (body.requesterContactId !== undefined && body.requester !== undefined) {
        throw badRequest('Give requesterContactId or requester, not both');
      }
      command = {
        actor: actorOf(principal),
        orgId: body.orgId,
        subject: body.subject,
        body: body.body,
        ...(body.requesterContactId === undefined
          ? {}
          : { requesterContactId: body.requesterContactId }),
        ...(body.requester === undefined ? {} : { requester: body.requester }),
        ...(body.intentId === undefined ? {} : { intentId: body.intentId }),
        ...(body.intentKey === undefined ? {} : { intentKey: body.intentKey }),
        ...(body.priority === undefined ? {} : { priority: body.priority }),
        ...(body.queueId === undefined ? {} : { queueId: body.queueId }),
        ...(body.assigneeId === undefined ? {} : { assigneeId: body.assigneeId }),
        ...(body.tags === undefined ? {} : { tags: body.tags }),
        ...(body.customFields === undefined ? {} : { customFields: body.customFields }),
      };
    }
    const created = await this.uow.run((uow) => this.tickets.create(uow, command));
    return parseResponse(
      ticketDetailResponseSchema,
      await this.reader.detail(created.ticket.id, principal),
    );
  }

  @Get(':id')
  @RequireAnyPermission('ticket.read', 'ticket.read.org', 'ticket.read.masked')
  // The requester's address is personal data: every read of a ticket is on the audit log.
  @AuditPiiRead('ticket')
  @ApiOperation({
    summary: 'One ticket, by id or by number (OPS-1234)',
    description: 'A client asking for a ticket of another organization gets 404.',
  })
  @ApiOkResponse({ standardSchema: ticketDetailResponseSchema })
  @ApiNotFoundResponse({ description: 'No such ticket, or not in your organization' })
  async get(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    const detail = await this.reader.detail(params.id, principal);
    AuditScope.set({ targetId: detail.id });
    return parseResponse(ticketDetailResponseSchema, detail);
  }

  @Get(':id/duplicates')
  @RequireAnyPermission('ticket.read', 'ticket.read.org', 'ticket.read.masked')
  @AuditPiiRead('ticket')
  @ApiOperation({
    summary: 'Tickets this one may duplicate',
    description:
      'Open tickets of the same organization and intent that were filed in the last 72 hours, ' +
      'newest first, without the ticket itself (merged and closed tickets are left out). Staff get ' +
      'the full summary; a client gets the reduced shape and only tickets of their own organization.',
  })
  @ApiOkResponse({ standardSchema: duplicateSuggestionsSchema })
  @ApiNotFoundResponse({ description: 'No such ticket, or not in your organization' })
  async duplicates(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    const { ticketId, items } = await this.reader.duplicates(params.id, principal);
    AuditScope.set({ targetId: ticketId });
    return parseResponse(duplicateSuggestionsSchema, { items });
  }

  @Patch(':id')
  @RequirePermission('ticket.handle')
  @Audited({ action: AUDIT_ACTIONS.ticketUpdate, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Edit subject, priority, intent, queue, tags or custom fields',
    description: 'A new priority recalculates the SLA due dates.',
  })
  @ApiOkResponse({ standardSchema: ticketDetailResponseSchema })
  @ApiNotFoundResponse({ description: 'No such ticket' })
  @ApiConflictResponse({ description: 'The ticket was merged into another (ticket_not_open)' })
  async update(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @Body({ schema: updateTicketSchema }) body: UpdateTicket,
    @CurrentPrincipal() principal: Principal,
  ) {
    const row = await this.uow.run((uow) =>
      this.tickets.update(uow, params.id, body, actorOf(principal)),
    );
    return parseResponse(ticketDetailResponseSchema, await this.reader.detail(row.id, principal));
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequireAnyPermission('ticket.handle', 'ticket.dev.work')
  @Audited({ action: AUDIT_ACTIONS.ticketStatusChange, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Change the status',
    description:
      'Only transitions the workflow allows (GET /v1/ticket-workflow). The SLA clock stops in ' +
      'waiting_on_customer and restarts with the time that was left. A ticket becomes merged only ' +
      'through the merge endpoint. Moving a ticket to `waiting_on_dev` needs a `reason`, which is ' +
      'saved as an internal note; the queue and the assignee stay. A developer (`ticket.dev.work` ' +
      'without `ticket.handle`) moves a ticket only between `open` and `waiting_on_dev`, and ' +
      'handing it back needs a `reason` too (403 otherwise). The customer sees "In progress" for both.',
  })
  @ApiOkResponse({ standardSchema: ticketDetailResponseSchema })
  @ApiConflictResponse({ description: 'Transition not allowed (invalid_transition)' })
  async changeStatus(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @Body({ schema: changeStatusSchema }) body: ChangeStatus,
    @CurrentPrincipal() principal: Principal,
  ) {
    // Someone who may only do the developer's work is held to the developer's two statuses.
    const asDev = !principal.permissions.has('ticket.handle');
    const row = await this.uow.run((uow) =>
      this.tickets.changeStatus(
        uow,
        params.id,
        body.status,
        actorOf(principal),
        body.reason,
        asDev,
      ),
    );
    return parseResponse(ticketDetailResponseSchema, await this.reader.detail(row.id, principal));
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermission('ticket.handle')
  @Audited({ action: AUDIT_ACTIONS.ticketAssign, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Assign the ticket: to a person, to nobody, or to the next member of a queue',
    description:
      'Every change is kept in the ticket history (event `ticket.assigned`). `strategy: ' +
      'round_robin` takes the next active member of the ticket queue, or of `queueId`.',
  })
  @ApiOkResponse({ standardSchema: ticketDetailResponseSchema })
  async assign(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @Body({ schema: assignTicketSchema }) body: AssignTicket,
    @CurrentPrincipal() principal: Principal,
  ) {
    const row = await this.uow.run((uow) =>
      this.tickets.assign(uow, params.id, body, actorOf(principal)),
    );
    return parseResponse(ticketDetailResponseSchema, await this.reader.detail(row.id, principal));
  }

  @Post(':id/merge')
  @HttpCode(200)
  @RequirePermission('ticket.handle')
  @Audited({ action: AUDIT_ACTIONS.ticketMerge, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Merge this ticket into another',
    description:
      'The ticket in the URL becomes `merged` and points at `intoTicketId`; the target keeps both ' +
      'conversations. Refused across organizations, for a ticket already merged, and when it would ' +
      'form a loop (merge_not_allowed).',
  })
  @ApiOkResponse({ standardSchema: mergeResultSchema })
  @ApiConflictResponse({ description: 'Merge not allowed (merge_not_allowed)' })
  async merge(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @Body({ schema: mergeTicketSchema }) body: MergeTicket,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await this.uow.run((uow) =>
      this.tickets.merge(uow, params.id, body, actorOf(principal)),
    );
    const source = await this.reader.viewById(result.source.id, principal);
    const target = await this.reader.viewById(result.target.id, principal);
    return parseResponse(mergeResultSchema, {
      source: await this.reader.staffDetail(source),
      target: await this.reader.staffDetail(target),
    });
  }

  @Post(':id/replies')
  @RequireAnyPermission('ticket.reply', 'ticket.reply.own')
  @Audited({ action: AUDIT_ACTIONS.ticketReply, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Public reply',
    description:
      'Staff answer the customer (the first one is the first response for the SLA; `setStatus` ' +
      'replies and sets the status in one step). A client writes on a ticket of their own ' +
      'organization: that restarts a ticket waiting on the customer and reopens one resolved in the ' +
      'last 7 days. Merged and closed tickets refuse replies (ticket_not_open). On a portal ticket ' +
      'a staff reply is delivered at once. On Gmail and LINE it is queued (`deliveryStatus: ' +
      'scheduled`, `delivery.cancellable`) and sent when the undo window of the instance ends ' +
      '(`POST /v1/tickets/{id}/deliveries/{deliveryId}/cancel` undoes it before then); the first ' +
      'response of the SLA counts from the moment it is sent. `aiDraftId` sends an AI draft: the ' +
      'body must be exactly the draft, and the sender is recorded as its approver (403 ' +
      'otherwise); an AI never sends to a customer without a person doing this (N3).',
  })
  @ApiCreatedResponse({ standardSchema: replyResultSchema })
  @ApiConflictResponse({ description: 'Ticket not open (ticket_not_open) or invalid_transition' })
  async reply(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @Body({ schema: replySchema }) body: Reply,
    @CurrentPrincipal() principal: Principal,
  ) {
    assertCanReplyAs(principal);
    // Approving or editing an AI draft is the verdict `ai.draft.review` is for, not just a reply.
    if (
      (body.aiDraftId !== undefined || body.editedFromDraftId !== undefined) &&
      !principal.permissions.has('ai.draft.review')
    ) {
      throw forbidden('Approving or editing an AI draft needs the permission to review drafts');
    }
    const sender: Sender =
      principal.orgScope.kind === 'org'
        ? {
            kind: 'client',
            userId: principal.userId,
            orgId: principal.orgScope.orgId,
            email: principal.email,
            name: principal.name,
          }
        : { kind: 'staff', userId: principal.userId };
    const result = await this.uow.run((uow) =>
      this.tickets.reply(uow, params.id, body, sender, actorOf(principal)),
    );
    return parseResponse(replyResultSchema, {
      message: toMessage(result.message, {
        ticketKey: this.keys.format(result.ticket.number),
        channel: result.ticket.channel as ChannelType,
        senderUserName: principal.name,
        senderUserRole: principal.role,
        senderContactName: null,
        audience: isClient(principal) ? 'client' : 'staff',
        // Gmail and LINE: the delivery the Undo toast cancels.
        ...(result.delivery == null
          ? {}
          : { delivery: toDeliverySummary(result.delivery, new Date()) }),
      }),
      ticket: await this.reader.detail(result.ticket.id, principal),
    });
  }

  @Post(':id/notes')
  @RequireAnyPermission('ticket.handle', 'ticket.dev.work')
  @Audited({ action: AUDIT_ACTIONS.ticketNote, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Internal note',
    description:
      'Staff and developers. Never sent to the customer and never visible to a client. A ' +
      'developer reads the note back masked, like every message.',
  })
  @ApiCreatedResponse({ standardSchema: replyResultSchema })
  async note(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @Body({ schema: noteSchema }) body: Note,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await this.uow.run((uow) =>
      this.tickets.note(uow, params.id, body, { userId: principal.userId }, actorOf(principal)),
    );
    const message = toMessage(result.message, {
      ticketKey: this.keys.format(result.ticket.number),
      channel: result.ticket.channel as ChannelType,
      senderUserName: principal.name,
      senderUserRole: principal.role,
      senderContactName: null,
      audience: 'staff',
    });
    const ticket = await this.reader.detail(result.ticket.id, principal);
    return parseResponse(replyResultSchema, {
      message: isMasked(principal) ? await this.maskedMessage(message, principal) : message,
      ticket,
    });
  }

  @Post(':id/dev-owner')
  @HttpCode(200)
  @RequirePermission('ticket.dev.work')
  @Audited({ action: AUDIT_ACTIONS.ticketDevPickup, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Pick the ticket up as its developer (self only)',
    description:
      'The caller becomes `devOwner`. There is no way to name someone else. The assignee, the queue ' +
      'and the status do not change: the agent stays accountable. 409 when another developer ' +
      'already holds it.',
  })
  @ApiOkResponse({ standardSchema: ticketDetailResponseSchema })
  @ApiConflictResponse({ description: 'Another developer picked it up' })
  async devPickUp(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    const row = await this.uow.run((uow) =>
      this.tickets.devPickUp(uow, params.id, actorOf(principal)),
    );
    return parseResponse(ticketDetailResponseSchema, await this.reader.detail(row.id, principal));
  }

  @Delete(':id/dev-owner')
  @HttpCode(200)
  @RequirePermission('ticket.dev.work')
  @Audited({ action: AUDIT_ACTIONS.ticketDevRelease, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Let the ticket go as its developer',
    description: 'Only the developer who picked it up (403 for anyone else).',
  })
  @ApiOkResponse({ standardSchema: ticketDetailResponseSchema })
  async devRelease(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    const row = await this.uow.run((uow) =>
      this.tickets.devRelease(uow, params.id, actorOf(principal)),
    );
    return parseResponse(ticketDetailResponseSchema, await this.reader.detail(row.id, principal));
  }

  @Post(':id/links')
  @HttpCode(200)
  @RequireAnyPermission('ticket.handle', 'ticket.dev.work')
  @Audited({ action: AUDIT_ACTIONS.ticketLinkAdd, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Link the ticket to an incident or a deploy that already exists',
    description:
      'A reference only: nothing changes on the incident or the deploy, and neither can be ' +
      'created here. Linking the same target twice is not an error.',
  })
  @ApiOkResponse({ standardSchema: ticketDetailResponseSchema })
  async linkAdd(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @Body({ schema: createTicketLinkSchema }) body: CreateTicketLink,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await this.uow.run((uow) =>
      this.tickets.linkAdd(uow, params.id, body, actorOf(principal)),
    );
    return parseResponse(
      ticketDetailResponseSchema,
      await this.reader.detail(result.ticket.id, principal),
    );
  }

  @Delete(':id/links/:linkId')
  @HttpCode(200)
  @RequireAnyPermission('ticket.handle', 'ticket.dev.work')
  @Audited({ action: AUDIT_ACTIONS.ticketLinkRemove, targetType: 'ticket' })
  @ApiOperation({ summary: 'Remove a link to an incident or a deploy' })
  @ApiOkResponse({ standardSchema: ticketDetailResponseSchema })
  @ApiNotFoundResponse({ description: 'No such link on this ticket' })
  async linkRemove(
    @Param({ schema: ticketLinkParamSchema }) params: LinkParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    const row = await this.uow.run((uow) =>
      this.tickets.linkRemove(uow, params.id, params.linkId, actorOf(principal)),
    );
    return parseResponse(ticketDetailResponseSchema, await this.reader.detail(row.id, principal));
  }

  @Get(':id/timeline')
  @RequireAnyPermission('ticket.read', 'ticket.read.org', 'ticket.read.masked')
  @AuditPiiRead('ticket')
  @ApiOperation({
    summary: 'The conversation: messages, internal notes (staff only) and ticket events',
    description:
      'Oldest first, keyset-paginated (`nextCursor` back as `cursor`). Includes the history of ' +
      'tickets merged into this one unless `includeMerged=false`. A client gets public messages and ' +
      'public events only.',
  })
  @ApiOkResponse({ standardSchema: timelinePageSchema })
  @ApiNotFoundResponse({ description: 'No such ticket, or not in your organization' })
  async timeline(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @Query({ schema: timelineQuerySchema }) query: TimelineQuery,
    @CurrentPrincipal() principal: Principal,
  ) {
    assertCanRead(principal);
    const page = await this.timelines.timeline(params.id, query, principal);
    const first = page.entries[0];
    if (first) AuditScope.set({ targetId: first.ticketId });
    return parseResponse(timelinePageSchema, page);
  }

  /** The message a developer just wrote, read back masked like every message they see. */
  private async maskedMessage(message: Message, principal: Principal): Promise<Message> {
    const row = await this.reader.viewById(message.ticketId, principal);
    const session = createMaskingSession(message.ticketId, await this.reader.namesAround(row));
    return maskMessage(message, session);
  }
}

/** Staff replying needs `ticket.reply`; a client needs `ticket.reply.own`. The other one is not enough. */
function assertCanReplyAs(principal: Principal): void {
  const needed = principal.orgScope.kind === 'org' ? 'ticket.reply.own' : 'ticket.reply';
  if (!principal.permissions.has(needed)) throw forbidden();
}
