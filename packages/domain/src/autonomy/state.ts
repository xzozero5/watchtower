import { schema } from '@watchtower/db';
import {
  AI_SWITCH_KEYS,
  AUDIT_ACTIONS,
  MANUAL_MAX_AUTONOMY_STAGE,
  PHASE_MAX_AUTONOMY_STAGE,
  parseAutosendPolicy,
  type AiSwitch,
  type AiSwitchKey,
  type AutonomyIntent,
  type AutonomyState,
  type SetAiSwitchResult,
} from '@watchtower/shared';
import { asc, eq, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { DomainError, badRequest, conflict, notFound } from '../errors.js';
import type { IntentRow } from '../rows.js';
import {
  Effects,
  type DbTransaction,
  type DomainContext,
  type DomainResult,
  type ReadExecutor,
} from '../types.js';
import { effectiveStage } from './decide.js';

/** Postgres error codes raised by `set_intent_autonomy()` (migration 0007). */
const SQLSTATE_PINNED = 'WT001';
const SQLSTATE_CAP_ON = 'WT002';
const SQLSTATE_NO_ROW = 'P0002';

/** First word of a display name: what any staff reader may see of who flipped a switch (T-127 H3). */
export function firstName(name: string | null): string | null {
  const word = name?.trim().split(/\s+/)[0];
  return word === undefined || word === '' ? null : word;
}

function toSwitch(
  row: typeof schema.aiSwitch.$inferSelect,
  changedByName: string | null,
): AiSwitch {
  return {
    key: row.key as AiSwitchKey,
    on: row.isOn,
    reason: row.reason,
    changedBy: row.changedBy,
    changedByName: firstName(changedByName),
    changedAt: row.changedAt.toISOString(),
  };
}

export function toAutonomyIntent(row: IntentRow, autosendEnabled = false): AutonomyIntent {
  const stage = Math.min(row.autonomyStage, PHASE_MAX_AUTONOMY_STAGE);
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    isActive: row.isActive,
    stage,
    effectiveStage: effectiveStage(row.autonomyStage, autosendEnabled),
    pinned: row.autonomyPinned,
    autosend: {
      shadow: row.autosendShadow,
      minScore: Number(row.autosendMinScore),
      dailyCap: row.autosendDailyCap,
      // A stored policy that does not parse shows as the empty one (no channel): the gate denies it the same way.
      policy: parseAutosendPolicy(row.autosendPolicy) ??
        parseAutosendPolicy({}) ?? { channels: [], action: 'reply', maxChars: 1200 },
    },
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Both switches, in a fixed order. A row missing from the table (damaged) shows as ON. */
export async function readSwitches(executor: ReadExecutor): Promise<AiSwitch[]> {
  const rows = await executor
    .select({ row: schema.aiSwitch, userName: schema.users.name })
    .from(schema.aiSwitch)
    .leftJoin(schema.users, eq(schema.users.id, schema.aiSwitch.changedBy));
  return AI_SWITCH_KEYS.map((key) => {
    const found = rows.find((candidate) => candidate.row.key === key);
    return found === undefined
      ? {
          key,
          on: true,
          reason: 'switch row missing',
          changedBy: null,
          changedByName: null,
          changedAt: new Date(0).toISOString(),
        }
      : toSwitch(found.row, found.userName);
  });
}

/** What `GET /v1/autonomy` returns: the ceiling, both switches, and every intent's stage. */
export async function readAutonomyState(
  executor: ReadExecutor,
  autosendEnabled = false,
): Promise<AutonomyState> {
  const [switches, intents] = await Promise.all([
    readSwitches(executor),
    executor.select().from(schema.intent).orderBy(asc(schema.intent.key)),
  ]);
  return {
    stageCeiling: MANUAL_MAX_AUTONOMY_STAGE,
    autosendFlag: autosendEnabled,
    switches,
    intents: intents.map((row) => toAutonomyIntent(row, autosendEnabled)),
  };
}

export interface SetAiSwitchInput {
  readonly switch: AiSwitchKey;
  readonly on: boolean;
  readonly reason: string;
}

/**
 * Flips one global switch (po 23): the reason is required both ways, the change and an audit row
 * commit together. Asking for the value it already has writes nothing (`changed: false`). Who may
 * call this (head) is the caller's check; the domain only needs an acting user.
 */
export async function setAiSwitch(
  tx: DbTransaction,
  ctx: DomainContext,
  input: SetAiSwitchInput,
): Promise<DomainResult<SetAiSwitchResult>> {
  const fx = new Effects();
  const reason = input.reason.trim();
  if (reason.length === 0) throw badRequest('A reason is required');
  if (ctx.actor.type !== 'user' || ctx.actor.id === null) {
    throw new DomainError('policy_denied', 'Only a signed-in person may flip an AI switch', {
      reason: 'actor_not_a_person',
    });
  }
  // The application role cannot UPDATE ai_switch: set_ai_switch() (migration 0007) demands an actor
  // and a reason, locks the row, writes only a real change and returns the value it had before.
  let previous: boolean;
  try {
    const result = await tx.execute<{ previous: boolean }>(
      sql`SELECT public.set_ai_switch(${input.switch}, ${input.on}, ${ctx.actor.id}::uuid, ${reason}) AS previous`,
    );
    previous = result.rows[0]?.previous ?? input.on;
  } catch (error) {
    if (pgCode(error) === SQLSTATE_NO_ROW) throw notFound('No such switch');
    throw error;
  }
  const changed = previous !== input.on;
  if (changed) {
    await recordAuditInTx(tx, ctx, fx, {
      action: AUDIT_ACTIONS.autonomySwitchSet,
      targetType: 'ai_switch',
      targetId: null,
      before: { switch: input.switch, on: previous },
      after: { switch: input.switch, on: input.on },
      // The reason is free text typed by a person; it is not customer content (N4).
      metadata: { switch: input.switch, on: input.on, reason },
    });
  }
  return fx.result({ changed, switches: await readSwitches(tx) });
}

export interface SetIntentAutonomyInput {
  readonly intentId: string;
  readonly stage?: number | undefined;
  readonly pinned?: boolean | undefined;
  readonly reason: string;
}

export interface SetIntentAutonomyResult {
  readonly intent: AutonomyIntent;
  readonly changed: boolean;
}

function pgCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  // Drizzle wraps driver errors; the SQLSTATE sits on `cause`.
  if ('cause' in error) return pgCode(error.cause);
  return undefined;
}

/**
 * Changes an intent's stage and/or pin (T-112a). Stage 0-2 only: 3 and above is the owner's
 * decision (N3) and is refused here as well as by the api and by the database CHECK. The write goes
 * through `set_intent_autonomy()`, which records who/when/why/from/to in the same statement; the
 * audit row commits in the same transaction. Pinned intents and a raised stage under the cap
 * switch answer `conflict`.
 */
export async function setIntentAutonomy(
  tx: DbTransaction,
  ctx: DomainContext,
  input: SetIntentAutonomyInput,
): Promise<DomainResult<SetIntentAutonomyResult>> {
  const fx = new Effects();
  const reason = input.reason.trim();
  if (reason.length === 0) throw badRequest('A reason is required');
  if (input.stage === undefined && input.pinned === undefined) {
    throw badRequest('Give a stage, pinned, or both');
  }
  if (ctx.actor.type !== 'user' || ctx.actor.id === null) {
    throw new DomainError('policy_denied', 'Only a signed-in person may change an autonomy stage', {
      reason: 'actor_not_a_person',
    });
  }
  if (input.stage !== undefined) {
    if (!Number.isInteger(input.stage) || input.stage < 0) throw badRequest('Invalid stage');
    if (input.stage > MANUAL_MAX_AUTONOMY_STAGE) {
      throw new DomainError(
        'policy_denied',
        'Stage 3 and above (auto-send) is reached by a promotion, never set by hand',
        { reason: 'stage_requires_owner' },
      );
    }
  }
  const [before] = await tx
    .select()
    .from(schema.intent)
    .where(eq(schema.intent.id, input.intentId))
    .limit(1);
  if (before === undefined) throw notFound('No such intent');

  let written: number;
  try {
    const result = await tx.execute<{ written: number }>(
      sql`SELECT public.set_intent_autonomy(${input.intentId}::uuid, ${input.stage ?? null}::smallint, ${input.pinned ?? null}::boolean, ${ctx.actor.id}::uuid, ${reason}) AS written`,
    );
    written = result.rows[0]?.written ?? 0;
  } catch (error) {
    switch (pgCode(error)) {
      case SQLSTATE_PINNED:
        throw conflict('The stage of this intent is pinned; unpin it first');
      case SQLSTATE_CAP_ON:
        throw conflict('Stages cannot be raised while "limit all intents to stage 2" is on');
      case SQLSTATE_NO_ROW:
        throw notFound('No such intent');
      default:
        throw error;
    }
  }

  const [after] = await tx
    .select()
    .from(schema.intent)
    .where(eq(schema.intent.id, input.intentId))
    .limit(1);
  if (after === undefined) throw notFound('No such intent');
  if (written > 0) {
    const stageChanged = after.autonomyStage !== before.autonomyStage;
    const pinChanged = after.autonomyPinned !== before.autonomyPinned;
    await recordAuditInTx(tx, ctx, fx, {
      action: stageChanged ? AUDIT_ACTIONS.autonomyStageSet : AUDIT_ACTIONS.autonomyPinSet,
      targetType: 'intent',
      targetId: after.id,
      before: { stage: before.autonomyStage, pinned: before.autonomyPinned },
      after: { stage: after.autonomyStage, pinned: after.autonomyPinned },
      metadata: { intentKey: after.key, stageChanged, pinChanged, reason },
    });
  }
  return fx.result({
    intent: toAutonomyIntent(after, ctx.config.autosendEnabled === true),
    changed: written > 0,
  });
}
