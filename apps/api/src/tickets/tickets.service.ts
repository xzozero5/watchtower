import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  REOPEN_WINDOW_DAYS,
  SLA_PAUSED_STATUSES,
  TICKET_EVENT_TYPES,
  type AssignTicket,
  type ChannelType,
  type MergeTicket,
  type MessageVisibility,
  type Note,
  type RealtimeEvent,
  type Reply,
  type TicketPriority,
  type TicketStatus,
  type UpdateTicket,
} from '@watchtower/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { AuditActor } from '../audit/audit-scope.js';
import { AuditService } from '../audit/audit.service.js';
import {
  badRequest,
  conflict,
  invalidTransition,
  mergeNotAllowed,
  notFound,
  ticketNotOpen,
} from '../auth/http-errors.js';
import { PG, isPgError } from '../common/db-errors.js';
import { IntentsService, type IntentRow } from '../intents/intents.service.js';
import { ContactsService } from '../orgs/contacts.service.js';
import type { DbTransaction, UnitOfWork } from '../realtime/unit-of-work.js';
import { SlaService } from '../sla/sla.service.js';
import { AssignmentService } from '../team-queues/assignment.service.js';
import { assertAssignableStaff } from '../team-queues/team-queues.service.js';
import { TICKET_KEYS, type TicketKeys } from './ticket-keys.js';
import { refCondition, type TicketRow } from './ticket-reader.js';
import { WorkflowService } from './workflow.service.js';

type MessageRow = typeof schema.message.$inferSelect;

/** Who does something: written to the audit log and the ticket event log. */
export type Actor = AuditActor;

export interface CreateTicketCommand {
  readonly actor: Actor;
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

/** The person replying or writing a note. */
export type Sender =
  | { readonly kind: 'staff'; readonly userId: string }
  | {
      readonly kind: 'client';
      readonly userId: string;
      readonly orgId: string;
      readonly email: string;
      readonly name: string;
    };

interface StatusContext {
  readonly actor: Actor;
  readonly reason?: string | undefined;
  /** Automatic transitions (a customer replies) do not depend on the configurable workflow. */
  readonly automatic?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function paused(status: string): boolean {
  return (SLA_PAUSED_STATUSES as readonly string[]).includes(status);
}

/**
 * Where a public message stands when it is saved. A reply on the portal is visible to the customer
 * as soon as it is written. Every other channel needs its adapter to send it: `pending` until the
 * outbox of that adapter (not built yet) delivers it. Something the customer wrote has nothing to
 * deliver.
 */
export function replyDeliveryStatus(
  sender: Sender['kind'],
  channel: string,
): 'not_applicable' | 'pending' | 'delivered' {
  if (sender === 'client') return 'not_applicable';
  return channel === 'portal' ? 'delivered' : 'pending';
}

/** What an audit entry records about a ticket: ids, status and dates, never the text. */
function snapshot(row: TicketRow): Record<string, unknown> {
  return {
    id: row.id,
    number: row.number,
    orgId: row.orgId,
    status: row.status,
    priority: row.priority,
    intentId: row.intentId,
    assigneeId: row.assigneeId,
    queueId: row.queueId,
    slaPolicyId: row.slaPolicyId,
    firstResponseDueAt: row.firstResponseDueAt?.toISOString() ?? null,
    resolutionDueAt: row.resolutionDueAt?.toISOString() ?? null,
    parentTicketId: row.parentTicketId,
  };
}

function ticketEvent(
  keys: TicketKeys,
  type: 'ticket.created' | 'ticket.updated',
  row: TicketRow,
  changed: string[],
): RealtimeEvent {
  return {
    id: randomUUID(),
    type,
    occurredAt: new Date().toISOString(),
    orgId: row.orgId,
    ticketId: row.id,
    ticketKey: keys.format(row.number),
    data: {
      subject: row.subject,
      status: row.status as TicketStatus,
      priority: row.priority as TicketPriority,
      assigneeId: row.assigneeId,
      queueId: row.queueId,
      changed,
    },
  };
}

function messageEvent(keys: TicketKeys, row: TicketRow, message: MessageRow): RealtimeEvent {
  return {
    id: randomUUID(),
    type: 'message.created',
    occurredAt: new Date().toISOString(),
    orgId: row.orgId,
    ticketId: row.id,
    ticketKey: keys.format(row.number),
    data: {
      messageId: message.id,
      direction: message.direction as 'inbound' | 'outbound' | 'internal',
      visibility: message.visibility as MessageVisibility,
    },
  };
}

/**
 * Everything that changes a ticket. Each method runs inside the caller's `UnitOfWork`, so the
 * ticket, its messages, its events and its audit entry commit together, and the realtime events go
 * out only after the commit. The portal channel (T-007) calls `create` in the same transaction as
 * its own work (a signed tracking token, and an email written to the transactional outbox in the
 * same transaction — ADR-006; never an enqueue in `uow.afterCommit`, which is lost if Redis is down).
 */
@Injectable()
export class TicketsService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(IntentsService) private readonly intents: IntentsService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(SlaService) private readonly sla: SlaService,
    @Inject(WorkflowService) private readonly workflow: WorkflowService,
    @Inject(AssignmentService) private readonly assignment: AssignmentService,
    @Inject(TICKET_KEYS) private readonly keys: TicketKeys,
  ) {}

