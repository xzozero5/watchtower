import { randomUUID } from 'node:crypto';

import { schema, type Database } from '@watchtower/db';
import {
  ALERTS_AUDIT_ACTIONS,
  snoozeAlertSchema,
  type AlertState,
  type RealtimeEvent,
  type SnoozeAlert,
} from '@watchtower/shared';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import { dbNow } from './clock.js';

export interface SnoozeAlertInput extends SnoozeAlert {
  readonly alertId: string;
}

export interface SnoozeOutcome {
  readonly changed: boolean;
  readonly state: AlertState;
}

function updated(
  ctx: DomainContext,
  alertId: string,
  state: AlertState,
  level: number,
): RealtimeEvent {
  return {
    id: randomUUID(),
    type: 'alert.updated',
    occurredAt: ctx.now().toISOString(),
    data: { alertId, state, changed: ['snooze'], escalationLevel: level },
  };
}

/**
 * What lifting a snooze writes. The escalation is *paused* while the alert is snoozed: the time that
 * was left before the next step when the snooze began (never less than 0) is what is left again when it
 * ends, counted from the end (the expiry, or now for a snooze lifted by hand). Because later steps are
 * chained from the scheduled time of the one before (`nextStepDueAt`), moving this one moves them all.
 * Everything is the database clock; the right-hand sides read the row as it was before the update.
 */
function liftSnooze() {
  const alert = schema.alert;
  return {
    nextEscalationAt: sql`CASE
      WHEN ${alert.nextEscalationAt} IS NULL OR ${alert.snoozedAt} IS NULL THEN ${alert.nextEscalationAt}
      ELSE LEAST(clock_timestamp(), ${alert.snoozedUntil})
           + GREATEST(interval '0 seconds', ${alert.nextEscalationAt} - ${alert.snoozedAt})
    END`,
    snoozedUntil: null,
    snoozeReason: null,
    snoozedBy: null,
    snoozedAt: null,
    updatedAt: dbNow,
  };
}

/**
 * Snoozes an alert (R-3.9): its escalation is paused until the expiry, which is `minutes` after *now on
 * the database clock*, never a time the client sent. The reason is mandatory. An `open` or
 * `acknowledged` alert can be snoozed (again: the new expiry replaces the old and the pause carries on);
 * a resolved one cannot. Alerts keep counting fires while snoozed; only the paging pauses.
 */
export async function snoozeAlert(
  tx: DbTransaction,
  ctx: DomainContext,
  input: SnoozeAlertInput,
): Promise<DomainResult<SnoozeOutcome>> {
  const fx = new Effects();
  if (ctx.actor.type !== 'user' || ctx.actor.id === null) {
    throw badRequest('Only a person can snooze an alert');
  }
  // The domain checks what the HTTP layer checks: a snooze without a reason, or without a bounded expiry, is refused.
  const checked = snoozeAlertSchema.safeParse({ minutes: input.minutes, reason: input.reason });
  if (!checked.success) {
    throw badRequest(
      'A snooze needs a reason and a time between one minute and the longest allowed',
    );
  }
  const reason = checked.data.reason;
  const [row] = await tx
    .update(schema.alert)
    .set({
      snoozedUntil: sql`clock_timestamp() + make_interval(mins => ${input.minutes})`,
      snoozeReason: reason,
      snoozedBy: ctx.actor.id,
      // Snoozing again keeps the original start, so the pause is one continuous stretch.
      snoozedAt: sql`COALESCE(${schema.alert.snoozedAt}, clock_timestamp())`,
      updatedAt: dbNow,
    })
    .where(
      and(
        eq(schema.alert.id, input.alertId),
        inArray(schema.alert.state, ['open', 'acknowledged']),
      ),
    )
    .returning({
      id: schema.alert.id,
      state: schema.alert.state,
      level: schema.alert.escalationLevel,
    });
  if (row === undefined) {
    const [current] = await tx
      .select({ state: schema.alert.state })
      .from(schema.alert)
      .where(eq(schema.alert.id, input.alertId))
      .limit(1);
    if (current === undefined) throw notFound('No such alert');
    throw conflict('A resolved alert cannot be snoozed');
  }
  await recordAuditInTx(tx, ctx, fx, {
    action: ALERTS_AUDIT_ACTIONS.alertSnooze,
    targetType: 'alert',
    targetId: row.id,
    metadata: { minutes: input.minutes, reason },
  });
  fx.emit(updated(ctx, row.id, row.state as AlertState, row.level));
  return fx.result({ changed: true, state: row.state as AlertState });
}

