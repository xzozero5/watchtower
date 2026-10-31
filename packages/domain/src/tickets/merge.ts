import { PG, isPgError, schema } from '@watchtower/db';
import { AUDIT_ACTIONS, TICKET_EVENT_TYPES, type MergeTicket } from '@watchtower/shared';
import { asc, eq, inArray } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { mergeNotAllowed, notFound } from '../errors.js';
import type { TicketRow } from '../rows.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import {
  recordTicketEvent,
  ticketEvent,
  ticketIdOf,
  ticketKeysOf,
  ticketSnapshot,
} from './support.js';

export interface MergeTicketInput {
  /** The source: a ticket id or key (`OPS-12`). */
  readonly ref: string;
  readonly merge: MergeTicket;
}

/**
 * Merges `ref` (the source) into `merge.intoTicketId` (the target): the source becomes `merged` and
 * points at the target through `parent_ticket_id`; both keep their messages, and the target's
 * timeline shows the source's history too. Refused when it would cross organizations or form a loop.
 */
export async function mergeTickets(
  tx: DbTransaction,
  ctx: DomainContext,
  input: MergeTicketInput,
): Promise<DomainResult<{ source: TicketRow; target: TicketRow }>> {
  const fx = new Effects();
  const keys = ticketKeysOf(ctx);
  // Lock both tickets in id order: two merges that name the same pair, in either direction, queue
  // up instead of each merging into the other.
  const first = await ticketIdOf(tx, ctx, input.ref);
  const second = await ticketIdOf(tx, ctx, input.merge.intoTicketId);
  const locked = await tx
    .select()
    .from(schema.ticket)
    .where(inArray(schema.ticket.id, [first, second]))
    .orderBy(asc(schema.ticket.id))
    .for('update');
  const source = locked.find((row) => row.id === first);
  const target = locked.find((row) => row.id === second);
  if (!source || !target) throw notFound('No such ticket');

  if (source.id === target.id) throw mergeNotAllowed('A ticket cannot be merged into itself');
  if (source.orgId !== target.orgId) {
    throw mergeNotAllowed('Tickets of different organizations cannot be merged');
  }
  if (source.status === 'merged') {
    throw mergeNotAllowed('This ticket was already merged into another ticket');
  }
  if (target.status === 'merged') {
    throw mergeNotAllowed('The target was itself merged into another ticket; merge into that one');
  }
  if (target.status === 'closed') throw mergeNotAllowed('The target ticket is closed');

  // Tickets already merged into the source move to the target, so a chain is never deeper than one.
  const children = await tx
    .update(schema.ticket)
    .set({ parentTicketId: target.id, updatedAt: ctx.now() })
    .where(eq(schema.ticket.parentTicketId, source.id))
    .returning();

  const now = ctx.now();
  let updatedSource: TicketRow | undefined;
  let updatedTarget: TicketRow | undefined;
  try {
    [updatedSource] = await tx
      .update(schema.ticket)
      .set({ status: 'merged', parentTicketId: target.id, slaPausedAt: null, updatedAt: now })
      .where(eq(schema.ticket.id, source.id))
      .returning();
    [updatedTarget] = await tx
      .update(schema.ticket)
      .set({ updatedAt: now })
      .where(eq(schema.ticket.id, target.id))
      .returning();
  } catch (error) {
    // The database refuses a loop however it came about (trigger ticket_parent_cycle).
    if (isPgError(error, PG.checkViolation)) throw mergeNotAllowed('That merge would form a loop');
    throw error;
  }
  if (!updatedSource || !updatedTarget) throw notFound('No such ticket');

  const targetKey = keys.format(target.number);
  await recordTicketEvent(tx, source.id, TICKET_EVENT_TYPES.merged, ctx.actor, 'public', {
    intoTicketId: target.id,
    intoKey: targetKey,
    ...(input.merge.reason === undefined ? {} : { reason: input.merge.reason }),
  });
  await recordTicketEvent(tx, target.id, TICKET_EVENT_TYPES.mergeReceived, ctx.actor, 'internal', {
    fromTicketId: source.id,
    fromKey: keys.format(source.number),
    movedChildren: children.length,
  });
  // A ticket that moved from the source to the target changed its own parent: it gets its own
  // event (its history says why it points elsewhere now) and its own audit row.
  for (const child of children) {
    await recordTicketEvent(tx, child.id, TICKET_EVENT_TYPES.reparented, ctx.actor, 'internal', {
      fromTicketId: source.id,
      fromKey: keys.format(source.number),
      toTicketId: target.id,
      toKey: targetKey,
      reason: 'parent_merged',
    });
    await recordAuditInTx(tx, ctx, fx, {
      action: AUDIT_ACTIONS.ticketReparent,
      targetType: 'ticket',
      targetId: child.id,
      before: { parentTicketId: source.id },
      after: { parentTicketId: target.id },
      metadata: { mergedTicketId: source.id, intoTicketId: target.id, intoKey: targetKey },
    });
    fx.emit(ticketEvent(ctx, 'ticket.updated', child, ['merge']));
  }
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.ticketMerge,
    targetType: 'ticket',
    targetId: source.id,
    before: ticketSnapshot(source),
    after: ticketSnapshot(updatedSource),
    metadata: { intoTicketId: target.id, intoKey: targetKey, movedChildren: children.length },
  });
  // R-1.5: the customer of the merged ticket is told which ticket carries the conversation now.
  await ctx.notifier.merged(tx, updatedSource, keys.format(source.number), targetKey);
  fx.emit(ticketEvent(ctx, 'ticket.updated', updatedSource, ['status']));
  fx.emit(ticketEvent(ctx, 'ticket.updated', updatedTarget, ['merge']));
  return fx.result({ source: updatedSource, target: updatedTarget });
}
