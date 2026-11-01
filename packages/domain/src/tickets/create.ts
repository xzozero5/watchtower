import { schema } from '@watchtower/db';
import {
  AI_JOBS,
  AI_OUTBOX_JOB_OPTIONS,
  AUDIT_ACTIONS,
  QUEUE_NAMES,
  TICKET_EVENT_TYPES,
  type ChannelType,
  type TicketPriority,
} from '@watchtower/shared';
import { eq, sql } from 'drizzle-orm';

import {
  assertAssignableStaff,
  isAssignStrategy,
  nextAssignee,
  type AssignStrategy,
} from '../assignment.js';
import { recordAuditInTx } from '../audit.js';
import { findOrCreateContactByEmailIn } from '../contacts.js';
import { badRequest, conflict } from '../errors.js';
import { enqueueJob } from '../outbox.js';
import { resolveIntent } from '../intents.js';
import type { MessageRow, TicketRow } from '../rows.js';
import { slaForNewTicket } from '../sla.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import {
  MESSAGE_CLOCK,
  channelAccountIdOf,
  findByExternalId,
  messageEvent,
  recordTicketEvent,
  resolveQueue,
  ticketEvent,
  ticketSnapshot,
} from './support.js';

export interface CreateTicketInput {
  readonly orgId: string;
  readonly subject: string;
  /** The first message of the ticket, as the customer wrote it. */
  readonly body: string;
  /** Default `portal`, the only channel of Phase 0. */
  readonly channel?: ChannelType;
  /** Default: the account of the channel (the portal has exactly one). */
  readonly channelAccountId?: string;
  /**
   * The provider's id of the first message (a portal submission id). Submitting the same id again
   * returns the ticket that already exists instead of creating another (idempotent ingestion).
   */
  readonly externalId?: string;
  readonly requesterContactId?: string;
  /** Conversation key stored on the first message (`gmail:<threadId>`, `line:<id>`): thread matching reads it. */
  readonly threadKey?: string;
  /** Sanitised HTML of the first message, when the channel has one. */
  readonly bodyHtml?: string;
  /** Attachment references of the first message (objects already in storage). */
  readonly attachments?: readonly Record<string, unknown>[];
  /** Finds the organization's contact by address, or creates it. */
  readonly requester?: { readonly email: string; readonly name: string };
  /** The signed-in client user who wrote the message, if any. */
  readonly senderUserId?: string;
  readonly intentId?: string;
  readonly intentKey?: string;
  readonly priority?: TicketPriority;
  readonly queueId?: string;
  readonly assigneeId?: string;
  readonly tags?: readonly string[];
  readonly customFields?: Record<string, unknown>;
}

export interface CreateTicketResult {
  readonly ticket: TicketRow;
  readonly message: MessageRow;
  /** True when `externalId` had been submitted before and nothing new was written. */
  readonly duplicate: boolean;
}

/**
 * Opens a ticket with its first message: finds or creates the requester, files it under an intent,
 * picks the queue and assignee (manual, or round-robin when the queue says so), starts the SLA
 * clock, and writes the ticket, the message, the event log and the audit row in the caller's
 * transaction. The same path serves the staff API and the portal (staff and portal paths differ
 * only in `ctx.actor` and the inputs they give).
 */
