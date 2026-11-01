import { schema } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  UNDO_SEND_DEFAULT_SECONDS,
  UNDO_SEND_MAX_SECONDS,
  UNDO_SEND_MIN_SECONDS,
  UNDO_SEND_SETTING_KEY,
  type OutboundSettings,
} from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { badRequest } from '../errors.js';
import {
  Effects,
  type DbTransaction,
  type DomainContext,
  type DomainResult,
  type ReadExecutor,
} from '../types.js';

function asHold(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= UNDO_SEND_MIN_SECONDS &&
    value <= UNDO_SEND_MAX_SECONDS
    ? value
    : null;
}

/**
 * The undo-send hold of this instance in seconds (UI spec section 17 Q1). Read fresh on every
 * schedule. A missing or damaged row falls back to the default rather than to 0: a bad value must
 * never remove the customer's chance to undo.
 */
export async function readUndoSendSeconds(db: ReadExecutor): Promise<number> {
  const [row] = await db
    .select({ value: schema.instanceSetting.value })
    .from(schema.instanceSetting)
    .where(eq(schema.instanceSetting.key, UNDO_SEND_SETTING_KEY))
    .limit(1);
  return asHold(row?.value) ?? UNDO_SEND_DEFAULT_SECONDS;
}

export async function readOutboundSettings(db: ReadExecutor): Promise<OutboundSettings> {
  return { undoSendSeconds: await readUndoSendSeconds(db) };
}

/** Changes the hold (0-30 s). The caller needs the permission to manage the instance; audited. */
export async function setUndoSendSeconds(
  tx: DbTransaction,
  ctx: DomainContext,
  seconds: number,
): Promise<DomainResult<OutboundSettings>> {
  if (asHold(seconds) === null) {
    throw badRequest(
      `undoSendSeconds must be a whole number from ${String(UNDO_SEND_MIN_SECONDS)} to ${String(UNDO_SEND_MAX_SECONDS)}`,
    );
  }
  const fx = new Effects();
  const before = await readUndoSendSeconds(tx);
  const updated = await tx
    .update(schema.instanceSetting)
    .set({ value: seconds, updatedBy: ctx.actor.id, updatedAt: ctx.now() })
    .where(eq(schema.instanceSetting.key, UNDO_SEND_SETTING_KEY))
    .returning({ key: schema.instanceSetting.key });
  if (updated.length === 0)
    throw new Error('instance_setting row for the undo-send hold is missing');
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.outboundSettingSet,
    targetType: 'instance_setting',
    targetId: null,
    before: { undoSendSeconds: before },
    after: { undoSendSeconds: seconds },
  });
  return fx.result({ undoSendSeconds: seconds });
}
