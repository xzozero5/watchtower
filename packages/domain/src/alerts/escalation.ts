import { randomUUID } from 'node:crypto';

import { schema, type Database } from '@watchtower/db';
import {
  ALERTS_AUDIT_ACTIONS,
  ALERTS_JOBS,
  DEFAULT_ESCALATION_STEPS,
  QUEUE_NAMES,
  STAFF_ROLES,
  escalationStepsSchema,
  type EscalationStep,
  type EscalationTarget,
  type RealtimeEvent,
} from '@watchtower/shared';
import { and, asc, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { onShiftCondition } from '../assignment.js';
import { notifyIn } from '../notifications.js';
import { enqueueJob } from '../outbox.js';
import { Effects, type DbTransaction, type DomainContext, type ReadExecutor } from '../types.js';

/**
 * The database clock at the moment the statement runs. Every time the escalation decides with (is a
 * step due, is a snooze over, is a roster window open) is compared with this and nothing else, so a
 * process whose clock is a few seconds off cannot page too early or too late (ADR-015 section 2,
 * STATUS lesson of T-122: one clock per comparison).
 */
export const dbNow = sql`clock_timestamp()`;

/** `first_seen_at + afterSeconds`: when a step is due, computed by the database. */
export function stepDueAt(afterSeconds: number) {
  return sql`${schema.alert.firstSeenAt} + make_interval(secs => ${afterSeconds})`;
}

/**
 * The steps that apply to a service: its own policy, else the default one. A policy whose stored
 * steps no longer parse (edited by hand in the database) falls back to the built-in default rather
 * than leaving an alert that never pages anybody.
 */
export async function escalationStepsFor(
  executor: ReadExecutor,
  serviceId: string | null,
): Promise<readonly EscalationStep[]> {
  let steps: unknown;
  if (serviceId !== null) {
    const [own] = await executor
      .select({ steps: schema.escalationPolicy.steps })
      .from(schema.service)
      .innerJoin(
        schema.escalationPolicy,
        eq(schema.escalationPolicy.id, schema.service.escalationPolicyId),
      )
      .where(eq(schema.service.id, serviceId))
      .limit(1);
    steps = own?.steps;
  }
  if (steps === undefined) {
    const [fallback] = await executor
      .select({ steps: schema.escalationPolicy.steps })
      .from(schema.escalationPolicy)
      .where(eq(schema.escalationPolicy.isDefault, true))
      .limit(1);
    steps = fallback?.steps;
  }
  const parsed = escalationStepsSchema.safeParse(steps);
  return parsed.success ? parsed.data : DEFAULT_ESCALATION_STEPS;
}

export interface EscalationRecipients {
  readonly userIds: string[];
  /** `lead` when nobody was on shift and the leads and heads were told in their place. */
  readonly fallback: 'lead' | null;
}

const activeStaff = and(
  eq(schema.users.status, 'active'),
  inArray(schema.users.role, [...STAFF_ROLES]),
);

/**
 * People rostered now on an on-call shift (R-3.8: "on shift/on-call"), whether or not they clocked in:
 * an on-call person answers a page from wherever they are. The shift window is the wall-clock
 * `starts_at`..`ends_at` of the roster date in the business calendar's zone (the shifts feature's
 * rule), compared with the database clock. A window that ends before it starts crosses midnight.
 */
async function onCallNow(tx: DbTransaction): Promise<string[]> {
  const result = await tx.execute<{ user_id: string }>(sql`
    WITH zone AS (
      SELECT COALESCE(
        (SELECT timezone FROM business_calendar WHERE is_default LIMIT 1), 'UTC') AS tz
    ), win AS (
      SELECT r.user_id,
             ((r.work_date + s.starts_at::time) AT TIME ZONE (SELECT tz FROM zone)) AS starts,
             CASE WHEN s.ends_at::time > s.starts_at::time
                  THEN s.ends_at::time - s.starts_at::time
                  ELSE s.ends_at::time - s.starts_at::time + interval '24 hours' END AS span
        FROM roster_entry r
        JOIN shift_definition s ON s.id = r.shift_id
       WHERE s.on_call AND s.active
         AND r.work_date BETWEEN (clock_timestamp() - interval '2 days')::date
                             AND (clock_timestamp() + interval '2 days')::date
    )
    SELECT DISTINCT win.user_id
      FROM win
      JOIN users u ON u.id = win.user_id
     WHERE u.status = 'active'
       AND clock_timestamp() >= win.starts
       AND clock_timestamp() < win.starts + win.span`);
  return result.rows.map((row) => row.user_id);
}

async function leadsAndHeads(tx: DbTransaction, roles: readonly ('lead' | 'head')[]) {
  const rows = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.status, 'active'), inArray(schema.users.role, [...roles])))
    .orderBy(asc(schema.users.id));
  return rows.map((row) => row.id);
}

