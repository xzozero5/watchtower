import { randomUUID } from 'node:crypto';

import { enqueueOutbox, schema, type Database } from '@watchtower/db';
import {
  NOTIFICATIONS_JOBS,
  OPS_NOTIFICATION_EVERY_SECONDS,
  QUEUE_NAMES,
  WEB_PUSH_JOB_OPTIONS,
  STAFF_ROLES,
  isMandatoryNotification,
  type NotificationKind,
  type NotificationSeverity,
  type OpsNotificationKind,
  type RealtimeEvent,
} from '@watchtower/shared';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';

import type { TicketRow } from './rows.js';
import { ticketKeysOf } from './tickets/support.js';
import { Effects, type DbTransaction, type DomainContext } from './types.js';

/** Roles that hear lead alerts: a P1 is never left to the people in one queue alone. */
const LEAD_ROLES = ['lead', 'head'] as const;

export interface NotifyInput {
  readonly kind: NotificationKind;
  readonly severity: NotificationSeverity;
  /** Candidates. Anyone who is not active staff, or has turned this kind off, is dropped. */
  readonly recipients: readonly string[];
  /** The same key for the same person is made once. */
  readonly dedupeKey: string;
  /** The ticket it is about, if any: its id, org, queue and channel become the filter facets. */
  readonly ticket?: TicketRow | undefined;
  /** Counts and ids only, never a name or message text. */
  readonly data?: Readonly<Record<string, string | number>> | undefined;
}

/** Active staff among `userIds` who have not turned `kind` off. A mandatory kind ignores the choice. */
async function deliverableRecipients(
  tx: DbTransaction,
  kind: NotificationKind,
  userIds: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return [];
  const active = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        inArray(schema.users.id, unique),
        eq(schema.users.status, 'active'),
        inArray(schema.users.role, [...STAFF_ROLES]),
      ),
    );
  const ids = active.map((row) => row.id);
  if (ids.length === 0 || isMandatoryNotification(kind)) return ids;
  const off = await tx
    .select({ userId: schema.notificationPreference.userId })
    .from(schema.notificationPreference)
    .where(
      and(
        inArray(schema.notificationPreference.userId, ids),
        eq(schema.notificationPreference.kind, kind),
        eq(schema.notificationPreference.inApp, false),
      ),
    );
  const muted = new Set(off.map((row) => row.userId));
  return ids.filter((id) => !muted.has(id));
}

/**
 * One Web Push job per browser subscription of each person who just got a notification, written in the
 * same transaction (outbox, ADR-006) so it exists if and only if the notification does. Nobody with no
 * subscription costs a job. The job holds ids only; the worker builds the (small, customer-free) message.
 * Whether Web Push is switched on at all is the worker's call: with no VAPID credential it drops the job.
 */
async function enqueueWebPush(
  tx: DbTransaction,
  ctx: DomainContext,
  created: readonly { readonly id: string; readonly userId: string }[],
): Promise<void> {
  if (created.length === 0) return;
  const byUser = new Map(created.map((row) => [row.userId, row.id]));
  const subscriptions = await tx
    .select({ id: schema.webPushSubscription.id, userId: schema.webPushSubscription.userId })
    .from(schema.webPushSubscription)
    .where(inArray(schema.webPushSubscription.userId, [...byUser.keys()]));
  for (const subscription of subscriptions) {
    const notificationId = byUser.get(subscription.userId);
    if (notificationId === undefined) continue;
    await enqueueOutbox(tx, {
      queue: QUEUE_NAMES.webPush,
      jobName: NOTIFICATIONS_JOBS.webPush,
      jobId: `push-${notificationId}-${subscription.id}`,
      payload: { notificationId, subscriptionId: subscription.id },
      options: { ...WEB_PUSH_JOB_OPTIONS },
      // A push for something that happened more than the longest TTL ago is not worth sending.
      expiresAt: new Date(ctx.now().getTime() + 4 * 3600 * 1000),
    });
  }
}