  // --- create ---

  async create(uow: UnitOfWork, command: CreateTicketCommand): Promise<CreateTicketResult> {
    const tx = uow.tx;
    const channel = command.channel ?? 'portal';
    const accountId = command.channelAccountId ?? (await this.channelAccountId(tx, channel));

    if (command.externalId !== undefined) {
      // Two identical submissions at once wait for each other here, so the second sees the first.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${accountId}:${command.externalId}`}, 0))`,
      );
      const existing = await this.findByExternalId(tx, accountId, command.externalId);
      if (existing) return { ...existing, duplicate: true };
    }

    const [org] = await tx
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, command.orgId))
      .limit(1);
    if (!org) throw badRequest('orgId does not refer to an organization');
    if (org.status !== 'active') throw conflict('This organization is inactive');

    const intent = await this.intents.resolve(tx, {
      intentId: command.intentId,
      intentKey: command.intentKey,
    });
    const priority =
      command.priority ?? (intent?.defaultPriority as TicketPriority | undefined) ?? 'P3';

    let contactId: string | null = null;
    if (command.requesterContactId !== undefined) {
      const [contact] = await tx
        .select({ id: schema.contact.id, orgId: schema.contact.orgId })
        .from(schema.contact)
        .where(eq(schema.contact.id, command.requesterContactId))
        .limit(1);
      if (contact?.orgId !== org.id) {
        throw badRequest('requesterContactId is not a contact of this organization');
      }
      contactId = contact.id;
    } else if (command.requester) {
      contactId = (
        await this.contacts.findOrCreateByEmail(
          tx,
          org.id,
          command.requester.email,
          command.requester.name,
          command.actor,
        )
      ).id;
    }

    const queue = await this.resolveQueue(tx, command.queueId);
    let assigneeId: string | null = null;
    let assignedBy: 'manual' | 'round_robin' | null = null;
    if (command.assigneeId !== undefined) {
      await assertAssignableStaff(tx, [command.assigneeId]);
      assigneeId = command.assigneeId;
      assignedBy = 'manual';
    } else if (queue?.assignmentMode === 'round_robin') {
      assigneeId = await this.assignment.nextRoundRobin(tx, queue.id);
      assignedBy = assigneeId === null ? null : 'round_robin';
    }

    const now = new Date();
    const sla = await this.sla.forNewTicket(tx, {
      org: { tier: org.tier, slaPolicyId: org.slaPolicyId },
      intent: intent ? { slaPolicyId: intent.slaPolicyId } : null,
      priority,
      startedAt: now,
    });

    const [ticket] = await tx
      .insert(schema.ticket)
      .values({
        subject: command.subject,
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
        tags: [...(command.tags ?? [])],
        customFields: command.customFields ?? {},
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
        externalId: command.externalId ?? null,
        senderContactId: contactId,
        senderUserId: command.senderUserId ?? null,
        bodyText: command.body,
        visibility: 'public',
        // The customer wrote it to us; there is nothing for us to deliver.
        deliveryStatus: 'not_applicable',
        createdAt: now,
      })
      .returning();
    if (!message) throw new Error('message insert returned no row');

    await this.recordEvent(tx, ticket.id, TICKET_EVENT_TYPES.created, command.actor, 'public', {
      channel,
      priority,
      intentKey: intent?.key ?? null,
    });
    if (assigneeId !== null) {
      await this.recordEvent(
        tx,
        ticket.id,
        TICKET_EVENT_TYPES.assigned,
        command.actor,
        'internal',
        {
          from: null,
          to: assigneeId,
          strategy: assignedBy,
          queueId: queue?.id ?? null,
        },
      );
    }
    await this.audit.recordInTransaction(tx, {
      actor: command.actor,
      action: AUDIT_ACTIONS.ticketCreate,
      targetType: 'ticket',
      targetId: ticket.id,
      after: snapshot(ticket),
      metadata: { channel, messageId: message.id },
    });

    uow.emit(ticketEvent(this.keys, 'ticket.created', ticket, []));
    uow.emit(messageEvent(this.keys, ticket, message));
    return { ticket, message, duplicate: false };
  }

  // --- edit ---

  async update(
    uow: UnitOfWork,
    ref: string,
    patch: UpdateTicket,
    actor: Actor,
  ): Promise<TicketRow> {
    const tx = uow.tx;
    const before = await this.lock(tx, ref);
    if (before.status === 'merged') {
      throw ticketNotOpen('This ticket was merged into another; edit that one');
    }

    const changed: string[] = [];
    const set: Partial<typeof schema.ticket.$inferInsert> = {};
    if (patch.subject !== undefined && patch.subject !== before.subject) {
      set.subject = patch.subject;
      changed.push('subject');
    }
    let intent: IntentRow | null | undefined;
    if (patch.intentId !== undefined && patch.intentId !== before.intentId) {
      intent =
        patch.intentId === null
          ? null
          : await this.intents.resolve(tx, { intentId: patch.intentId });
      set.intentId = intent?.id ?? null;
      changed.push('intent');
    }
    if (patch.queueId !== undefined && patch.queueId !== before.queueId) {
      if (patch.queueId !== null) await this.resolveQueue(tx, patch.queueId);
      set.queueId = patch.queueId;
      changed.push('queue');
    }
    if (patch.tags !== undefined && JSON.stringify(patch.tags) !== JSON.stringify(before.tags)) {
      set.tags = [...patch.tags];
      changed.push('tags');
    }
    if (
      patch.customFields !== undefined &&
      JSON.stringify(patch.customFields) !== JSON.stringify(before.customFields)
    ) {
      set.customFields = patch.customFields;
      changed.push('customFields');
    }
    const priorityChanged = patch.priority !== undefined && patch.priority !== before.priority;
    if (priorityChanged) {
      set.priority = patch.priority;
      changed.push('priority');
    }

    // A new priority, or a new intent that brings a different SLA policy, means new targets. The
    // dates are recomputed from the creation time with the pauses that already ended applied again,
    // so time spent waiting on the customer is not counted as elapsed. A pause that is still running
    // keeps its `slaPausedAt`: resuming shifts the new dates by the whole pause.
    const open = !['resolved', 'closed'].includes(before.status);
    let slaRecalculation: Record<string, unknown> | undefined;
    if (open && (priorityChanged || intent !== undefined)) {
      const priority = (patch.priority ?? before.priority) as TicketPriority;
      let policyId = before.slaPolicyId;
      if (intent !== undefined) {
        const [org] = await tx
          .select({ tier: schema.organization.tier, slaPolicyId: schema.organization.slaPolicyId })
          .from(schema.organization)
          .where(eq(schema.organization.id, before.orgId))
          .limit(1);
        if (org) {
          policyId =
            (
              await this.sla.resolvePolicy(
                tx,
                org,
                intent ? { slaPolicyId: intent.slaPolicyId } : null,
              )
            )?.id ?? null;
        }
      }
      const policyChanged = policyId !== before.slaPolicyId;
      if (priorityChanged || policyChanged) {
        const due = await this.sla.recompute(tx, before, policyId, priority);
        if (policyChanged) set.slaPolicyId = policyId;
        if (before.firstRespondedAt === null) set.firstResponseDueAt = due.firstResponseDueAt;
        set.resolutionDueAt = due.resolutionDueAt;
        changed.push('sla');
        slaRecalculation = {
          reason: [...(priorityChanged ? ['priority'] : []), ...(policyChanged ? ['policy'] : [])],
          ...(priorityChanged ? { priority: { from: before.priority, to: priority } } : {}),
          ...(policyChanged ? { policyId: { from: before.slaPolicyId, to: policyId } } : {}),
          paused: before.slaPausedAt !== null,
          firstResponseDueAt: {
            from: before.firstResponseDueAt?.toISOString() ?? null,
            to: (set.firstResponseDueAt ?? before.firstResponseDueAt)?.toISOString() ?? null,
          },
          resolutionDueAt: {
            from: before.resolutionDueAt?.toISOString() ?? null,
            to: due.resolutionDueAt?.toISOString() ?? null,
          },
        };
      }
    }

    if (changed.length === 0) return before;
    const now = new Date();
    const [after] = await tx
      .update(schema.ticket)
      .set({ ...set, updatedAt: now })
      .where(eq(schema.ticket.id, before.id))
      .returning();
    if (!after) throw notFound('No such ticket');

    await this.recordEvent(tx, after.id, TICKET_EVENT_TYPES.updated, actor, 'internal', {
      changed,
      ...(priorityChanged ? { priority: { from: before.priority, to: after.priority } } : {}),
    });
    if (slaRecalculation) {
      await this.recordEvent(
        tx,
        after.id,
        TICKET_EVENT_TYPES.slaRecalculated,
        actor,
        'internal',
        slaRecalculation,
      );
    }
    await this.audit.recordInTransaction(tx, {
      actor,
      action: AUDIT_ACTIONS.ticketUpdate,
      targetType: 'ticket',
      targetId: after.id,
      before: snapshot(before),
      after: snapshot(after),
      metadata: { changed },
    });
    uow.emit(ticketEvent(this.keys, 'ticket.updated', after, changed));
    return after;
  }

  // --- status ---

  async changeStatus(
    uow: UnitOfWork,
    ref: string,
    status: TicketStatus,
    actor: Actor,
    reason?: string,
  ): Promise<TicketRow> {
    const row = await this.lock(uow.tx, ref);
    return this.applyStatus(uow, row, status, { actor, reason });
  }

  /**
   * Moves a locked ticket to `to`. Checks the workflow (unless automatic), keeps the SLA clock
   * (stop on waiting_on_customer, restart with the remaining time), the timestamps and the reopen
   * count, writes a public `ticket.status_changed` event and the audit entry.
   */
  private async applyStatus(
    uow: UnitOfWork,
    current: TicketRow,
    to: TicketStatus,
    context: StatusContext,
  ): Promise<TicketRow> {
    const tx = uow.tx;
    const from = current.status as TicketStatus;
    if (from === to) throw invalidTransition(`The ticket is already ${to}`);
    if (from === 'merged' || to === 'merged') {
      throw invalidTransition('A ticket becomes merged only by merging it into another ticket');
    }
    if (context.automatic !== true && !(await this.workflow.allows(from, to))) {
      throw invalidTransition(`A ticket cannot go from ${from} to ${to}`);
    }

    const now = new Date();
    const set: Partial<typeof schema.ticket.$inferInsert> = { status: to, updatedAt: now };
    const changed = ['status'];
    const slaEvents: { type: string; payload: Record<string, unknown> }[] = [];

    if (current.slaPausedAt !== null && !paused(to)) {
      const due = await this.sla.resume(tx, current, current.slaPausedAt, now);
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

    await this.recordEvent(
      tx,
      after.id,
      TICKET_EVENT_TYPES.statusChanged,
      context.actor,
      'public',
      {
        from,
        to,
        ...(context.reason === undefined ? {} : { reason: context.reason }),
        ...(reopened ? { reopened: true } : {}),
      },
    );
    if (reopened) {
      await this.recordEvent(tx, after.id, TICKET_EVENT_TYPES.reopened, context.actor, 'internal', {
        from,
        to,
        reopenCount: after.reopenCount,
        ...(context.reason === undefined ? {} : { reason: context.reason }),
      });
    }
    for (const event of slaEvents) {
      await this.recordEvent(tx, after.id, event.type, context.actor, 'internal', event.payload);
    }
    await this.audit.recordInTransaction(tx, {
      actor: context.actor,
      action: AUDIT_ACTIONS.ticketStatusChange,
      targetType: 'ticket',
      targetId: after.id,
      before: snapshot(current),
      after: snapshot(after),
      metadata: { from, to, ...(context.automatic === true ? { automatic: true } : {}) },
    });
    uow.emit(ticketEvent(this.keys, 'ticket.updated', after, changed));
    return after;
  }

  // --- assignment ---

  async assign(
    uow: UnitOfWork,
    ref: string,
    input: AssignTicket,
    actor: Actor,
  ): Promise<TicketRow> {
    const tx = uow.tx;
    const before = await this.lock(tx, ref);
    if (before.status === 'merged') {
      throw ticketNotOpen('This ticket was merged into another; assign that one');
    }

    let queueId = before.queueId;
    if (input.queueId !== undefined) {
      await this.resolveQueue(tx, input.queueId);
      queueId = input.queueId;
    }

    let assigneeId: string | null;
    let strategy: 'manual' | 'round_robin';
    if (input.strategy === 'round_robin') {
      if (queueId === null)
        throw badRequest('The ticket has no queue to take turns in; give queueId');
      // Look at whose turn it is without taking the turn: it is taken below only if the ticket moves.
      assigneeId = await this.assignment.peekRoundRobin(tx, queueId);
      if (assigneeId === null) throw conflict('The queue has no active member to assign to');
      strategy = 'round_robin';
    } else {
      assigneeId = input.assigneeId ?? null;
      if (assigneeId !== null) await assertAssignableStaff(tx, [assigneeId]);
      strategy = 'manual';
    }

    // Nothing changes, so a round-robin turn is not used up: the same member stays next in line.
    if (assigneeId === before.assigneeId && queueId === before.queueId) return before;
    if (strategy === 'round_robin' && queueId !== null && assigneeId !== null) {
      await this.assignment.takeTurn(tx, queueId, assigneeId);
    }
    const [after] = await tx
      .update(schema.ticket)
      .set({ assigneeId, queueId, updatedAt: new Date() })
      .where(eq(schema.ticket.id, before.id))
      .returning();
    if (!after) throw notFound('No such ticket');

    const changed = [
      ...(assigneeId === before.assigneeId ? [] : ['assignee']),
      ...(queueId === before.queueId ? [] : ['queue']),
    ];
    // The history of who held the ticket: one append-only event per change.
    await this.recordEvent(tx, after.id, TICKET_EVENT_TYPES.assigned, actor, 'internal', {
      from: before.assigneeId,
      to: assigneeId,
      strategy,
      queueId,
    });
    await this.audit.recordInTransaction(tx, {
      actor,
      action: AUDIT_ACTIONS.ticketAssign,
      targetType: 'ticket',
      targetId: after.id,
      before: { assigneeId: before.assigneeId, queueId: before.queueId },
      after: { assigneeId, queueId },
      metadata: { strategy },
    });
    uow.emit(ticketEvent(this.keys, 'ticket.updated', after, changed));
    return after;
  }

  // --- merge ---

  /**
   * Merges `ref` (the source) into `into` (the target): the source becomes `merged` and points at
   * the target through `parent_ticket_id`; both keep their messages, and the target's timeline
   * shows the source's history too. Refused when it would cross organizations or form a loop.
   */
  async merge(
    uow: UnitOfWork,
    ref: string,
    input: MergeTicket,
    actor: Actor,
  ): Promise<{ source: TicketRow; target: TicketRow }> {
    const tx = uow.tx;
    // Lock both tickets in id order: two merges that name the same pair, in either direction, queue
    // up instead of each merging into the other.
    const first = await this.idOf(tx, ref);
    const second = await this.idOf(tx, input.intoTicketId);
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
      throw mergeNotAllowed(
        'The target was itself merged into another ticket; merge into that one',
      );
    }
    if (target.status === 'closed') throw mergeNotAllowed('The target ticket is closed');

    // Tickets already merged into the source move to the target, so a chain is never deeper than one.
    const children = await tx
      .update(schema.ticket)
      .set({ parentTicketId: target.id, updatedAt: new Date() })
      .where(eq(schema.ticket.parentTicketId, source.id))
      .returning();

    const now = new Date();
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
      if (isPgError(error, PG.checkViolation))
        throw mergeNotAllowed('That merge would form a loop');
      throw error;
    }
    if (!updatedSource || !updatedTarget) throw notFound('No such ticket');

    const targetKey = this.keys.format(target.number);
    await this.recordEvent(tx, source.id, TICKET_EVENT_TYPES.merged, actor, 'public', {
      intoTicketId: target.id,
      intoKey: targetKey,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    await this.recordEvent(tx, target.id, TICKET_EVENT_TYPES.mergeReceived, actor, 'internal', {
      fromTicketId: source.id,
      fromKey: this.keys.format(source.number),
      movedChildren: children.length,
    });
    // A ticket that moved from the source to the target changed its own parent: it gets its own
    // event (its history says why it points elsewhere now) and its own audit row.
    for (const child of children) {
      await this.recordEvent(tx, child.id, TICKET_EVENT_TYPES.reparented, actor, 'internal', {
        fromTicketId: source.id,
        fromKey: this.keys.format(source.number),
        toTicketId: target.id,
        toKey: targetKey,
        reason: 'parent_merged',
      });
      await this.audit.recordInTransaction(tx, {
        actor,
        action: AUDIT_ACTIONS.ticketReparent,
        targetType: 'ticket',
        targetId: child.id,
        before: { parentTicketId: source.id },
        after: { parentTicketId: target.id },
        metadata: { mergedTicketId: source.id, intoTicketId: target.id, intoKey: targetKey },
      });
      uow.emit(ticketEvent(this.keys, 'ticket.updated', child, ['merge']));
    }
    await this.audit.recordInTransaction(tx, {
      actor,
      action: AUDIT_ACTIONS.ticketMerge,
      targetType: 'ticket',
      targetId: source.id,
      before: snapshot(source),
      after: snapshot(updatedSource),
      metadata: { intoTicketId: target.id, intoKey: targetKey, movedChildren: children.length },
    });
    uow.emit(ticketEvent(this.keys, 'ticket.updated', updatedSource, ['status']));
    uow.emit(ticketEvent(this.keys, 'ticket.updated', updatedTarget, ['merge']));
    return { source: updatedSource, target: updatedTarget };
  }

  // --- messages ---

  /**
   * A public reply. Staff answer the customer (outbound; counts as the first response); a client
   * writes on a ticket of their own organization (inbound). A client's reply restarts a ticket that
   * waits on the customer and reopens one resolved in the last 7 days (R-1.10).
   */
  async reply(
    uow: UnitOfWork,
    ref: string,
    input: Reply,
    sender: Sender,
    actor: Actor,
  ): Promise<{ message: MessageRow; ticket: TicketRow }> {
    const tx = uow.tx;
    let ticket = await this.lock(tx, ref);
    if (sender.kind === 'client' && ticket.orgId !== sender.orgId) throw notFound('No such ticket');
    if (sender.kind === 'client' && input.setStatus !== undefined) {
      throw badRequest('A client cannot set the status');
    }
    if (ticket.status === 'merged') {
      throw ticketNotOpen('This ticket was merged into another; reply there');
    }
    if (ticket.status === 'closed') {
      throw ticketNotOpen('This ticket is closed; open a new one');
    }
    const now = new Date();
    if (
      sender.kind === 'client' &&
      ticket.status === 'resolved' &&
      (ticket.resolvedAt === null ||
        now.getTime() - ticket.resolvedAt.getTime() > REOPEN_WINDOW_DAYS * DAY_MS)
    ) {
      throw ticketNotOpen(
        `This ticket was resolved more than ${String(REOPEN_WINDOW_DAYS)} days ago; open a new one`,
      );
    }

    let contactId: string | null = null;
    if (sender.kind === 'client') {
      contactId = (
        await this.contacts.findOrCreateByEmail(tx, ticket.orgId, sender.email, sender.name, actor)
      ).id;
    }
    const accountId = ticket.channelAccountId;
    const [message] = await tx
      .insert(schema.message)
      .values({
        ticketId: ticket.id,
        channelAccountId: accountId,
        direction: sender.kind === 'client' ? 'inbound' : 'outbound',
        senderUserId: sender.userId,
        senderContactId: contactId,
        bodyText: input.body,
        visibility: 'public',
        deliveryStatus: replyDeliveryStatus(sender.kind, ticket.channel),
        createdAt: now,
      })
      .returning();
    if (!message) throw new Error('message insert returned no row');

    const set: Partial<typeof schema.ticket.$inferInsert> = { updatedAt: now };
    const firstResponse = sender.kind === 'staff' && ticket.firstRespondedAt === null;
    if (firstResponse) set.firstRespondedAt = now;
    const [touched] = await tx
      .update(schema.ticket)
      .set(set)
      .where(eq(schema.ticket.id, ticket.id))
      .returning();
    if (!touched) throw notFound('No such ticket');
    ticket = touched;

    await this.audit.recordInTransaction(tx, {
      actor,
      action: AUDIT_ACTIONS.ticketReply,
      targetType: 'ticket',
      targetId: ticket.id,
      metadata: {
        messageId: message.id,
        direction: message.direction,
        firstResponse,
      },
    });
    uow.emit(messageEvent(this.keys, ticket, message));
    if (firstResponse) uow.emit(ticketEvent(this.keys, 'ticket.updated', ticket, ['sla']));

    if (sender.kind === 'client') {
      // The customer answered: the clock restarts, and a ticket resolved in the last 7 days reopens.
      if (ticket.status === 'waiting_on_customer' || ticket.status === 'resolved') {
        ticket = await this.applyStatus(uow, ticket, 'open', {
          actor,
          reason: 'customer_reply',
          automatic: true,
        });
      }
    } else if (input.setStatus !== undefined && input.setStatus !== ticket.status) {
      // "Reply and set status" (R-1.4). An invalid transition fails the whole request: the reply is not sent.
      ticket = await this.applyStatus(uow, ticket, input.setStatus, { actor });
    }
    return { message, ticket };
  }

  /** An internal note: staff only, never sent, never visible to a client. */
  async note(
    uow: UnitOfWork,
    ref: string,
    input: Note,
    sender: { readonly userId: string },
    actor: Actor,
  ): Promise<{ message: MessageRow; ticket: TicketRow }> {
    const tx = uow.tx;
    const ticket = await this.lock(tx, ref);
    if (ticket.status === 'merged') {
      throw ticketNotOpen('This ticket was merged into another; write the note there');
    }
    const now = new Date();
    const [message] = await tx
      .insert(schema.message)
      .values({
        ticketId: ticket.id,
        channelAccountId: ticket.channelAccountId,
        direction: 'internal',
        senderUserId: sender.userId,
        bodyText: input.body,
        visibility: 'internal',
        deliveryStatus: 'not_applicable',
        createdAt: now,
      })
      .returning();
    if (!message) throw new Error('message insert returned no row');
    const [touched] = await tx
      .update(schema.ticket)
      .set({ updatedAt: now })
      .where(eq(schema.ticket.id, ticket.id))
      .returning();
    await this.audit.recordInTransaction(tx, {
      actor,
      action: AUDIT_ACTIONS.ticketNote,
      targetType: 'ticket',
      targetId: ticket.id,
      metadata: { messageId: message.id },
    });
    // The event says an internal note exists; the realtime filter keeps it from every client.
    uow.emit(messageEvent(this.keys, ticket, message));
    return { message, ticket: touched ?? ticket };
  }

  // --- helpers ---

  /** Loads and locks a ticket for the rest of the transaction. */
  async lock(tx: DbTransaction, ref: string): Promise<TicketRow> {
    const [row] = await tx
      .select()
      .from(schema.ticket)
      .where(refCondition(ref, this.keys))
      .for('update');
    if (!row) throw notFound('No such ticket');
    return row;
  }

  private async idOf(tx: DbTransaction, ref: string): Promise<string> {
    const [row] = await tx
      .select({ id: schema.ticket.id })
      .from(schema.ticket)
      .where(refCondition(ref, this.keys))
      .limit(1);
    if (!row) throw notFound('No such ticket');
    return row.id;
  }

  private async resolveQueue(tx: DbTransaction, queueId: string | undefined) {
    const [queue] =
      queueId === undefined
        ? await tx
            .select()
            .from(schema.teamQueue)
            .where(eq(schema.teamQueue.isDefault, true))
            .limit(1)
        : await tx.select().from(schema.teamQueue).where(eq(schema.teamQueue.id, queueId)).limit(1);
    if (queueId !== undefined && !queue) throw badRequest('queueId does not refer to a queue');
    return queue ?? null;
  }

  private async channelAccountId(tx: DbTransaction, type: ChannelType): Promise<string> {
    const [account] = await tx
      .select({ id: schema.channelAccount.id })
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.type, type))
      .limit(1);
    if (account) return account.id;
    if (type !== 'portal') throw badRequest(`No ${type} channel account is configured`);
    // The portal account is created by migration 0002; recreate it if someone removed it.
    await tx
      .insert(schema.channelAccount)
      .values({ type: 'portal', name: 'Client portal' })
      .onConflictDoNothing();
    const [created] = await tx
      .select({ id: schema.channelAccount.id })
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.type, 'portal'))
      .limit(1);
    if (!created) throw new Error('the portal channel account could not be created');
    return created.id;
  }

  private async findByExternalId(
    tx: DbTransaction,
    accountId: string,
    externalId: string,
  ): Promise<{ ticket: TicketRow; message: MessageRow } | null> {
    const [message] = await tx
      .select()
      .from(schema.message)
      .where(
        and(
          eq(schema.message.channelAccountId, accountId),
          eq(schema.message.externalId, externalId),
        ),
      )
      .limit(1);
    if (!message) return null;
    const [ticket] = await tx
      .select()
      .from(schema.ticket)
      .where(eq(schema.ticket.id, message.ticketId))
      .limit(1);
    return ticket ? { ticket, message } : null;
  }

  private async recordEvent(
    tx: DbTransaction,
    ticketId: string,
    type: string,
    actor: Actor,
    visibility: 'public' | 'internal',
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(schema.ticketEvent).values({
      ticketId,
      type,
      actorType: actor.type,
      actorId: actor.id,
      visibility,
      payload,
    });
  }
}