/**
 * Who a step tells (R-3.8).
 *  - `lead` / `head`: every active person with that role.
 *  - `on_shift`: the clocked-in staff of the service's owner queue if any of them is clocked in, else
 *    all clocked-in staff (the same "on shift" the ticket assignment uses), plus whoever is on an
 *    on-call roster window now. Nobody at all: the leads and heads, flagged `fallback: 'lead'`, so
 *    an alert at night is never left to nobody.
 */
export async function resolveRecipients(
  tx: DbTransaction,
  target: EscalationTarget,
  serviceId: string | null,
): Promise<EscalationRecipients> {
  if (target === 'lead') return { userIds: await leadsAndHeads(tx, ['lead']), fallback: null };
  if (target === 'head') return { userIds: await leadsAndHeads(tx, ['head']), fallback: null };

  const clockedIn = (queueId: string | null) =>
    tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(
        and(
          activeStaff,
          onShiftCondition(),
          queueId === null
            ? undefined
            : sql`EXISTS (
                SELECT 1 FROM ${schema.teamQueueMember}
                 WHERE ${schema.teamQueueMember.userId} = ${schema.users}."id"
                   AND ${schema.teamQueueMember.queueId} = ${queueId})`,
        ),
      )
      .orderBy(asc(schema.users.id));

  let ownerQueueId: string | null = null;
  if (serviceId !== null) {
    const [owner] = await tx
      .select({ queueId: schema.service.ownerQueueId })
      .from(schema.service)
      .where(eq(schema.service.id, serviceId))
      .limit(1);
    ownerQueueId = owner?.queueId ?? null;
  }
  let people = ownerQueueId === null ? [] : await clockedIn(ownerQueueId);
  if (people.length === 0) people = await clockedIn(null);
  const ids = new Set(people.map((row) => row.id));
  for (const id of await onCallNow(tx)) ids.add(id);
  if (ids.size > 0) return { userIds: [...ids], fallback: null };
  return { userIds: await leadsAndHeads(tx, ['lead', 'head']), fallback: 'lead' };
}

export interface EscalationSweepResult {
  /** Steps carried out. */
  readonly steps: number;
  /** In-app notifications made. */
  readonly notified: number;
  /** Alerts whose policy had no step left: the clock was cleared. */
  readonly exhausted: number;
  readonly events: RealtimeEvent[];
}

export interface EscalationSweepOptions {
  /** Steps carried out at most per call; the rest wait for the next sweep. Default 50. */
  readonly limit?: number;
}

type StepOutcome = 'none' | 'step' | 'exhausted';

/**
 * Carries out the next step of the oldest alert whose step is due, in the caller's transaction. The
 * alert row is locked (`FOR UPDATE SKIP LOCKED`), so two sweeps never take the same alert, and the
 * `(alert_id, level)` key of `alert_escalation` means a step cannot happen twice even if they did.
 *
 * Due means: still `open` (an acknowledged or resolved alert is never paged), `next_escalation_at` is
 * past by the database clock, and not snoozed by the database clock.
 */