/**
 * Makes a notification for each deliverable recipient and queues a realtime event for each one that
 * is new (after the commit, with the rest of `fx`). Returns how many were made; a repeat of the same
 * `dedupeKey` for the same person makes none.
 */
export async function notifyIn(
  tx: DbTransaction,
  ctx: DomainContext,
  fx: Effects,
  input: NotifyInput,
): Promise<number> {
  const recipients = await deliverableRecipients(tx, input.kind, input.recipients);
  if (recipients.length === 0) return 0;
  const ticket = input.ticket;
  const now = ctx.now();
  const created = await tx
    .insert(schema.notification)
    .values(
      recipients.map((userId) => ({
        userId,
        kind: input.kind,
        severity: input.severity,
        dedupeKey: input.dedupeKey,
        ticketId: ticket?.id ?? null,
        orgId: ticket?.orgId ?? null,
        queueId: ticket?.queueId ?? null,
        channel: ticket?.channel ?? null,
        data: { ...input.data },
        createdAt: now,
      })),
    )
    .onConflictDoNothing({
      target: [schema.notification.userId, schema.notification.dedupeKey],
    })
    .returning({ id: schema.notification.id, userId: schema.notification.userId });
  const ticketKey = ticket === undefined ? null : ticketKeysOf(ctx).format(ticket.number);
  await enqueueWebPush(tx, ctx, created);
  for (const row of created) {
    fx.emit({
      id: randomUUID(),
      type: 'notification.created',
      occurredAt: now.toISOString(),
      recipientId: row.userId,
      data: {
        notificationId: row.id,
        kind: input.kind,
        severity: input.severity,
        orgId: ticket?.orgId ?? null,
        queueId: ticket?.queueId ?? null,
        channel: ticket?.channel ?? null,
        ticketId: ticket?.id ?? null,
        ticketKey,
      },
    });
  }
  return created.length;
}

async function activeLeadIds(tx: DbTransaction): Promise<string[]> {
  const rows = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(inArray(schema.users.role, [...LEAD_ROLES]), eq(schema.users.status, 'active')));
  return rows.map((row) => row.id);
}

/**
 * A P1 ticket exists (created, or raised to P1): the assignee, the members of its queue and every
 * lead and head are told, except the person who just did it. Critical severity: the web app keeps a
 * banner up until it is read. Once per person per ticket.
 */
export async function notifyTicketP1(
  tx: DbTransaction,
  ctx: DomainContext,
  fx: Effects,
  ticket: TicketRow,
): Promise<void> {
  const members =
    ticket.queueId === null
      ? []
      : (
          await tx
            .select({ userId: schema.teamQueueMember.userId })
            .from(schema.teamQueueMember)
            .where(eq(schema.teamQueueMember.queueId, ticket.queueId))
        ).map((row) => row.userId);
  const candidates = [
    ...(ticket.assigneeId === null ? [] : [ticket.assigneeId]),
    ...members,
    ...(await activeLeadIds(tx)),
  ].filter((id) => id !== ctx.actor.id);
  await notifyIn(tx, ctx, fx, {
    kind: 'ticket.p1',
    severity: 'critical',
    recipients: candidates,
    dedupeKey: `ticket.p1:${ticket.id}`,
    ticket,
  });
}

/**
 * A ticket was handed to `ticket.assigneeId` by someone else. A P1 ticket is covered by the P1
 * alert, so it is not announced twice. Once per person per ticket and assignment.
 */
export async function notifyTicketAssigned(
  tx: DbTransaction,
  ctx: DomainContext,
  fx: Effects,
  ticket: TicketRow,
): Promise<void> {
  const assignee = ticket.assigneeId;
  if (assignee === null || assignee === ctx.actor.id || ticket.priority === 'P1') return;
  await notifyIn(tx, ctx, fx, {
    kind: 'ticket.assigned',
    severity: 'normal',
    recipients: [assignee],
    // A ticket handed back and forth is announced each time the moment changes.
    dedupeKey: `ticket.assigned:${ticket.id}:${ctx.now().getTime().toString()}`,
    ticket,
  });
}

