import { HttpException, Inject, Injectable } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  type BulkAction,
  type BulkItem,
  type BulkRequest,
  type BulkResult,
} from '@watchtower/shared';

import { AuditScope } from '../audit/audit-scope.js';
import type { Principal } from '../auth/principal.js';
import { badRequest } from '../auth/http-errors.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { TICKET_KEYS, type TicketKeys } from '../tickets/ticket-keys.js';
import { TicketReader } from '../tickets/ticket-reader.js';
import { TicketsService, type Actor } from '../tickets/tickets.service.js';

/** The code, status and message an `HttpException` carries; anything else is an internal error whose text is not shown. */
function describeError(error: unknown): NonNullable<BulkItem['error']> {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    const record = typeof body === 'object' ? (body as Record<string, unknown>) : {};
    return {
      status: error.getStatus(),
      code: typeof record.code === 'string' ? record.code : 'error',
      message: typeof record.message === 'string' ? record.message : error.message,
    };
  }
  return { status: 500, code: 'internal_error', message: 'The change could not be made' };
}

/**
 * Bulk actions on tickets (T-119b, PRD R-1.8, UI spec 4.2). Each ticket is its own transaction that
 * goes through exactly the code a single change does (`TicketsService`), as the person who asked:
 *
 *  - the person must be allowed to see the ticket (the same check as opening it) and to handle it
 *    (`ticket.handle`, on the route), so one ticket the caller may not touch fails alone;
 *  - the ticket event and the audit row of each change name that person as actor, which is what the
 *    shift handoff gate reads to find tickets a person took off their own plate (AC-7: `ticket.assigned`
 *    from them to somebody else, `ticket.updated` lowering a P1/P2). Bulk is no way around it;
 *  - nothing here sends anything to a customer, and there is no reply action: the policy gate for
 *    customer sends (N3) is never in the path, and cannot be reached from here;
 *  - one ticket failing (merged, not allowed, a refused transition) does not undo the others; the
 *    answer lists every ticket's outcome. A summary row `ticket.bulk` lists them too.
 */
@Injectable()
export class BulkService {
  constructor(
    @Inject(TicketsService) private readonly tickets: TicketsService,
    @Inject(TicketReader) private readonly reader: TicketReader,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(TICKET_KEYS) private readonly keys: TicketKeys,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  async run(request: BulkRequest, principal: Principal): Promise<BulkResult> {
    const actor: Actor = { type: 'user', id: principal.userId };
    const { action } = request;

    // The ticket everything is merged into is looked up once, as the person: not theirs, no merge.
    let mergeTargetId: string | undefined;
    if (action.type === 'merge') {
      const target = await this.reader.viewRow(action.intoTicketId, principal);
      if (request.ticketIds.includes(target.t.id)) {
        throw badRequest('The ticket to merge into cannot be one of the selected tickets');
      }
      mergeTargetId = target.t.id;
    }

    const items: BulkItem[] = [];
    for (const ticketId of request.ticketIds) {
      items.push(await this.one(ticketId, action, mergeTargetId, principal, actor));
    }

    const succeeded = items.filter((item) => item.ok).length;
    const failed = items.length - succeeded;
    // Each change wrote its own audit row; the request also gets one summary row. The units of work
    // above told the interceptor "already audited", so say that this one is still to write.
    AuditScope.set({
      persisted: false,
      action: AUDIT_ACTIONS.ticketBulk,
      targetType: 'ticket',
      targetId: null,
      outcome: succeeded === 0 ? 'failure' : 'success',
      metadata: {
        bulkAction: action.type,
        total: items.length,
        succeeded,
        failed,
        results: items.map((item) => ({
          ticketId: item.ticketId,
          ok: item.ok,
          ...(item.error === undefined ? {} : { code: item.error.code }),
        })),
        ...(action.type === 'assign' ? { assigneeId: action.assigneeId } : {}),
        ...(action.type === 'status' ? { status: action.status } : {}),
        ...(action.type === 'priority' ? { priority: action.priority } : {}),
        ...(mergeTargetId === undefined ? {} : { intoTicketId: mergeTargetId }),
      },
    });
    return { action: action.type, total: items.length, succeeded, failed, items };
  }

  private async one(
    ticketId: string,
    action: BulkAction,
    mergeTargetId: string | undefined,
    principal: Principal,
    actor: Actor,
  ): Promise<BulkItem> {
    let key: string | null = null;
    try {
      // Per ticket: may this person see it (organization scope, `ticket.read`)? 404 if not theirs.
      const view = await this.reader.viewRow(ticketId, principal);
      key = this.keys.format(view.t.number);
      await this.uow.run(async (uow) => {
        switch (action.type) {
          case 'assign':
            await this.tickets.assign(uow, ticketId, { assigneeId: action.assigneeId }, actor);
            return;
          case 'status':
            await this.tickets.changeStatus(uow, ticketId, action.status, actor, action.reason);
            return;
          case 'priority':
            await this.tickets.update(uow, ticketId, { priority: action.priority }, actor);
            return;
          case 'merge':
            if (mergeTargetId === undefined) throw new Error('merge without a target');
            await this.tickets.merge(
              uow,
              ticketId,
              { intoTicketId: mergeTargetId, ...(action.reason === undefined ? {} : { reason: action.reason }) },
              actor,
            );
            return;
        }
      });
      return { ticketId, key, ok: true };
    } catch (error) {
      if (!(error instanceof HttpException)) {
        this.logger.error({ err: error, ticketId }, 'bulk action failed on a ticket');
      }
      return { ticketId, key, ok: false, error: describeError(error) };
    }
  }
}
