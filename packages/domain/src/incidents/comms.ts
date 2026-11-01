import { schema, type Database } from '@watchtower/db';
import {
  INCIDENTS_AUDIT_ACTIONS,
  INCIDENT_COMM_CHANNELS,
  draftCommSchema,
  type IncidentCommPreview,
  type RealtimeEvent,
} from '@watchtower/shared';
import { and, asc, eq, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { dbNow } from '../alerts/clock.js';
import { DomainError, badRequest, conflict, notFound } from '../errors.js';
import { replyToTicket } from '../tickets/messages.js';
import {
  Effects,
  type DbTransaction,
  type DomainContext,
  type DomainResult,
  type ReadExecutor,
} from '../types.js';
import { addTimelineEntry } from './timeline.js';

/** Statuses a ticket can no longer be written to; its customer is not told. */
const FINAL_TICKET_STATUSES = ['closed', 'merged'] as const;

/**
 * Who an update would reach: the incident's linked tickets that are still open and sit on a customer
 * channel (Gmail, LINE, the portal). A ticket from a machine or an internal channel is left out, and so
 * is a closed or merged one. One ticket is one recipient (and one message), in a stable order.
 */
export async function incidentCommAudience(
  executor: ReadExecutor,
  incidentId: string,
): Promise<{ readonly ticketIds: string[] } & IncidentCommPreview> {
  const rows = await executor
    .select({ id: schema.ticket.id, channel: schema.ticket.channel, status: schema.ticket.status })
    .from(schema.ticket)
    .where(eq(schema.ticket.incidentId, incidentId))
    .orderBy(asc(schema.ticket.id));
  const ticketIds: string[] = [];
  let skippedChannel = 0;
  let skippedClosed = 0;
  for (const row of rows) {
    if ((FINAL_TICKET_STATUSES as readonly string[]).includes(row.status)) skippedClosed += 1;
    else if (!(INCIDENT_COMM_CHANNELS as readonly string[]).includes(row.channel))
      skippedChannel += 1;
    else ticketIds.push(row.id);
  }
  return { ticketIds, recipients: ticketIds.length, skippedChannel, skippedClosed };
}

export async function previewIncidentComm(
  executor: ReadExecutor,
  incidentId: string,
): Promise<IncidentCommPreview> {
  const { recipients, skippedChannel, skippedClosed } = await incidentCommAudience(
    executor,
    incidentId,
  );
  return { recipients, skippedChannel, skippedClosed };
}

/**
 * Drafts an update for the customers of an incident (R-3.14). A person or the AI may draft; a draft
 * goes nowhere. The system actor cannot draft: there is nobody to answer for the words.
 */
export async function draftIncidentComm(
  tx: DbTransaction,
  ctx: DomainContext,
  input: { readonly incidentId: string; readonly body: string },
): Promise<DomainResult<{ readonly commId: string }>> {
  const fx = new Effects();
  if (ctx.actor.type !== 'user' && ctx.actor.type !== 'ai') {
    throw new DomainError('policy_denied', 'Only a person or the AI can draft an update');
  }
  const parsed = draftCommSchema.safeParse({ body: input.body });
  if (!parsed.success) throw badRequest('The update is not valid');
  const [incident] = await tx
    .select({ id: schema.incident.id })
    .from(schema.incident)
    .where(eq(schema.incident.id, input.incidentId))
    .limit(1);
  if (incident === undefined) throw notFound('No such incident');
  const [comm] = await tx
    .insert(schema.incidentComm)
    .values({
      incidentId: input.incidentId,
      body: parsed.data.body,
      origin: ctx.actor.type === 'ai' ? 'ai' : 'human',
      draftedBy: ctx.actor.type === 'user' ? ctx.actor.id : null,
    })
    .returning({ id: schema.incidentComm.id });
  if (comm === undefined) throw new Error('incident_comm insert returned no row');
  await addTimelineEntry(tx, ctx, input.incidentId, 'comms_drafted', { commId: comm.id });
  await recordAuditInTx(tx, ctx, fx, {
    action: INCIDENTS_AUDIT_ACTIONS.incidentCommDraft,
    targetType: 'incident',
    targetId: input.incidentId,
    metadata: { commId: comm.id, origin: ctx.actor.type === 'ai' ? 'ai' : 'human' },
  });
  return fx.result({ commId: comm.id });
}

export interface SendIncidentCommInput {
  readonly incidentId: string;
  readonly commId: string;
  /** The recipient count the person saw. A different count now means the audience changed: refused. */
  readonly confirmRecipients: number;
}

export interface SendIncidentCommResult {
  readonly recipients: number;
  readonly sent: number;
  readonly failed: number;
  readonly events: RealtimeEvent[];
}

/**
 * Sends a drafted update (R-3.14, N3). Four rules, in the order they bite:
 *
 *  1. **A person presses.** The actor must be a user; the AI and the system are refused whoever drafted
 *     the text, and the table refuses a `sending` or `sent` comm without the person and the count.
 *  2. **The count is confirmed.** `confirmRecipients` must equal the audience now; otherwise 409 and
 *     nothing is sent. The person confirmed what they saw, not what it became.
 *  3. **One ticket at a time, through the normal reply path.** Each ticket gets an ordinary staff reply
 *     from the sender in its own transaction (`tickets.reply`): Gmail and LINE go through the outbound
 *     dispatcher with its undo window, hold and policy gate (ADR-010); the portal shows at once. A
 *     ticket that cannot be answered (closed meanwhile, no channel account) is recorded `failed` with a
 *     stable code, and the others carry on.
 *  4. **Once per ticket, resumable.** `(comm_id, ticket_id)` is unique and claimed before the reply in
 *     the same transaction, so a repeated or resumed send tells no ticket twice. If the process dies
 *     half way the comm stays `sending`; sending it again finishes the rest.
 */
export async function sendIncidentComm(
  db: Database['db'],
  ctx: DomainContext,
  input: SendIncidentCommInput,
): Promise<SendIncidentCommResult> {
  if (ctx.actor.type !== 'user' || ctx.actor.id === null) {
    throw new DomainError('policy_denied', 'Only a person can send an update to customers', {
      reason: 'human_required',
    });
  }
  const senderId = ctx.actor.id;
  const events: RealtimeEvent[] = [];

  // 1 and 2: claim the comm, confirm the audience.
  const plan = await db.transaction(async (tx) => {
    const [comm] = await tx
      .select()
      .from(schema.incidentComm)
      .where(
        and(
          eq(schema.incidentComm.id, input.commId),
          eq(schema.incidentComm.incidentId, input.incidentId),
        ),
      )
      .for('update');
    if (comm === undefined) throw notFound('No such update');
    if (comm.status === 'sent' || comm.status === 'cancelled') {
      throw conflict(`This update is already ${comm.status}`);
    }
    if (comm.status === 'sending') {
      // Resuming: the audience is the one that was confirmed, kept at that moment. A ticket linked
      // since is not in it and does not get the update unconfirmed (T-202 review); whoever resumes
      // confirms the same count.
      const snapshot = comm.recipientTicketIds ?? [];
      if (snapshot.length !== input.confirmRecipients) {
        throw new DomainError(
          'conflict',
          `This update was confirmed for ${String(snapshot.length)} ticket(s), not ${String(input.confirmRecipients)}`,
          { reason: 'recipient_count_mismatch', actual: snapshot.length },
        );
      }
      return { body: comm.body, ticketIds: snapshot };
    }
    const audience = await incidentCommAudience(tx, input.incidentId);
    if (audience.recipients !== input.confirmRecipients) {
      throw new DomainError(
        'conflict',
        `The audience is ${String(audience.recipients)} ticket(s) now, not ${String(input.confirmRecipients)}: look again before sending`,
        { reason: 'recipient_count_mismatch', actual: audience.recipients },
      );
    }
    await tx
      .update(schema.incidentComm)
      .set({
        status: 'sending',
        sentBy: senderId,
        confirmedRecipients: audience.recipients,
        // The audience the person confirmed, kept: a send that is resumed uses these tickets and no others.
        recipientTicketIds: audience.ticketIds,
      })
      .where(eq(schema.incidentComm.id, comm.id));
    return { body: comm.body, ticketIds: audience.ticketIds };
  });

  // 3 and 4: one ticket at a time.
  let sent = 0;
  let failed = 0;
  for (const ticketId of plan.ticketIds) {
    const outcome = await sendOne(db, ctx, senderId, input.commId, ticketId, plan.body, events);
    if (outcome === 'sent') sent += 1;
    else if (outcome === 'failed') failed += 1;
  }

  // Done: count what the deliveries say (a resumed send includes the earlier run).
  await db.transaction(async (tx) => {
    const fx = new Effects();
    const [totals] = await tx
      .select({
        sent: sql<number>`count(*) FILTER (WHERE ${schema.incidentCommDelivery.state} = 'sent')::int`,
        failed: sql<number>`count(*) FILTER (WHERE ${schema.incidentCommDelivery.state} = 'failed')::int`,
      })
      .from(schema.incidentCommDelivery)
      .where(eq(schema.incidentCommDelivery.commId, input.commId));
    await tx
      .update(schema.incidentComm)
      .set({ status: 'sent', sentAt: dbNow })
      .where(
        and(eq(schema.incidentComm.id, input.commId), eq(schema.incidentComm.status, 'sending')),
      );
    await addTimelineEntry(tx, ctx, input.incidentId, 'comms_sent', {
      commId: input.commId,
      recipients: plan.ticketIds.length,
      sent: totals?.sent ?? 0,
      failed: totals?.failed ?? 0,
    });
    await recordAuditInTx(tx, ctx, fx, {
      action: INCIDENTS_AUDIT_ACTIONS.incidentCommSend,
      targetType: 'incident',
      targetId: input.incidentId,
      metadata: {
        commId: input.commId,
        recipients: plan.ticketIds.length,
        sent: totals?.sent ?? 0,
        failed: totals?.failed ?? 0,
      },
    });
  });
  return { recipients: plan.ticketIds.length, sent, failed, events };
}

async function sendOne(
  db: Database['db'],
  ctx: DomainContext,
  senderId: string,
  commId: string,
  ticketId: string,
  body: string,
  events: RealtimeEvent[],
): Promise<'sent' | 'failed' | 'already'> {
  try {
    return await db.transaction(async (tx) => {
      // Claim the ticket first: a concurrent or resumed send finds the row and skips.
      const claimed = await tx
        .insert(schema.incidentCommDelivery)
        .values({ commId, ticketId, state: 'sent' })
        .onConflictDoNothing()
        .returning({ ticketId: schema.incidentCommDelivery.ticketId });
      if (claimed.length === 0) return 'already';
      const result = await replyToTicket(tx, ctx, {
        ref: ticketId,
        reply: { body },
        sender: { kind: 'staff', userId: senderId },
      });
      await tx
        .update(schema.incidentCommDelivery)
        .set({ messageId: result.value.message.id })
        .where(
          and(
            eq(schema.incidentCommDelivery.commId, commId),
            eq(schema.incidentCommDelivery.ticketId, ticketId),
          ),
        );
      events.push(...result.events);
      return 'sent';
    });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    // The reply was refused and its transaction rolled back, claim included: record why, once.
    const detail = error.details?.reason;
    const reason = typeof detail === 'string' ? detail : error.code;
    await db
      .insert(schema.incidentCommDelivery)
      .values({ commId, ticketId, state: 'failed', reason: reason.slice(0, 60) })
      .onConflictDoNothing();
    return 'failed';
  }
}
