import { randomUUID } from 'node:crypto';

import {
  AUDIT_ACTIONS,
  REOPEN_WINDOW_DAYS,
  SLA_PAUSED_STATUSES,
  TICKET_EVENT_TYPES,
  computeSlaDueDates,
  resumeDueAfterPause,
  type BusinessCalendar,
  type SlaTargets,
  type TicketPriority,
  type TicketStatus,
} from '@watchtower/shared';

import type { auditLog } from '../schema/audit.js';
import type { message, ticket, ticketEvent } from '../schema/ticketing.js';
import { SeedError } from './common.js';
import type { OrgKey, QueueKey, StaffKey, Step, TicketSpec } from './demo-data.js';

/**
 * Plays a ticket script (`demo-data.ts`) the way the API would, without a database: it keeps the
 * same state the services keep (status, assignee, SLA pause and due dates, reopen count) and emits
 * the rows that go with each step (message, ticket event, audit entry). Pure and deterministic given
 * its context, so the unit tests can check every script, and the insert code stays trivial.
 *
 * It mirrors apps/api/src/tickets/tickets.service.ts on purpose; the integration test recomputes
 * every due date with `computeSlaDueDates` to catch drift.
 */

type TicketInsert = typeof ticket.$inferInsert;
type MessageInsert = typeof message.$inferInsert;
type EventInsert = typeof ticketEvent.$inferInsert;
type AuditInsert = typeof auditLog.$inferInsert;

export interface PlanPolicy {
  readonly id: string;
  readonly targets: SlaTargets;
  readonly calendar: BusinessCalendar;
}

export interface PlanContext {
  readonly now: Date;
  /** Nothing is dated before this (the first monthly partition that exists). */
  readonly floor: Date;
  readonly channelAccountId: string;
  readonly orgs: Readonly<
    Record<OrgKey, { id: string; policy: PlanPolicy | null; clientUserId: string }>
  >;
  readonly contactId: (org: OrgKey, index: number) => string;
  readonly staff: Readonly<Record<StaffKey, string>>;
  readonly queues: Readonly<Record<QueueKey, string>>;
  readonly intents: ReadonlyMap<
    string,
    { id: string; key: string; defaultPriority: string; autonomyStage: number }
  >;
}

export interface PlannedTicket {
  readonly spec: TicketSpec;
  readonly id: string;
  readonly ticket: TicketInsert;
  readonly messages: MessageInsert[];
  readonly events: EventInsert[];
  readonly audits: AuditInsert[];
  /** Status after the last step, before any merge. */
  readonly status: TicketStatus;
  /** When the last step happened; the merge, if any, comes after. */
  readonly lastAt: Date;
  /** 1 unless the script was compressed to fit; the merge wait is scaled the same way. */
  readonly scale: number;
}

const MINUTE = 60_000;
const DAY_MS = 24 * 60 * MINUTE;

function isPaused(status: string): boolean {
  return (SLA_PAUSED_STATUSES as readonly string[]).includes(status);
}

/** Time that only moves forward, never before `floor` and never past `now`. */
class Clock {
  constructor(
    private current: Date,
    private readonly now: Date,
    private readonly label: string,
    /** Shrinks every wait when the floor moved the creation date forward and the script no longer fits. */
    readonly scale: number,
  ) {}

  get at(): Date {
    return this.current;
  }

  advance(minutes: number): Date {
    const next = new Date(this.current.getTime() + Math.max(minutes * this.scale * MINUTE, 1000));
    if (next.getTime() > this.now.getTime()) {
      throw new SeedError(
        `ticket ${this.label}: its steps run past the moment the seed started; raise ageHours`,
      );
    }
    this.current = next;
    return next;
  }
}