async function escalateOne(
  tx: DbTransaction,
  ctx: DomainContext,
  fx: Effects,
  tally: { notified: number },
  already: readonly string[],
): Promise<{ outcome: StepOutcome; alertId: string | null }> {
  const [due] = await tx
    .select({
      id: schema.alert.id,
      level: schema.alert.escalationLevel,
      severity: schema.alert.severity,
      serviceId: schema.alert.serviceId,
    })
    .from(schema.alert)
    .where(
      and(
        eq(schema.alert.state, 'open'),
        already.length === 0 ? undefined : notInArray(schema.alert.id, [...already]),
        isNotNull(schema.alert.nextEscalationAt),
        sql`${schema.alert.nextEscalationAt} <= clock_timestamp()`,
        sql`(${schema.alert.snoozedUntil} IS NULL OR ${schema.alert.snoozedUntil} <= clock_timestamp())`,
      ),
    )
    .orderBy(asc(schema.alert.nextEscalationAt), asc(schema.alert.id))
    .limit(1)
    .for('update', { skipLocked: true });
  if (due === undefined) return { outcome: 'none', alertId: null };

  const steps = await escalationStepsFor(tx, due.serviceId);
  const step = steps[due.level];
  if (step === undefined) {
    await tx
      .update(schema.alert)
      .set({ nextEscalationAt: null, updatedAt: dbNow })
      .where(eq(schema.alert.id, due.id));
    return { outcome: 'exhausted', alertId: due.id };
  }

  const recipients = await resolveRecipients(tx, step.target, due.serviceId);
  const made = await notifyIn(tx, ctx, fx, {
    kind: due.level === 0 ? 'alert.fired' : 'alert.escalated',
    // `critical` is the sticky "P1 ticket" banner; an alert has no ticket, so it is `high` until the alert UI exists.
    severity: 'high',
    recipients: recipients.userIds,
    dedupeKey: `alert:${due.id}:${String(due.level)}`,
    // Ids and small facts only (N4): no title, no payload.
    data: { alertId: due.id, level: due.level, target: step.target, severity: due.severity },
  });
  tally.notified += made;

  const [logged] = await tx
    .insert(schema.alertEscalation)
    .values({
      alertId: due.id,
      level: due.level,
      target: step.target,
      fallback: recipients.fallback,
      recipientIds: recipients.userIds,
      recipientCount: recipients.userIds.length,
    })
    .onConflictDoNothing({ target: [schema.alertEscalation.alertId, schema.alertEscalation.level] })
    .returning({ id: schema.alertEscalation.id });

  const next = steps[due.level + 1];
  await tx
    .update(schema.alert)
    .set({
      escalationLevel: due.level + 1,
      nextEscalationAt: next === undefined ? null : stepDueAt(next.afterSeconds),
      updatedAt: dbNow,
    })
    .where(eq(schema.alert.id, due.id));

  if (logged !== undefined) {
    await enqueueJob(tx, ctx.config, {
      queue: QUEUE_NAMES.alerts,
      name: ALERTS_JOBS.chat,
      jobId: `alert-chat:${due.id}:${String(due.level)}`,
      payload: { alertId: due.id, level: due.level },
    });
  }
  await recordAuditInTx(tx, ctx, fx, {
    action: ALERTS_AUDIT_ACTIONS.alertEscalate,
    targetType: 'alert',
    targetId: due.id,
    metadata: {
      level: due.level,
      target: step.target,
      recipients: recipients.userIds.length,
      fallback: recipients.fallback,
    },
  });
  fx.emit({
    id: randomUUID(),
    type: 'alert.updated',
    occurredAt: ctx.now().toISOString(),
    data: {
      alertId: due.id,
      state: 'open',
      changed: ['escalation'],
      escalationLevel: due.level + 1,
    },
  });
  return { outcome: 'step', alertId: due.id };
}

/**
 * Follows the escalation policies (R-3.8, AC-3): carries out every step that is due, one alert at a
 * time and one transaction per step, so a failure on one alert never rolls back the pages already
 * sent for another. Safe to run from many workers at once and as often as you like: what is due is
 * decided by the rows and the database clock, and a step is recorded once.
 *
 * Returns the realtime events to publish after the commits.
 */
export async function sweepEscalations(
  db: Database['db'],
  ctx: DomainContext,
  options: EscalationSweepOptions = {},
): Promise<EscalationSweepResult> {
  const limit = options.limit ?? 50;
  const events: RealtimeEvent[] = [];
  const tally = { notified: 0 };
  let steps = 0;
  let exhausted = 0;
  // An alert moves one step per call, however overdue: if the worker was down for an hour the lead
  // and then the head are not both paged in the same breath, the sweep interval spaces them.
  const done: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    const fx = new Effects();
    const { outcome, alertId } = await db.transaction((tx) =>
      escalateOne(tx, ctx, fx, tally, done),
    );
    if (outcome === 'none' || alertId === null) break;
    done.push(alertId);
    events.push(...fx.events);
    if (outcome === 'step') steps += 1;
    else exhausted += 1;
  }
  return { steps, notified: tally.notified, exhausted, events };
}
