import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import { ALERTS_AUDIT_ACTIONS, type AlertAckVia, type AlertState } from '@watchtower/shared';
import { and, eq } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { badRequest, notFound } from '../errors.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import { dbNow } from './escalation.js';

export interface AckAlertInput {
  readonly alertId: string;
  /** Where the acknowledgment came from: the web app, or the Discord button or `/ack`. */
  readonly via: AlertAckVia;
}

export interface AckAlertOutcome {
  /** False when the alert was not `open`: somebody acknowledged it first, or it is resolved. */
  readonly changed: boolean;
  readonly state: AlertState;
}

/**
 * A person acknowledges an alert (R-3.8): the escalation stops. One conditional update
 * (`WHERE state = 'open'`) decides the winner when two people (or the web and Discord) press at the
 * same moment, so exactly one of them changes the alert and writes the audit row; the other gets
 * `changed: false` and the state as it is, which is not an error. The acknowledgment time is the
 * database clock. Realtime: staff are told within the request, not on the next poll (AC-3, 2 s).
 */
export async function ackAlert(
  tx: DbTransaction,
  ctx: DomainContext,
  input: AckAlertInput,
): Promise<DomainResult<AckAlertOutcome>> {
  const fx = new Effects();
  if (ctx.actor.type !== 'user' || ctx.actor.id === null) {
    throw badRequest('Only a person can acknowledge an alert');
  }
  const [updated] = await tx
    .update(schema.alert)
    .set({
      state: 'acknowledged',
      ackedAt: dbNow,
      ackedBy: ctx.actor.id,
      ackedVia: input.via,
      nextEscalationAt: null,
      updatedAt: dbNow,
    })
    .where(and(eq(schema.alert.id, input.alertId), eq(schema.alert.state, 'open')))
    .returning({ id: schema.alert.id, level: schema.alert.escalationLevel });

  if (updated === undefined) {
    const [current] = await tx
      .select({ state: schema.alert.state })
      .from(schema.alert)
      .where(eq(schema.alert.id, input.alertId))
      .limit(1);
    if (current === undefined) throw notFound('No such alert');
    return fx.result({ changed: false, state: current.state as AlertState });
  }

  await recordAuditInTx(tx, ctx, fx, {
    action: ALERTS_AUDIT_ACTIONS.alertAck,
    targetType: 'alert',
    targetId: updated.id,
    metadata: { via: input.via, level: updated.level },
  });
  fx.emit({
    id: randomUUID(),
    type: 'alert.updated',
    occurredAt: ctx.now().toISOString(),
    data: {
      alertId: updated.id,
      state: 'acknowledged',
      changed: ['state'],
      escalationLevel: updated.level,
    },
  });
  return fx.result({ changed: true, state: 'acknowledged' });
}
