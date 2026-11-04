import { schema } from '@watchtower/db';
import { AUDIT_ACTIONS } from '@watchtower/shared';
import { eq, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { DomainError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';

/**
 * Thin callers of the SQL doors of migration 0096 (ADR-025 sections 5 to 7). The rules live in the
 * database (`request_/decide_/apply_stage_promotion()`, `rollback_intent_autonomy()`,
 * `set_intent_autosend()`): these functions pass the arguments, translate the SQLSTATE into a
 * `DomainError` and write the audit row in the same transaction. Who may call them (head to ask, the
 * owner to approve) is checked by the database from the person's permissions, and by the api route.
 */

/** Custom SQLSTATE values raised by those functions. */
export const PROMOTION_SQLSTATE = {
  stage3OnlyByPromotion: 'WT003',
  noPermission: 'WT004',
  notEligible: 'WT011',
  reauthOrKey: 'WT012',
  wrongState: 'WT014',
  noRow: 'P0002',
  checkViolation: '23514',
  uniqueViolation: '23505',
} as const;

/** Why a promotion cannot go ahead (the text after `promotion not eligible:` in the WT011 message). */
export const PROMOTION_BLOCKERS = [
  'intent_not_found',
  'not_at_stage_2',
  'pinned',
  'stage_cap_on',
  'report_not_found',
  'report_not_green',
  'report_counts_seed',
  'report_too_old',
  'window_too_short',
  'window_not_at_stage_2',
] as const;
export type PromotionBlocker = (typeof PROMOTION_BLOCKERS)[number];

interface PgFailure {
  readonly code: string | undefined;
  readonly message: string;
}

function pgFailure(error: unknown): PgFailure {
  if (typeof error !== 'object' || error === null) return { code: undefined, message: '' };
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const message = error instanceof Error ? error.message : '';
  if (code === undefined && 'cause' in error) return pgFailure(error.cause);
  return { code, message };
}

export function blockerFrom(message: string): PromotionBlocker | undefined {
  return PROMOTION_BLOCKERS.find((blocker) => message.includes(blocker));
}

function translate(error: unknown): never {
  const { code, message } = pgFailure(error);
  switch (code) {
    case PROMOTION_SQLSTATE.noPermission:
      throw forbidden('You are not allowed to do this');
    case PROMOTION_SQLSTATE.notEligible: {
      const blocker = blockerFrom(message);
      throw new DomainError('policy_denied', 'This intent cannot be promoted now', {
        reason: blocker ?? 'not_eligible',
      });
    }
    case PROMOTION_SQLSTATE.reauthOrKey:
      throw new DomainError('policy_denied', 'Re-authenticate and type the key of the intent', {
        reason: message.includes('key') ? 'confirm_key_mismatch' : 'reauth_required',
      });
    case PROMOTION_SQLSTATE.wrongState:
      throw conflict('The promotion is not in a state that allows this');
    case PROMOTION_SQLSTATE.uniqueViolation:
      throw conflict('This intent already has an open promotion');
    case PROMOTION_SQLSTATE.noRow:
      throw notFound('No such intent or promotion');
    case PROMOTION_SQLSTATE.checkViolation:
      throw badRequest('The reason must be 3 to 500 characters');
    case PROMOTION_SQLSTATE.stage3OnlyByPromotion:
      throw new DomainError('policy_denied', 'Stage 3 is reached only through a promotion', {
        reason: 'stage_requires_promotion',
      });
    default:
      throw error;
  }
}

function personId(ctx: DomainContext, what: string): string {
  if (ctx.actor.type !== 'user' || ctx.actor.id === null) {
    throw new DomainError('policy_denied', `Only a signed-in person may ${what}`, {
      reason: 'actor_not_a_person',
    });
  }
  return ctx.actor.id;
}

async function intentOf(tx: DbTransaction, intentId: string) {
  const [row] = await tx
    .select({ id: schema.intent.id, key: schema.intent.key })
    .from(schema.intent)
    .where(eq(schema.intent.id, intentId))
    .limit(1);
  return row;
}

async function promotionOf(tx: DbTransaction, promotionId: string) {
  const [row] = await tx
    .select()
    .from(schema.intentAutonomyPromotion)
    .where(eq(schema.intentAutonomyPromotion.id, promotionId))
    .limit(1);
  return row;
}

export interface RequestStagePromotionInput {
  readonly intentId: string;
  readonly gateReportId: string;
  readonly reason: string;
}

/** A head asks for stage 3 for one intent, with a green gate report. */
export async function requestStagePromotion(
  tx: DbTransaction,
  ctx: DomainContext,
  input: RequestStagePromotionInput,
): Promise<DomainResult<{ readonly promotionId: string }>> {
  const fx = new Effects();
  const actor = personId(ctx, 'ask for a promotion');
  const reason = input.reason.trim();
  const intent = await intentOf(tx, input.intentId);
  if (intent === undefined) throw notFound('No such intent');
  let promotionId: string;
  try {
    const result = await tx.execute<{ id: string }>(
      sql`SELECT public.request_stage_promotion(${input.intentId}::uuid, ${input.gateReportId}::uuid, ${actor}::uuid, ${reason}) AS id`,
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new DomainError('conflict', 'The promotion was not created');
    promotionId = id;
  } catch (error) {
    translate(error);
  }
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.autonomyPromotionRequested,
    targetType: 'intent',
    targetId: intent.id,
    metadata: {
      intentKey: intent.key,
      promotionId,
      gateReportId: input.gateReportId,
      reason,
    },
  });
  return fx.result({ promotionId });
}

export interface DecideStagePromotionInput {
  readonly promotionId: string;
  readonly approve: boolean;
  readonly reason: string;
  /** When the person last proved who they are. Only used to approve; the database wants it inside 5 minutes. */
  readonly reauthAt?: Date | undefined;
  /** How the person proved it (`google_oidc` for a step-up at Google); only written to the audit row (T-306a C-5). */
  readonly reauthMethod?: string | undefined;
  /** The key of the intent, typed by the person. Only used to approve. */
  readonly confirmKey?: string | undefined;
}

export interface DecideStagePromotionResult {
  readonly status: 'approved' | 'rejected' | 'cancelled' | 'expired';
  /** The approver is the person who asked (allowed only for the holder of the owner permission). */
  readonly selfApproved: boolean;
}

/** The owner approves (re-auth and typed key), or somebody rejects, or the requester withdraws. */
export async function decideStagePromotion(
  tx: DbTransaction,
  ctx: DomainContext,
  input: DecideStagePromotionInput,
): Promise<DomainResult<DecideStagePromotionResult>> {
  const fx = new Effects();
  const actor = personId(ctx, 'decide a promotion');
  const reason = input.reason.trim();
  const before = await promotionOf(tx, input.promotionId);
  if (before === undefined) throw notFound('No such promotion');
  const intent = await intentOf(tx, before.intentId);
  let status: DecideStagePromotionResult['status'];
  try {
    const result = await tx.execute<{ status: DecideStagePromotionResult['status'] }>(
      sql`SELECT public.decide_stage_promotion(${input.promotionId}::uuid, ${input.approve}, ${actor}::uuid, ${reason}, ${input.reauthAt?.toISOString() ?? null}::timestamptz, ${input.confirmKey ?? null}) AS status`,
    );
    const value = result.rows[0]?.status;
    if (value === undefined) throw new DomainError('conflict', 'The decision was not recorded');
    status = value;
  } catch (error) {
    translate(error);
  }
  const selfApproved = status === 'approved' && actor === before.requestedBy;
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.autonomyPromotionDecided,
    targetType: 'intent',
    targetId: before.intentId,
    metadata: {
      intentKey: intent?.key ?? null,
      promotionId: input.promotionId,
      decision: status,
      // The owner approved a request of their own (ADR-025, owner decision 1).
      self_approved: selfApproved,
      requestedBy: before.requestedBy,
      reason,
      ...(input.approve ? { reauthMethod: input.reauthMethod ?? null } : {}),
    },
  });
  return fx.result({ status, selfApproved });
}