/**
 * The part of the shift overview (T-111, `GET /v1/shifts/overview`) that raises an alert. Typed
 * structurally so this package does not depend on the shifts feature: the overview satisfies it.
 */
export interface ShiftAlertInput {
  /** Rostered people whose shift started and who have not clocked in (R-7.3). */
  readonly noShows: readonly { readonly id: string }[];
  readonly unacknowledged: {
    readonly items: readonly {
      readonly handoffId: string;
      readonly overdue: boolean;
    }[];
  };
}

/**
 * Tells every active lead and head about a no-show and about handoff items nobody acknowledged in
 * time (AC-7). One alert per no-show roster entry and one per handoff, each once per person, so a
 * scan can run as often as T-111 likes. Returns how many notifications were made.
 */
export async function notifyShiftAlerts(
  tx: DbTransaction,
  ctx: DomainContext,
  fx: Effects,
  input: ShiftAlertInput,
): Promise<number> {
  const leads = await activeLeadIds(tx);
  let made = 0;
  for (const entry of input.noShows) {
    made += await notifyIn(tx, ctx, fx, {
      kind: 'shift.no_show',
      severity: 'high',
      recipients: leads,
      dedupeKey: `shift.no_show:${entry.id}`,
      data: { rosterEntryId: entry.id },
    });
  }
  const overdueByHandoff = new Map<string, number>();
  for (const item of input.unacknowledged.items) {
    if (item.overdue) {
      overdueByHandoff.set(item.handoffId, (overdueByHandoff.get(item.handoffId) ?? 0) + 1);
    }
  }
  for (const [handoffId, count] of overdueByHandoff) {
    made += await notifyIn(tx, ctx, fx, {
      kind: 'shift.handoff_overdue',
      severity: 'high',
      recipients: leads,
      dedupeKey: `shift.handoff_overdue:${handoffId}`,
      data: { handoffId, count },
    });
  }
  return made;
}

export interface OpsNoticeInput {
  readonly kind: OpsNotificationKind;
  /** Counts and codes only, never a credential, an address or a server's text. */
  readonly data?: Readonly<Record<string, string | number>> | undefined;
}

export interface OpsNoticeResult {
  /** Notifications made (one per active head); 0 when one of this kind was made within the hour. */
  readonly created: number;
  readonly events: RealtimeEvent[];
}

/**
 * Tells every active head that the system itself needs them (T-176): the mail server refused our
 * login, the instance-wide upload cap is full, outbox rows were given up on. Until now these only
 * went to a log line nobody was watching.
 *
 * Anti-spam: at most one notice per kind per hour, however often the fault repeats (a failing job
 * retried every minute makes one). The check and the insert run under one advisory lock per kind, so
 * two workers at once make one. Heads who turned the kind off hear nothing (not mandatory).
 * The caller publishes `events` after the commit; a failure to do so is not worth failing the job for.
 */
export async function notifyOpsAlert(
  db: Database['db'],
  ctx: DomainContext,
  input: OpsNoticeInput,
): Promise<OpsNoticeResult> {
  const fx = new Effects();
  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ops-notice:${input.kind}`}))`);
    const since = new Date(ctx.now().getTime() - OPS_NOTIFICATION_EVERY_SECONDS * 1000);
    const [recent] = await tx
      .select({ id: schema.notification.id })
      .from(schema.notification)
      .where(
        and(eq(schema.notification.kind, input.kind), gt(schema.notification.createdAt, since)),
      )
      .limit(1);
    if (recent !== undefined) return 0;
    const heads = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.role, 'head'), eq(schema.users.status, 'active')));
    return notifyIn(tx, ctx, fx, {
      kind: input.kind,
      severity: 'high',
      recipients: heads.map((row) => row.id),
      dedupeKey: `${input.kind}:${Math.floor(ctx.now().getTime() / 1000).toString()}`,
      data: input.data,
    });
  });
  return { created, events: fx.events };
}
