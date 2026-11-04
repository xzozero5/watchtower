import { schema } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  PROCEDURE_TICKET_EVENTS,
  escalateTargetSchema,
  stepIdSchema,
  ticketPrioritySchema,
  type ProcedureProposal,
  type ProcedureProposalApplied,
  type TicketPriority,
} from '@watchtower/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { conflict, notFound } from '../errors.js';
import { notifyIn } from '../notifications.js';
import { addTicketNote } from '../tickets/messages.js';
import { lockTicketRow, recordTicketEvent } from '../tickets/support.js';
import { updateTicket } from '../tickets/update.js';
import {
  Effects,
  type DbTransaction,
  type DomainContext,
  type DomainResult,
  type ReadExecutor,
} from '../types.js';
import { readPublishedProcedure } from './runtime.js';

/**
 * What a person's click on an escalation card does (T-303f, ADR-026 sections 7 and 10). The card is the
 * `procedure.escalation_proposed` ticket event the investigation left; this runs the proposal with the existing
 * services (`updateTicket`, `addTicketNote`, `notifyIn`) as the person who pressed, so their rules and audit rows
 * apply, and adds one `procedure.escalation_applied` event and audit row with `via: 'procedure'`.
 */

interface ProposalPayload {
  readonly stepId: string;
  readonly versionId: string;
  readonly to: { readonly queueKey: string } | { readonly role: 'lead' | 'head' };
  readonly priority?: TicketPriority;
  readonly note: string;
}

function readPayload(raw: unknown): ProposalPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const stepId = stepIdSchema.safeParse(value.stepId);
  const to = escalateTargetSchema.safeParse(value.to);
  const priority = ticketPrioritySchema.safeParse(value.priority);
  if (!stepId.success || !to.success || typeof value.versionId !== 'string') return null;
  return {
    stepId: stepId.data,
    versionId: value.versionId,
    to: to.data,
    ...(priority.success ? { priority: priority.data } : {}),
    note: typeof value.note === 'string' ? value.note : '',
  };
}

/** Closed for good: nothing more is done on it, so a card on it is stale. */
const DONE_STATUSES = ['resolved', 'closed', 'merged'];

/**
 * The escalation cards of a ticket, oldest first: pending, applied, or expired (the procedure the intent runs now
 * is not the one that proposed it, or the ticket is done).
 */
export async function readProcedureProposals(
  db: ReadExecutor,
  ticketId: string,
): Promise<ProcedureProposal[]> {
  const [ticket] = await db
    .select({ status: schema.ticket.status, intentId: schema.ticket.intentId })
    .from(schema.ticket)
    .where(eq(schema.ticket.id, ticketId))
    .limit(1);
  if (ticket === undefined) return [];
  const events = await db
    .select()
    .from(schema.ticketEvent)
    .where(
      and(
        eq(schema.ticketEvent.ticketId, ticketId),
        inArray(schema.ticketEvent.type, [
          PROCEDURE_TICKET_EVENTS.procedureEscalationProposed,
          PROCEDURE_TICKET_EVENTS.procedureEscalationApplied,
        ]),
      ),
    )
    .orderBy(asc(schema.ticketEvent.createdAt));
  const applied = new Map<string, Date>();
  for (const event of events) {
    if (event.type !== PROCEDURE_TICKET_EVENTS.procedureEscalationApplied) continue;
    const id = (event.payload as Record<string, unknown>).proposalId;
    if (typeof id === 'string' && !applied.has(id)) applied.set(id, event.createdAt);
  }
  const live = ticket.intentId === null ? null : await readPublishedProcedure(db, ticket.intentId);
  const items: ProcedureProposal[] = [];
  for (const event of events) {
    if (event.type !== PROCEDURE_TICKET_EVENTS.procedureEscalationProposed) continue;
    const payload = readPayload(event.payload);
    if (payload === null) continue;
    const appliedAt = applied.get(event.id);
    const expiredReason = DONE_STATUSES.includes(ticket.status)
      ? ('ticket_closed' as const)
      : live?.versionId !== payload.versionId
        ? ('version_changed' as const)
        : undefined;
    items.push({
      id: event.id,
      stepId: payload.stepId,
      versionId: payload.versionId,
      to: payload.to,
      ...(payload.priority === undefined ? {} : { priority: payload.priority }),
      note: payload.note,
      // A card already pressed stays "applied" even after the ticket closes or the version moves on.
      status:
        appliedAt !== undefined ? 'applied' : expiredReason !== undefined ? 'expired' : 'pending',
      ...(appliedAt === undefined && expiredReason !== undefined ? { expiredReason } : {}),
      createdAt: event.createdAt.toISOString(),
      ...(appliedAt === undefined ? {} : { appliedAt: appliedAt.toISOString() }),
    });
  }
  return items;
}

export interface ApplyEscalationInput {
  /** A ticket id or key. */
  readonly ref: string;
  /** The id of the `procedure.escalation_proposed` event. */
  readonly proposalId: string;
}

/** Who hears a request for a lead or head: those of the role on shift now; every active one when nobody is. */
async function recipientsOfRole(
  tx: DbTransaction,
  role: 'lead' | 'head',
): Promise<readonly string[]> {
  const onShift = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.shiftSession, eq(schema.shiftSession.userId, schema.users.id))
    .where(
      and(
        eq(schema.users.role, role),
        eq(schema.users.status, 'active'),
        isNull(schema.shiftSession.clockedOutAt),
      ),
    );
  if (onShift.length > 0) return onShift.map((row) => row.id);
  const all = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.role, role), eq(schema.users.status, 'active')));
  return all.map((row) => row.id);
}

