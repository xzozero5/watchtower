import { schema, type Database } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  AUTOSEND_DISCLOSURE_KEY,
  AUTONOMY_TICKET_EVENTS,
  autosendDisclosureSchema,
  type AutosendDisclosure,
} from '@watchtower/shared';
import { and, eq, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { recordTicketEvent } from '../tickets/support.js';
import { Effects, type Actor, type DbTransaction, type DomainContext, type DomainResult, type ReadExecutor } from '../types.js';

/** The writes of the stage 3 runtime that are not a send: the pre-send grade, the evaluation, the "held" note. */

type Db = Pick<Database['db'], 'insert' | 'select' | 'transaction'>;

export interface NewPreSendGrade {
  readonly aiDraftId: string;
  readonly ticketId: string;
  /** What the grader read: the draft plus the notice, exactly as it would be sent. The database hashes it. */
  readonly text: string;
  readonly graderAiRunId: string | null;
  readonly graderProvider: string;
  readonly graderModel: string;
  readonly drafterProvider: string;
  readonly drafterModel: string;
  readonly score: number;
  readonly passed: boolean;
  readonly violations: readonly { readonly code: string; readonly text: string }[];
  readonly promptVersion: number;
  readonly mock: boolean;
}

/** Stores the grade of one exact text (`phase = 'pre_send'`). Append-only; the hash is the database's. */
export async function recordPreSendGrade(db: Pick<Db, 'insert'>, grade: NewPreSendGrade): Promise<string> {
  const [row] = await db
    .insert(schema.aiGrade)
    .values({
      aiDraftId: grade.aiDraftId,
      ticketId: grade.ticketId,
      phase: 'pre_send',
      gradedText: grade.text,
      graderAiRunId: grade.graderAiRunId,
      graderProvider: grade.graderProvider,
      graderModel: grade.graderModel,
      drafterProvider: grade.drafterProvider,
      drafterModel: grade.drafterModel,
      // numeric(4,3): a string keeps 0.9 exactly 0.9.
      score: grade.score.toFixed(3),
      passed: grade.passed,
      violations: grade.violations.map((violation) => ({ ...violation })),
      violationCount: grade.violations.length,
      promptVersion: grade.promptVersion,
      mock: grade.mock,
    })
    .returning({ id: schema.aiGrade.id });
  if (row === undefined) throw new Error('ai_grade insert returned no row');
  return row.id;
}

export interface NewAutoSendEvaluation {
  readonly aiDraftId: string;
  readonly ticketId: string;
  readonly intentId: string;
  readonly mode: 'shadow' | 'live';
  readonly failedConditions: readonly string[];
  readonly effectiveStage: number;
  readonly aiGradeId: string | null;
  /** Counts and flags only. */
  readonly facts: Readonly<Record<string, unknown>>;
}

/** One row each time the decision is evaluated (ADR-025 section 3). `would_auto_send` is derived from the list. */
export async function recordAutoSendEvaluation(
  db: Pick<Db, 'insert'>,
  evaluation: NewAutoSendEvaluation,
): Promise<string> {
  const [row] = await db
    .insert(schema.aiAutosendEvaluation)
    .values({
      aiDraftId: evaluation.aiDraftId,
      ticketId: evaluation.ticketId,
      intentId: evaluation.intentId,
      mode: evaluation.mode,
      wouldAutoSend: evaluation.failedConditions.length === 0,
      failedConditions: [...evaluation.failedConditions],
      effectiveStage: Math.max(0, Math.min(3, evaluation.effectiveStage)),
      aiGradeId: evaluation.aiGradeId,
      facts: { ...evaluation.facts },
    })
    .returning({ id: schema.aiAutosendEvaluation.id });
  if (row === undefined) throw new Error('ai_autosend_evaluation insert returned no row');
  return row.id;
}

/**
 * One audit row per boot of a process that runs with `AI_AUTOSEND_ENABLED=true` (ADR-025 section 2): the
 * owner can see from the log when, and in which process, the instance could send on its own.
 */
export async function recordAutosendFlagBoot(
  db: Pick<Db, 'insert'>,
  processName: 'api' | 'worker',
): Promise<void> {
  await recordAuditInTx(
    db,
    { actor: { type: 'system', id: null }, auditMeta: { ip: null, requestId: null } },
    { audited: false },
    {
      action: AUDIT_ACTIONS.autonomyAutosendFlagBoot,
      targetType: null,
      targetId: null,
      metadata: { process: processName },
    },
  );
}

/**
 * The note on the ticket "AI meant to send but was held: <reason>" and its audit row, once per draft (a retry
 * of the same step does not write it twice). The reason is a code, never text.
 */
export async function noteAutoSendHeld(
  db: Pick<Db, 'transaction'>,
  actor: Actor,
  input: { readonly ticketId: string; readonly aiDraftId: string; readonly reason: string; readonly failed: readonly string[] },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`held:${input.aiDraftId}`}, 2))`);
    const [seen] = await tx
      .select({ id: schema.ticketEvent.id })
      .from(schema.ticketEvent)
      .where(
        and(
          eq(schema.ticketEvent.ticketId, input.ticketId),
          eq(schema.ticketEvent.type, AUTONOMY_TICKET_EVENTS.autosendHeld),
          sql`${schema.ticketEvent.payload}->>'aiDraftId' = ${input.aiDraftId}`,
        ),
      )
      .limit(1);
    if (seen !== undefined) return false;
    await recordTicketEvent(tx, input.ticketId, AUTONOMY_TICKET_EVENTS.autosendHeld, actor, 'internal', {
      aiDraftId: input.aiDraftId,
      reason: input.reason,
      failed: [...input.failed],
    });
    await recordAuditInTx(
      tx,
      { actor, auditMeta: { ip: null, requestId: null } },
      { audited: false },
      {
        action: AUDIT_ACTIONS.autonomyAutosendHeld,
        outcome: 'denied',
        targetType: 'ticket',
        targetId: input.ticketId,
        metadata: { stage: 'schedule', aiDraftId: input.aiDraftId, reason: input.reason, failed: [...input.failed] },
      },
    );
    return true;
  });
}

/** The notice added to an automatic reply (ADR-025 section 8); undefined when the row is missing or unreadable (the default applies). */
export async function readAutosendDisclosure(db: ReadExecutor): Promise<AutosendDisclosure | undefined> {
  const [row] = await db
    .select({ value: schema.instanceSetting.value })
    .from(schema.instanceSetting)
    .where(eq(schema.instanceSetting.key, AUTOSEND_DISCLOSURE_KEY))
    .limit(1);
  const parsed = autosendDisclosureSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : undefined;
}

/** A head changes the notice, or turns it off, with a reason; the audit row keeps both values (owner decision 3). */
export async function setAutosendDisclosure(
  tx: DbTransaction,
  ctx: DomainContext,
  input: AutosendDisclosure & { readonly reason: string },
): Promise<DomainResult<{ readonly changed: boolean }>> {
  const fx = new Effects();
  if (ctx.actor.type !== 'user' || ctx.actor.id === null) {
    throw new Error('Only a signed-in person changes the notice of automatic replies');
  }
  const before = await readAutosendDisclosure(tx);
  const next: AutosendDisclosure = { enabled: input.enabled, text: { th: input.text.th.trim(), en: input.text.en.trim() } };
  const changed = JSON.stringify(before) !== JSON.stringify(next);
  if (changed) {
    await tx
      .update(schema.instanceSetting)
      .set({ value: next, updatedBy: ctx.actor.id, updatedAt: ctx.now() })
      .where(eq(schema.instanceSetting.key, AUTOSEND_DISCLOSURE_KEY));
    await recordAuditInTx(tx, ctx, fx, {
      action: AUDIT_ACTIONS.autonomyDisclosureSet,
      targetType: 'instance_setting',
      targetId: null,
      before: before ?? null,
      after: next,
      metadata: { reason: input.reason.trim(), enabled: next.enabled },
    });
  }
  return fx.result({ changed });
}
