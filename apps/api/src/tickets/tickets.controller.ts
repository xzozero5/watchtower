import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
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
  createTicketSchema,
  duplicateSuggestionsSchema,
  mergeResultSchema,
  mergeTicketSchema,
  noteSchema,
  replyResultSchema,
  replySchema,
  ticketDetailResponseSchema,
  ticketListQuerySchema,
  ticketListSchema,
  ticketRefParamSchema,
  timelinePageSchema,
  timelineQuerySchema,
  updateTicketSchema,
  type AssignTicket,
  type ChannelType,
  type ChangeStatus,
  type CreateTicket,
  type MergeTicket,
  type Note,
  type Reply,
  type TicketListQuery,
  type TimelineQuery,
  type UpdateTicket,
} from '@watchtower/shared';
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
import { toMessage } from './message-view.js';
import { TICKET_KEYS, type TicketKeys } from './ticket-keys.js';
import { TicketReader, assertCanRead, isClient } from './ticket-reader.js';
import {
  TicketsService,
  type Actor,
  type CreateTicketCommand,
  type Sender,
} from './tickets.service.js';
import { TimelineService } from './timeline.service.js';

type RefParam = z.infer<typeof ticketRefParamSchema>;

const actorOf = (principal: Principal): Actor => ({ type: 'user', id: principal.userId });

/** Fields only staff may set when filing a ticket. A client who sends one is told so, not ignored. */
const STAFF_ONLY_CREATE_FIELDS = [
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
  @RequireAnyPermission('ticket.read', 'ticket.read.org')
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
      'back as `cursor`. Every list is on the audit log (`pii.read`).',
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
        ...(body.intentId === undefined ? {} : { intentId: body.intentId }),
        ...(body.intentKey === undefined ? {} : { intentKey: body.intentKey }),
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
  @RequireAnyPermission('ticket.read', 'ticket.read.org')
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
  @RequireAnyPermission('ticket.read', 'ticket.read.org')
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
  @RequirePermission('ticket.handle')
  @Audited({ action: AUDIT_ACTIONS.ticketStatusChange, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Change the status',
    description:
      'Only transitions the workflow allows (GET /v1/ticket-workflow). The SLA clock stops in ' +
      'waiting_on_customer and restarts with the time that was left. A ticket becomes merged only ' +
      'through the merge endpoint.',
  })
  @ApiOkResponse({ standardSchema: ticketDetailResponseSchema })
  @ApiConflictResponse({ description: 'Transition not allowed (invalid_transition)' })
  async changeStatus(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @Body({ schema: changeStatusSchema }) body: ChangeStatus,
    @CurrentPrincipal() principal: Principal,
  ) {
    const row = await this.uow.run((uow) =>
      this.tickets.changeStatus(uow, params.id, body.status, actorOf(principal), body.reason),
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
      'last 7 days. Merged and closed tickets refuse replies (ticket_not_open).',
  })
  @ApiCreatedResponse({ standardSchema: replyResultSchema })
  @ApiConflictResponse({ description: 'Ticket not open (ticket_not_open) or invalid_transition' })
  async reply(
    @Param({ schema: ticketRefParamSchema }) params: RefParam,
    @Body({ schema: replySchema }) body: Reply,
    @CurrentPrincipal() principal: Principal,
  ) {
    assertCanReplyAs(principal);
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
      }),
      ticket: await this.reader.detail(result.ticket.id, principal),
    });
  }

  @Post(':id/notes')
  @RequirePermission('ticket.handle')
  @Audited({ action: AUDIT_ACTIONS.ticketNote, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Internal note',
    description: 'Staff only. Never sent to the customer and never visible to a client.',
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
    return parseResponse(replyResultSchema, {
      message: toMessage(result.message, {
        ticketKey: this.keys.format(result.ticket.number),
        channel: result.ticket.channel as ChannelType,
        senderUserName: principal.name,
        senderUserRole: principal.role,
        senderContactName: null,
        audience: 'staff',
      }),
      ticket: await this.reader.detail(result.ticket.id, principal),
    });
  }

  @Get(':id/timeline')
  @RequireAnyPermission('ticket.read', 'ticket.read.org')
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
}

/** Staff replying needs `ticket.reply`; a client needs `ticket.reply.own`. The other one is not enough. */
function assertCanReplyAs(principal: Principal): void {
  const needed = principal.orgScope.kind === 'org' ? 'ticket.reply.own' : 'ticket.reply';
  if (!principal.permissions.has(needed)) throw forbidden();
}
