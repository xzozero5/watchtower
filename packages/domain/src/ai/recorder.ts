import { schema, type Database } from '@watchtower/db';
import { isUuid } from '@watchtower/shared';

/**
 * One model call as the AI layer reports it. This is `AiRunRecord` of `@watchtower/ai`, written out
 * with plain types because this package may not import `@watchtower/ai` (the dependency matrix in
 * `tools/eslint/boundaries.mjs`). Any `AiRunRecord` is assignable to it, so the recorder is an
 * `AiRunSink` in the apps (a test in `apps/worker` pins that).
 */
export interface AiRunInput {
  readonly agent: string;
  readonly provider: string;
  readonly model: string;
  readonly tier: string;
  readonly prompt: { readonly id: string; readonly version: number; readonly hash: string };
  readonly tools: readonly string[];
  readonly inputHash: string;
  /** The model's answer in redacted (placeholder) form; null when the call failed. */
  readonly output: string | null;
  readonly confidence: number | null;
  readonly redaction: {
    readonly total: number;
    readonly byKind: Readonly<Record<string, number>>;
  };
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly status: 'ok' | 'error';
  readonly errorCode: string | null;
  readonly intent: string | null;
  readonly ticketId: string | null;
  /** The procedure version the run followed (T-303c); absent or null: none. */
  readonly procedureVersionId?: string | null | undefined;
  readonly startedAt: string;
}

export interface AiRunReceipt {
  readonly id: string;
}

/** What the recorder needs: a handle that can open a transaction. The pool, never a request's. */
export type AiRunDatabase = Pick<Database['db'], 'transaction'>;

export interface AiRunRecorder {
  record(run: AiRunInput): Promise<AiRunReceipt>;
}

/**
 * Writes `ai_run` rows (ADR-008, migration 0010). Each row is its own short transaction on the
 * pool, not part of whatever transaction the caller is in: the audit of a model call must survive
 * a rollback of the work around it (the call happened and cost money). The table is append-only
 * for the application role, so a row can be added and never changed.
 *
 * Returns the row id so the caller can link to it (`inbound classification.aiRunId`,
 * `ai_ticket_insight.classifier_run_id`). A failed write throws; `createAuditedLlm` then withholds
 * the model's answer (fail closed, N4).
 */
export function createAiRunRecorder(options: { readonly db: AiRunDatabase }): AiRunRecorder {
  return {
    async record(run) {
      if (run.ticketId !== null && !isUuid(run.ticketId)) {
        throw new Error('ai_run needs a ticket uuid or null');
      }
      const startedAt = new Date(run.startedAt);
      if (Number.isNaN(startedAt.getTime())) throw new Error('ai_run needs a valid start time');
      return options.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(schema.aiRun)
          .values({
            startedAt,
            agent: run.agent,
            ticketId: run.ticketId,
            intent: run.intent,
            procedureVersionId: run.procedureVersionId ?? null,
            provider: run.provider,
            model: run.model,
            tier: run.tier,
            promptId: run.prompt.id,
            promptVersion: run.prompt.version,
            promptHash: run.prompt.hash,
            tools: [...run.tools],
            inputHmac: run.inputHash,
            output: run.output,
            confidence: run.confidence,
            redaction: { total: run.redaction.total, byKind: { ...run.redaction.byKind } },
            inputTokens: Math.round(run.inputTokens),
            outputTokens: Math.round(run.outputTokens),
            costUsd: run.costUsd === null ? null : run.costUsd.toFixed(8),
            latencyMs: Math.round(run.latencyMs),
            status: run.status,
            errorCode: run.errorCode,
          })
          .returning({ id: schema.aiRun.id });
        if (row === undefined) throw new Error('ai_run insert returned no row');
        return { id: row.id };
      });
    },
  };
}