export async function createTicket(
  tx: DbTransaction,
  ctx: DomainContext,
  input: CreateTicketInput,
): Promise<DomainResult<CreateTicketResult>> {
  const fx = new Effects();
  const channel = input.channel ?? 'portal';
  const accountId = input.channelAccountId ?? (await channelAccountIdOf(tx, channel));

  if (input.externalId !== undefined) {
    // Two identical submissions at once wait for each other here, so the second sees the first.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${accountId}:${input.externalId}`}, 0))`,
    );
    const existing = await findByExternalId(tx, accountId, input.externalId);
    if (existing) return fx.result({ ...existing, duplicate: true });
  }

  const [org] = await tx
    .select()
    .from(schema.organization)
    .where(eq(schema.organization.id, input.orgId))
    .limit(1);
  if (!org) throw badRequest('orgId does not refer to an organization');
  if (org.status !== 'active') throw conflict('This organization is inactive');

  const intent = await resolveIntent(tx, {
    intentId: input.intentId,
    intentKey: input.intentKey,
  });
  const priority =
    input.priority ?? (intent?.defaultPriority as TicketPriority | undefined) ?? 'P3';

  let contactId: string | null = null;
  if (input.requesterContactId !== undefined) {
    const [contact] = await tx
      .select({ id: schema.contact.id, orgId: schema.contact.orgId })
      .from(schema.contact)
      .where(eq(schema.contact.id, input.requesterContactId))
      .limit(1);
    if (contact?.orgId !== org.id) {
      throw badRequest('requesterContactId is not a contact of this organization');
    }
    contactId = contact.id;
  } else if (input.requester) {
    contactId = (
      await findOrCreateContactByEmailIn(tx, ctx, fx, {
        orgId: org.id,
        email: input.requester.email,
        name: input.requester.name,
      })
    ).id;
  }

  const queue = await resolveQueue(tx, input.queueId);
  let assigneeId: string | null = null;
  let assignedBy: 'manual' | AssignStrategy | null = null;
  if (input.assigneeId !== undefined) {
    await assertAssignableStaff(tx, [input.assigneeId]);
    assigneeId = input.assigneeId;
    assignedBy = 'manual';
  } else if (queue !== null && isAssignStrategy(queue.assignmentMode)) {
    // Only people who are clocked in are candidates; nobody clocked in leaves the ticket unassigned.
    assigneeId = await nextAssignee(tx, queue.id, queue.assignmentMode, {
      requesterContactId: contactId,
    });
    assignedBy = assigneeId === null ? null : queue.assignmentMode;
  }

  const now = ctx.now();
  const sla = await slaForNewTicket(tx, {
    org: { tier: org.tier, slaPolicyId: org.slaPolicyId },
    intent: intent ? { slaPolicyId: intent.slaPolicyId } : null,
    priority,
    startedAt: now,
  });

  const [ticket] = await tx
    .insert(schema.ticket)
    .values({
      subject: input.subject,
      orgId: org.id,
      requesterContactId: contactId,
      channelAccountId: accountId,
      channel,
      intentId: intent?.id ?? null,
      priority,
      status: 'new',
      assigneeId,
      queueId: queue?.id ?? null,
      slaPolicyId: sla.policyId,
      firstResponseDueAt: sla.firstResponseDueAt,
      resolutionDueAt: sla.resolutionDueAt,
      tags: [...(input.tags ?? [])],
      customFields: input.customFields ?? {},
      // What the intent's autonomy stage was when the ticket arrived (N3); nothing acts on it in Phase 0.
      autonomyStageAtCreation: intent?.autonomyStage ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!ticket) throw new Error('ticket insert returned no row');

  const [message] = await tx
    .insert(schema.message)
    .values({
      ticketId: ticket.id,
      channelAccountId: accountId,
      direction: 'inbound',
      externalId: input.externalId ?? null,
      threadKey: input.threadKey ?? null,
      senderContactId: contactId,
      senderUserId: input.senderUserId ?? null,
      bodyText: input.body,
      bodyHtml: input.bodyHtml ?? null,
      attachments: [...(input.attachments ?? [])],
      visibility: 'public',
      // The customer wrote it to us; there is nothing for us to deliver.
      deliveryStatus: 'not_applicable',
      createdAt: MESSAGE_CLOCK,
    })
    .returning();
  if (!message) throw new Error('message insert returned no row');

  await recordTicketEvent(tx, ticket.id, TICKET_EVENT_TYPES.created, ctx.actor, 'public', {
    channel,
    priority,
    intentKey: intent?.key ?? null,
  });
  if (assigneeId !== null) {
    await recordTicketEvent(tx, ticket.id, TICKET_EVENT_TYPES.assigned, ctx.actor, 'internal', {
      from: null,
      to: assigneeId,
      strategy: assignedBy,
      queueId: queue?.id ?? null,
    });
  }
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.ticketCreate,
    targetType: 'ticket',
    targetId: ticket.id,
    after: ticketSnapshot(ticket),
    metadata: { channel, messageId: message.id },
  });

  // The AI brief (classify + summarize) is made after the commit, by the worker (T-106e). The job
  // is in the transactional outbox, so it exists if and only if the ticket does; the job id makes
  // it one job per ticket.
  await enqueueJob(tx, ctx.config, {
    queue: QUEUE_NAMES.ai,
    name: AI_JOBS.summarize,
    jobId: `ai-summarize-${ticket.id}`,
    payload: { ticketId: ticket.id },
    options: AI_OUTBOX_JOB_OPTIONS,
  });

  fx.emit(ticketEvent(ctx, 'ticket.created', ticket, []));
  fx.emit(messageEvent(ctx, ticket, message));
  return fx.result({ ticket, message, duplicate: false });
}