export function planTicket(spec: TicketSpec, context: PlanContext): PlannedTicket {
  const org = context.orgs[spec.org];
  const intent = context.intents.get(spec.intent);
  if (!intent) throw new SeedError(`ticket ${spec.key}: unknown intent "${spec.intent}"`);
  const priority = (spec.priority ?? intent.defaultPriority) as TicketPriority;

  const wanted = context.now.getTime() - spec.ageHours * 60 * MINUTE;
  const createdAt = new Date(Math.max(wanted, context.floor.getTime()));
  // A script that no longer fits between the (clamped) creation date and now is compressed, keeping
  // the order of its steps; a minute of slack is left before now for the merge.
  const scriptMinutes =
    spec.steps.reduce((total, step) => total + step.afterMin, 0) + (spec.mergeInto?.afterMin ?? 0);
  const availableMs = context.now.getTime() - createdAt.getTime() - MINUTE;
  const scale =
    scriptMinutes * MINUTE > availableMs ? Math.max(availableMs, 0) / (scriptMinutes * MINUTE) : 1;
  const clock = new Clock(createdAt, context.now, spec.key, scale);

  const id = randomUUID();
  const contactId = context.contactId(spec.org, spec.contact);
  const queueId = context.queues[spec.queue];
  const clientActor = { type: 'user', id: org.clientUserId } as const;
  const staffActor = (key: StaffKey) => ({ type: 'user', id: context.staff[key] }) as const;

  const due = org.policy
    ? computeSlaDueDates({
        startedAt: createdAt,
        priority,
        targets: org.policy.targets,
        calendar: org.policy.calendar,
      })
    : { firstResponseDueAt: null, resolutionDueAt: null };

  // The mutable state of the ticket, as the service would hold it.
  const state = {
    status: 'new' as TicketStatus,
    assigneeId: null as string | null,
    firstRespondedAt: null as Date | null,
    resolvedAt: null as Date | null,
    closedAt: null as Date | null,
    reopenCount: 0,
    slaPausedAt: null as Date | null,
    firstResponseDueAt: due.firstResponseDueAt,
    resolutionDueAt: due.resolutionDueAt,
    updatedAt: createdAt,
  };

  const messages: MessageInsert[] = [];
  const events: EventInsert[] = [];
  const audits: AuditInsert[] = [];

  const snapshot = (): Record<string, unknown> => ({
    id,
    orgId: org.id,
    status: state.status,
    priority,
    intentId: intent.id,
    assigneeId: state.assigneeId,
    queueId,
    slaPolicyId: org.policy?.id ?? null,
    firstResponseDueAt: state.firstResponseDueAt?.toISOString() ?? null,
    resolutionDueAt: state.resolutionDueAt?.toISOString() ?? null,
  });
  const event = (
    at: Date,
    type: string,
    actor: { type: 'user' | 'system'; id: string | null },
    visibility: 'public' | 'internal',
    payload: Record<string, unknown>,
  ): void => {
    events.push({
      ticketId: id,
      createdAt: at,
      type,
      actorType: actor.type,
      actorId: actor.id,
      visibility,
      payload,
    });
  };
  const audit = (
    at: Date,
    action: string,
    actor: { type: 'user' | 'system'; id: string | null },
    fields: Pick<AuditInsert, 'before' | 'after' | 'metadata'>,
  ): void => {
    audits.push({
      createdAt: at,
      actorType: actor.type,
      actorId: actor.id,
      action,
      outcome: 'success',
      targetType: 'ticket',
      targetId: id,
      ...fields,
      metadata: { seed: true, ...(fields.metadata ?? {}) },
    });
  };

  // --- creation ---
  messages.push({
    ticketId: id,
    channelAccountId: context.channelAccountId,
    direction: 'inbound',
    externalId: `seed-${spec.key}`,
    senderContactId: contactId,
    bodyText: spec.body,
    visibility: 'public',
    deliveryStatus: 'not_applicable',
    createdAt,
  });
  event(createdAt, TICKET_EVENT_TYPES.created, clientActor, 'public', {
    channel: 'portal',
    priority,
    intentKey: intent.key,
  });

  const applyStatus = (
    to: TicketStatus,
    actor: typeof clientActor,
    reason?: string,
    automatic = false,
  ) => {
    const at = clock.at;
    const before = snapshot();
    const from = state.status;
    const slaEvents: { type: string; payload: Record<string, unknown> }[] = [];

    if (state.slaPausedAt !== null && !isPaused(to)) {
      const mode = org.policy?.targets[priority]?.calendar ?? 'business';
      const shift = (date: Date | null): Date | null =>
        date === null || org.policy === null
          ? date
          : resumeDueAfterPause({
              pausedAt: state.slaPausedAt as Date,
              resumedAt: at,
              due: date,
              mode,
              calendar: org.policy.calendar,
            });
      const pausedAt = state.slaPausedAt;
      state.firstResponseDueAt = shift(state.firstResponseDueAt);
      state.resolutionDueAt = shift(state.resolutionDueAt);
      state.slaPausedAt = null;
      slaEvents.push({
        type: TICKET_EVENT_TYPES.slaResumed,
        payload: {
          pausedAt: pausedAt.toISOString(),
          resumedAt: at.toISOString(),
          firstResponseDueAt: state.firstResponseDueAt?.toISOString() ?? null,
          resolutionDueAt: state.resolutionDueAt?.toISOString() ?? null,
        },
      });
    } else if (state.slaPausedAt === null && isPaused(to)) {
      state.slaPausedAt = at;
      slaEvents.push({ type: TICKET_EVENT_TYPES.slaPaused, payload: { reason: to } });
    }

    let reopened = false;
    if (to === 'resolved') {
      state.resolvedAt = at;
      state.closedAt = null;
    } else if (to === 'closed') {
      state.closedAt = at;
      state.resolvedAt = state.resolvedAt ?? at;
    } else if (from === 'resolved' || from === 'closed') {
      state.resolvedAt = null;
      state.closedAt = null;
      state.reopenCount += 1;
      reopened = true;
    }
    state.status = to;
    state.updatedAt = at;

    event(at, TICKET_EVENT_TYPES.statusChanged, actor, 'public', {
      from,
      to,
      ...(reason === undefined ? {} : { reason }),
      ...(reopened ? { reopened: true } : {}),
    });
    if (reopened) {
      event(at, TICKET_EVENT_TYPES.reopened, actor, 'internal', {
        from,
        to,
        reopenCount: state.reopenCount,
        ...(reason === undefined ? {} : { reason }),
      });
    }
    for (const slaEvent of slaEvents) event(at, slaEvent.type, actor, 'internal', slaEvent.payload);
    audit(at, AUDIT_ACTIONS.ticketStatusChange, actor, {
      before,
      after: snapshot(),
      metadata: { from, to, ...(automatic ? { automatic: true } : {}) },
    });
  };

  // The audit row of the creation is written last-known-state-first, like the service does.
  audit(createdAt, AUDIT_ACTIONS.ticketCreate, clientActor, {
    after: snapshot(),
    metadata: { channel: 'portal' },
  });

  // --- the script ---
  const play = (step: Step): void => {
    const at = clock.advance(step.afterMin);
    switch (step.do) {
      case 'assign': {
        const actor = staffActor('lead1');
        const to = step.to === null ? null : context.staff[step.to];
        const before = { assigneeId: state.assigneeId, queueId };
        state.assigneeId = to;
        state.updatedAt = at;
        event(at, TICKET_EVENT_TYPES.assigned, actor, 'internal', {
          from: before.assigneeId,
          to,
          strategy: 'manual',
          queueId,
        });
        audit(at, AUDIT_ACTIONS.ticketAssign, actor, {
          before,
          after: { assigneeId: to, queueId },
          metadata: { strategy: 'manual' },
        });
        return;
      }
      case 'status': {
        applyStatus(
          step.to,
          state.assigneeId === null ? staffActor('lead1') : { type: 'user', id: state.assigneeId },
          step.reason,
        );
        return;
      }
      case 'reply': {
        const actor = staffActor(step.by);
        const firstResponse = state.firstRespondedAt === null;
        const row: MessageInsert = {
          ticketId: id,
          channelAccountId: context.channelAccountId,
          direction: 'outbound',
          senderUserId: context.staff[step.by],
          bodyText: step.body,
          visibility: 'public',
          // A reply on the portal is visible to the customer as soon as it is written.
          deliveryStatus: 'delivered',
          createdAt: at,
        };
        messages.push(row);
        if (firstResponse) state.firstRespondedAt = at;
        state.updatedAt = at;
        audit(at, AUDIT_ACTIONS.ticketReply, actor, {
          metadata: { direction: 'outbound', firstResponse },
        });
        if (step.setStatus !== undefined && step.setStatus !== state.status) {
          applyStatus(step.setStatus, actor);
        }
        return;
      }
      case 'client': {
        if (state.status === 'resolved') {
          const resolvedAt = state.resolvedAt;
          if (
            resolvedAt === null ||
            at.getTime() - resolvedAt.getTime() > REOPEN_WINDOW_DAYS * DAY_MS
          ) {
            throw new SeedError(`ticket ${spec.key}: a customer reply after the reopen window`);
          }
        }
        if (state.status === 'closed' || state.status === 'merged') {
          throw new SeedError(`ticket ${spec.key}: a customer reply on a ${state.status} ticket`);
        }
        messages.push({
          ticketId: id,
          channelAccountId: context.channelAccountId,
          direction: 'inbound',
          senderContactId: contactId,
          bodyText: step.body,
          visibility: 'public',
          deliveryStatus: 'not_applicable',
          createdAt: at,
        });
        state.updatedAt = at;
        audit(at, AUDIT_ACTIONS.ticketReply, clientActor, {
          metadata: { direction: 'inbound', firstResponse: false },
        });
        if (state.status === 'waiting_on_customer' || state.status === 'resolved') {
          applyStatus('open', clientActor, 'customer_reply', true);
        }
        return;
      }
      case 'note': {
        messages.push({
          ticketId: id,
          channelAccountId: context.channelAccountId,
          direction: 'internal',
          senderUserId: context.staff[step.by],
          bodyText: step.body,
          visibility: 'internal',
          deliveryStatus: 'not_applicable',
          createdAt: at,
        });
        state.updatedAt = at;
        audit(at, AUDIT_ACTIONS.ticketNote, staffActor(step.by), {});
        return;
      }
    }
  };
  for (const step of spec.steps) play(step);

  const row: TicketInsert = {
    id,
    subject: spec.subject,
    orgId: org.id,
    requesterContactId: contactId,
    channelAccountId: context.channelAccountId,
    channel: 'portal',
    intentId: intent.id,
    priority,
    status: state.status,
    assigneeId: state.assigneeId,
    queueId,
    slaPolicyId: org.policy?.id ?? null,
    firstResponseDueAt: state.firstResponseDueAt,
    resolutionDueAt: state.resolutionDueAt,
    slaPausedAt: state.slaPausedAt,
    firstRespondedAt: state.firstRespondedAt,
    resolvedAt: state.resolvedAt,
    closedAt: state.closedAt,
    tags: [],
    customFields: {},
    // The stage the intent had when the ticket arrived (N3): draft-for-approval.
    autonomyStageAtCreation: intent.autonomyStage,
    aiHandled: false,
    reopenCount: state.reopenCount,
    createdAt,
    updatedAt: state.updatedAt,
  };
  return {
    spec,
    id,
    ticket: row,
    messages,
    events,
    audits,
    status: state.status,
    lastAt: clock.at,
    scale,
  };
}

/** When the merge of `planned` happens: after its last step, never past `now`. */
export function mergeTime(planned: PlannedTicket, now: Date): Date {
  const merge = planned.spec.mergeInto;
  if (!merge) throw new SeedError(`ticket ${planned.spec.key} has no merge`);
  const at = new Date(
    planned.lastAt.getTime() + Math.max(merge.afterMin * planned.scale * MINUTE, 1000),
  );
  if (at.getTime() > now.getTime()) {
    throw new SeedError(
      `ticket ${planned.spec.key}: its merge runs past the moment the seed started`,
    );
  }
  return at;
}