/** Moves an approved intent to stage 3. `expired` when 72 hours passed since the approval. */
export async function applyStagePromotion(
  tx: DbTransaction,
  ctx: DomainContext,
  input: { readonly promotionId: string },
): Promise<DomainResult<{ readonly status: 'applied' | 'expired' }>> {
  const fx = new Effects();
  const actor = personId(ctx, 'apply a promotion');
  const before = await promotionOf(tx, input.promotionId);
  if (before === undefined) throw notFound('No such promotion');
  const intent = await intentOf(tx, before.intentId);
  let status: 'applied' | 'expired';
  try {
    const result = await tx.execute<{ status: 'applied' | 'expired' }>(
      sql`SELECT public.apply_stage_promotion(${input.promotionId}::uuid, ${actor}::uuid) AS status`,
    );
    const value = result.rows[0]?.status;
    if (value === undefined) throw new DomainError('conflict', 'The promotion was not applied');
    status = value;
  } catch (error) {
    translate(error);
  }
  if (status === 'applied') {
    await recordAuditInTx(tx, ctx, fx, {
      action: AUDIT_ACTIONS.autonomyPromoted,
      targetType: 'intent',
      targetId: before.intentId,
      before: { stage: 2 },
      after: { stage: 3 },
      metadata: {
        intentKey: intent?.key ?? null,
        promotionId: input.promotionId,
        gateReportId: before.gateReportId,
        requestedBy: before.requestedBy,
        decidedBy: before.decidedBy,
        self_approved: before.selfApproved,
      },
    });
  }
  return fx.result({ status });
}

