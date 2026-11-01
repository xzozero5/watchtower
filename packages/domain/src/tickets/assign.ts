import { schema } from '@watchtower/db';
import { AUDIT_ACTIONS, TICKET_EVENT_TYPES, type AssignTicket } from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import {
  assertAssignableStaff,
  peekAssignee,
  takeTurn,
  type AssignStrategy,
} from '../assignment.js';
import { recordAuditInTx } from '../audit.js';
import { badRequest, conflict, notFound, ticketNotOpen } from '../errors.js';
import { notifyTicketAssigned } from '../notifications.js';
import type { TicketRow } from '../rows.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import { lockTicketRow, recordTicketEvent, resolveQueue, ticketEvent } from './support.js';

export interface AssignTicketInput {
  /** A ticket id or key (`OPS-12`). */
  readonly ref: string;
  readonly assignment: AssignTicket;
}

/**
 * Hands a ticket to a person (manual) or to the next member of its queue (round-robin, R-1.7),
 * optionally moving it to another queue. Assigning what is already so changes nothing and does not
 * use up a round-robin turn.
 */
export async function assignTicket(
  tx: DbTransaction,
  ctx: DomainContext,
  input: AssignTicketInput,
): Promise<DomainResult<TicketRow>> {
  const fx = new Effects();
  const { assignment } = input;
  const before = await lockTicketRow(tx, ctx, input.ref);
  if (before.status === 'merged') {
    throw ticketNotOpen('This ticket was merged into another; assign that one');
  }

  let queueId = before.queueId;
  if (assignment.queueId !== undefined) {
    await resolveQueue(tx, assignment.queueId);
    queueId = assignment.queueId;
  }

  let assigneeId: string | null;
  let strategy: 'manual' | AssignStrategy;
  if (assignment.strategy !== undefined) {
    if (queueId === null)
      throw badRequest('The ticket has no queue to take turns in; give queueId');
    // Look at whom the strategy picks without taking the turn: it is taken below only if the ticket moves.
    assigneeId = await peekAssignee(tx, queueId, assignment.strategy, {
      requesterContactId: before.requesterContactId,
      excludeTicketId: before.id,
    });
    if (assigneeId === null)
      throw conflict('The queue has no member who is clocked in to assign to');
    strategy = assignment.strategy;
  } else {
    assigneeId = assignment.assigneeId ?? null;
    if (assigneeId !== null) await assertAssignableStaff(tx, [assigneeId]);
    strategy = 'manual';
  }

  // Nothing changes, so a turn is not used up: the same member stays next in line.
  if (assigneeId === before.assigneeId && queueId === before.queueId) return fx.result(before);
  if (strategy !== 'manual' && queueId !== null && assigneeId !== null) {
    await takeTurn(tx, queueId, assigneeId);
  }
  const [after] = await tx
    .update(schema.ticket)
    .set({ assigneeId, queueId, updatedAt: ctx.now() })
    .where(eq(schema.ticket.id, before.id))
    .returning();
  if (!after) throw notFound('No such ticket');

  const changed = [
    ...(assigneeId === before.assigneeId ? [] : ['assignee']),
    ...(queueId === before.queueId ? [] : ['queue']),
  ];
  // The history of who held the ticket: one append-only event per change.
  await recordTicketEvent(tx, after.id, TICKET_EVENT_TYPES.assigned, ctx.actor, 'internal', {
    from: before.assigneeId,
    to: assigneeId,
    strategy,
    queueId,
  });
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.ticketAssign,
    targetType: 'ticket',
    targetId: after.id,
    before: { assigneeId: before.assigneeId, queueId: before.queueId },
    after: { assigneeId, queueId },
    metadata: { strategy },
  });
  fx.emit(ticketEvent(ctx, 'ticket.updated', after, changed));
  if (changed.includes('assignee')) await notifyTicketAssigned(tx, ctx, fx, after);
  return fx.result(after);
}