/** Lifts a snooze by hand: the escalation resumes with the time it had left. `changed: false` when the alert was not snoozed. */
export async function unsnoozeAlert(
  tx: DbTransaction,
  ctx: DomainContext,
  input: { readonly alertId: string },
): Promise<DomainResult<SnoozeOutcome>> {
  const fx = new Effects();
  if (ctx.actor.type !== 'user' || ctx.actor.id === null) {
    throw badRequest('Only a person can lift a snooze');
  }
  const [row] = await tx
    .update(schema.alert)
    .set(liftSnooze())
    .where(and(eq(schema.alert.id, input.alertId), isNotNull(schema.alert.snoozedUntil)))
    .returning({
      id: schema.alert.id,
      state: schema.alert.state,
      level: schema.alert.escalationLevel,
    });
  if (row === undefined) {
    const [current] = await tx
      .select({ state: schema.alert.state })
      .from(schema.alert)
      .where(eq(schema.alert.id, input.alertId))
      .limit(1);
    if (current === undefined) throw notFound('No such alert');
    return fx.result({ changed: false, state: current.state as AlertState });
  }
  await recordAuditInTx(tx, ctx, fx, {
    action: ALERTS_AUDIT_ACTIONS.alertUnsnooze,
    targetType: 'alert',
    targetId: row.id,
    metadata: { by: 'person' },
  });
  fx.emit(updated(ctx, row.id, row.state as AlertState, row.level));
  return fx.result({ changed: true, state: row.state as AlertState });
}

export interface EndSnoozesResult {
  readonly ended: number;
  readonly events: RealtimeEvent[];
}

/**
 * A snooze whose expiry has passed (by the database clock) is lifted, audited, and the escalation it
 * paused resumes. `sweepEscalations` runs this first and never pages an alert that still has a snooze
 * on it, expired or not, so an expired snooze cannot let a step through before its schedule was moved.
 */
export async function endExpiredSnoozes(
  db: Database['db'],
  ctx: DomainContext,
  limit = 100,
): Promise<EndSnoozesResult> {
  const events: RealtimeEvent[] = [];
  const ended = await db.transaction(async (tx) => {
    const fx = new Effects();
    const due = await tx
      .select({ id: schema.alert.id })
      .from(schema.alert)
      .where(
        and(
          isNotNull(schema.alert.snoozedUntil),
          sql`${schema.alert.snoozedUntil} <= clock_timestamp()`,
          inArray(schema.alert.state, ['open', 'acknowledged']),
        ),
      )
      .orderBy(schema.alert.snoozedUntil)
      .limit(limit)
      .for('update', { skipLocked: true });
    for (const { id } of due) {
      const [row] = await tx
        .update(schema.alert)
        .set(liftSnooze())
        .where(eq(schema.alert.id, id))
        .returning({ state: schema.alert.state, level: schema.alert.escalationLevel });
      if (row === undefined) continue;
      await recordAuditInTx(tx, ctx, fx, {
        action: ALERTS_AUDIT_ACTIONS.alertUnsnooze,
        targetType: 'alert',
        targetId: id,
        metadata: { by: 'expiry' },
      });
      fx.emit(updated(ctx, id, row.state as AlertState, row.level));
    }
    events.push(...fx.events);
    return due.length;
  });
  return { ended, events };
}