export interface RollbackIntentInput {
  readonly intentId: string;
  readonly reason: string;
  /** What triggered it, as plain facts (counts, rule names). Never customer text. */
  readonly evidence?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Stage 3 back to 2 by the system (ADR-025 section 7). Idempotent: an intent that is not at stage 3 answers
 * `rolledBack: false` and writes nothing. Works through a pin: it is the safe direction.
 */
export async function rollbackIntentAutonomy(
  tx: DbTransaction,
  ctx: DomainContext,
  input: RollbackIntentInput,
): Promise<DomainResult<{ readonly rolledBack: boolean }>> {
  const fx = new Effects();
  const reason = input.reason.trim();
  const intent = await intentOf(tx, input.intentId);
  if (intent === undefined) throw notFound('No such intent');
  let written: number;
  try {
    const result = await tx.execute<{ written: number }>(
      sql`SELECT public.rollback_intent_autonomy(${input.intentId}::uuid, ${reason}, ${JSON.stringify(input.evidence ?? {})}::jsonb) AS written`,
    );
    written = result.rows[0]?.written ?? 0;
  } catch (error) {
    translate(error);
  }
  if (written > 0) {
    await recordAuditInTx(tx, ctx, fx, {
      action: AUDIT_ACTIONS.autonomyAutoRollback,
      targetType: 'intent',
      targetId: intent.id,
      before: { stage: 3 },
      after: { stage: 2 },
      metadata: { intentKey: intent.key, reason, evidence: input.evidence ?? {} },
    });
  }
  return fx.result({ rolledBack: written > 0 });
}

export interface SetIntentAutosendInput {
  readonly intentId: string;
  readonly shadow?: boolean | undefined;
  readonly minScore?: number | undefined;
  readonly dailyCap?: number | undefined;
  /** The allow-list policy (validated by the caller's Zod schema). */
  readonly policy?: Readonly<Record<string, unknown>> | undefined;
  readonly reason: string;
}

/**
 * A head changes the auto-send rules of an intent with a reason. Loosening them on a stage 3 intent is
 * possible only here (a trigger refuses a direct UPDATE); the database checks the head permission and
 * writes the history row.
 */
export async function setIntentAutosend(
  tx: DbTransaction,
  ctx: DomainContext,
  input: SetIntentAutosendInput,
): Promise<DomainResult<{ readonly changed: boolean }>> {
  const fx = new Effects();
  const actor = personId(ctx, 'change the auto-send rules');
  const reason = input.reason.trim();
  const intent = await intentOf(tx, input.intentId);
  if (intent === undefined) throw notFound('No such intent');
  let written: number;
  try {
    const result = await tx.execute<{ written: number }>(
      sql`SELECT public.set_intent_autosend(${input.intentId}::uuid, ${input.shadow ?? null}::boolean, ${input.minScore ?? null}::numeric, ${input.dailyCap ?? null}::integer, ${input.policy === undefined ? null : JSON.stringify(input.policy)}::jsonb, ${actor}::uuid, ${reason}) AS written`,
    );
    written = result.rows[0]?.written ?? 0;
  } catch (error) {
    translate(error);
  }
  if (written > 0) {
    await recordAuditInTx(tx, ctx, fx, {
      action: AUDIT_ACTIONS.autonomyAutosendConfigSet,
      targetType: 'intent',
      targetId: intent.id,
      metadata: {
        intentKey: intent.key,
        reason,
        ...(input.shadow === undefined ? {} : { shadow: input.shadow }),
        ...(input.minScore === undefined ? {} : { minScore: input.minScore }),
        ...(input.dailyCap === undefined ? {} : { dailyCap: input.dailyCap }),
        ...(input.policy === undefined ? {} : { policyChanged: true }),
      },
    });
  }
  return fx.result({ changed: written > 0 });
}
