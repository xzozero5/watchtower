import { schema } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  SLA_PAUSED_STATUSES,
  TICKET_EVENT_TYPES,
  type TicketStatus,
} from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { scheduleSurvey, voidOpenSurveys } from '../csat/survey.js';
import { invalidTransition, notFound } from '../errors.js';
import type { TicketRow } from '../rows.js';
import { resumeSla } from '../sla.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import { workflowAllows } from '../workflow.js';
import {
  lockTicketRow,
  recordTicketEvent,
  ticketEvent,
  ticketKeysOf,
  ticketSnapshot,
} from './support.js';

export interface StatusOptions {
  readonly reason?: string | undefined;
  /** Automatic transitions (a customer replies) do not depend on the configurable workflow. */
  readonly automatic?: boolean;
  /** The caller sends its own customer email (a staff reply that also sets the status). */
  readonly silent?: boolean;
}

function paused(status: string): boolean {
  return (SLA_PAUSED_STATUSES as readonly string[]).includes(status);
}

/**
 * Moves a locked ticket to `to`. Checks the workflow (unless automatic), keeps the SLA clock
 * (stop on waiting_on_customer, restart with the remaining time), the timestamps and the reopen
 * count, writes a public `ticket.status_changed` event and the audit entry.
 */
export async function applyStatus(
  tx: DbTransaction,
  ctx: DomainContext,
  fx: Effects,
  current: TicketRow,
  to: TicketStatus,
  options: StatusOptions,
): Promise<TicketRow> {
  const from = current.status as TicketStatus;
  if (from === to) throw invalidTransition(`The ticket is already ${to}`);
  if (from === 'merged' || to === 'merged') {
    throw invalidTransition('A ticket becomes merged only by merging it into another ticket');
  }
  if (options.automatic !== true && !(await workflowAllows(tx, from, to))) {
    throw invalidTransition(`A ticket cannot go from ${from} to ${to}`);
  }

  const now = ctx.now();
  const set: Partial<typeof schema.ticket.$inferInsert> = { status: to, updatedAt: now };
  const changed = ['status'];
  const slaEvents: { type: string; payload: Record<string, unknown> }[] = [];

  if (current.slaPausedAt !== null && !paused(to)) {
    const due = await resumeSla(tx, current, current.slaPausedAt, now);
    set.firstResponseDueAt = due.firstResponseDueAt;
    set.resolutionDueAt = due.resolutionDueAt;
    set.slaPausedAt = null;
    changed.push('sla');
    slaEvents.push({
      type: TICKET_EVENT_TYPES.slaResumed,
      payload: {
        pausedAt: current.slaPausedAt.toISOString(),
        resumedAt: now.toISOString(),
        firstResponseDueAt: due.firstResponseDueAt?.toISOString() ?? null,
        resolutionDueAt: due.resolutionDueAt?.toISOString() ?? null,
      },
    });
  } else if (current.slaPausedAt === null && paused(to)) {
    set.slaPausedAt = now;
    changed.push('sla');
    slaEvents.push({ type: TICKET_EVENT_TYPES.slaPaused, payload: { reason: to } });
  }

  let reopened = false;
  if (to === 'resolved') {
    set.resolvedAt = now;
    set.closedAt = null;
  } else if (to === 'closed') {
    set.closedAt = now;
    set.resolvedAt = current.resolvedAt ?? now;
  } else if (from === 'resolved' || from === 'closed') {
    // Leaving a finished state for a working one is a reopen (counted in the reopen rate).
    set.resolvedAt = null;
    set.closedAt = null;
    set.reopenCount = current.reopenCount + 1;
    reopened = true;
  }

  const [after] = await tx
    .update(schema.ticket)
    .set(set)
    .where(eq(schema.ticket.id, current.id))
    .returning();
  if (!after) throw notFound('No such ticket');

  await recordTicketEvent(tx, after.id, TICKET_EVENT_TYPES.statusChanged, ctx.actor, 'public', {
    from,
    to,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(reopened ? { reopened: true } : {}),
  });
  if (reopened) {
    await recordTicketEvent(tx, after.id, TICKET_EVENT_TYPES.reopened, ctx.actor, 'internal', {
      from,
      to,
      reopenCount: after.reopenCount,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });
  }
  for (const event of slaEvents) {
    await recordTicketEvent(tx, after.id, event.type, ctx.actor, 'internal', event.payload);
  }
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.ticketStatusChange,
    targetType: 'ticket',
    targetId: after.id,
    before: ticketSnapshot(current),
    after: ticketSnapshot(after),
    metadata: { from, to, ...(options.automatic === true ? { automatic: true } : {}) },
  });
  // R-10.1: resolving owes the customer a survey after a delay; reopening voids one that is still owed.
  if (to === 'resolved') await scheduleSurvey(tx, ctx, after);
  if (reopened) await voidOpenSurveys(tx, ctx, fx, after.id);
  // Closing is final: the tracking links of the ticket stop working in the same transaction (C-13).
  if (to === 'closed') await ctx.notifier.closeLinks(tx, after.id);
  // Tell the customer of a portal ticket, in the same transaction (ADR-006). Not for a change the
  // customer caused, nor when the caller (a reply that sets the status) sends its own email.
  if (options.automatic !== true && options.silent !== true) {
    await ctx.notifier.statusChange(tx, after, ticketKeysOf(ctx).format(after.number), from, to);
  }
  fx.emit(ticketEvent(ctx, 'ticket.updated', after, changed));
  return after;
}

export interface ChangeStatusInput {
  /** A ticket id or key (`OPS-12`). */
  readonly ref: string;
  readonly status: TicketStatus;
  readonly reason?: string | undefined;
}

/** Moves a ticket to another status. Refuses what the workflow does not allow (R-1.2). */
export async function changeTicketStatus(
  tx: DbTransaction,
  ctx: DomainContext,
  input: ChangeStatusInput,
): Promise<DomainResult<TicketRow>> {
  const fx = new Effects();
  const row = await lockTicketRow(tx, ctx, input.ref);
  const after = await applyStatus(tx, ctx, fx, row, input.status, { reason: input.reason });
  return fx.result(after);
}