/**
 * Presses the card. Idempotent: a card already applied answers the same without doing it again. Refused (409) when
 * the ticket is done or the procedure that proposed it is no longer the live one, (404) when there is no such card.
 * The caller holds `ticket.handle` (the route checks it).
 */
export async function applyProcedureEscalation(
  tx: DbTransaction,
  ctx: DomainContext,
  input: ApplyEscalationInput,
): Promise<DomainResult<ProcedureProposalApplied>> {
  const fx = new Effects();
  const ticket = await lockTicketRow(tx, ctx, input.ref);
  const [event] = await tx
    .select()
    .from(schema.ticketEvent)
    .where(
      and(
        eq(schema.ticketEvent.id, input.proposalId),
        eq(schema.ticketEvent.ticketId, ticket.id),
        eq(schema.ticketEvent.type, PROCEDURE_TICKET_EVENTS.procedureEscalationProposed),
      ),
    )
    .limit(1);
  const payload = event === undefined ? null : readPayload(event.payload);
  if (payload === null) throw notFound('No such escalation card on this ticket');

  const [done] = await tx
    .select({ payload: schema.ticketEvent.payload })
    .from(schema.ticketEvent)
    .where(
      and(
        eq(schema.ticketEvent.ticketId, ticket.id),
        eq(schema.ticketEvent.type, PROCEDURE_TICKET_EVENTS.procedureEscalationApplied),
        sql`${schema.ticketEvent.payload}->>'proposalId' = ${input.proposalId}`,
      ),
    )
    .limit(1);
  if (done !== undefined) {
    const before = done.payload as Record<string, unknown>;
    // Nothing happened on this press: the request writes no second audit row for it.
    fx.audited = true;
    return fx.result({
      proposalId: input.proposalId,
      alreadyApplied: true,
      action: 'queueKey' in payload.to ? 'moved_queue' : 'asked_role',
      notified: typeof before.notified === 'number' ? before.notified : 0,
      ...(payload.priority === undefined ? {} : { priority: payload.priority }),
    });
  }

  if (DONE_STATUSES.includes(ticket.status)) {
    throw conflict('The ticket is closed: this escalation card has expired');
  }
  const live = ticket.intentId === null ? null : await readPublishedProcedure(tx, ticket.intentId);
  if (live?.versionId !== payload.versionId) {
    throw conflict('The procedure changed since this card was made: it has expired');
  }

  let notified = 0;
  let action: ProcedureProposalApplied['action'];
  if ('queueKey' in payload.to) {
    action = 'moved_queue';
    const [queue] = await tx
      .select({ id: schema.teamQueue.id })
      .from(schema.teamQueue)
      .where(sql`lower(${schema.teamQueue.name}) = ${payload.to.queueKey.toLowerCase()}`)
      .limit(1);
    if (queue === undefined) throw conflict(`No team queue named ${payload.to.queueKey}`);
    // The assignee stays: the people of the new queue assign again themselves.
    const moved = await updateTicket(tx, ctx, {
      ref: ticket.id,
      patch: {
        queueId: queue.id,
        ...(payload.priority === undefined ? {} : { priority: payload.priority }),
      },
      origin: { source: 'procedure' },
    });
    fx.events.push(...moved.events);
    fx.audited = fx.audited || moved.audited;
  } else {
    action = 'asked_role';
    if (payload.priority !== undefined) {
      const raised = await updateTicket(tx, ctx, {
        ref: ticket.id,
        patch: { priority: payload.priority },
        origin: { source: 'procedure' },
      });
      fx.events.push(...raised.events);
    }
    const recipients = (await recipientsOfRole(tx, payload.to.role)).filter(
      (id) => id !== ctx.actor.id,
    );
    notified = await notifyIn(tx, ctx, fx, {
      kind: 'ticket.escalation_requested',
      severity: 'high',
      recipients,
      dedupeKey: `procedure.escalation:${input.proposalId}`,
      ticket,
      data: { role: payload.to.role },
    });
    if (ctx.actor.type === 'user' && ctx.actor.id !== null) {
      const body =
        payload.note.trim() === ''
          ? `Procedure step ${payload.stepId}: ${payload.to.role} asked to look at this ticket.`
          : `Procedure step ${payload.stepId}: ${payload.to.role} asked to look at this ticket. ${payload.note}`;
      const note = await addTicketNote(tx, ctx, {
        ref: ticket.id,
        note: { body },
        sender: { userId: ctx.actor.id },
      });
      fx.events.push(...note.events);
    }
  }

  await recordTicketEvent(
    tx,
    ticket.id,
    PROCEDURE_TICKET_EVENTS.procedureEscalationApplied,
    ctx.actor,
    'internal',
    {
      proposalId: input.proposalId,
      stepId: payload.stepId,
      versionId: payload.versionId,
      action,
      notified,
    },
  );
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.procedureEscalationApplied,
    targetType: 'ticket',
    targetId: ticket.id,
    metadata: {
      via: 'procedure',
      proposalId: input.proposalId,
      stepId: payload.stepId,
      versionId: payload.versionId,
      action,
      notified,
    },
  });
  return fx.result({
    proposalId: input.proposalId,
    alreadyApplied: false,
    action,
    notified,
    ...(payload.priority === undefined ? {} : { priority: payload.priority }),
  });
}
