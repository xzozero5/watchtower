import { schema, type Database } from '@watchtower/db';
import type { AiInsightReason, AiNextStepKind, AiState } from '@watchtower/shared';
import { sql } from 'drizzle-orm';

export interface AiInsightInput {
  readonly ticketId: string;
  readonly state: AiState;
  /** Why the state is `needs_human` or `failed`. */
  readonly reasonCode?: AiInsightReason | null;
  readonly summary?: string | null;
  readonly intent?: {
    readonly key: string | null;
    readonly confidence: number | null;
    readonly reason: string | null;
  } | null;
  readonly nextStep?: { readonly kind: AiNextStepKind; readonly label: string } | null;
  readonly stage: number;
  readonly classifierRunId?: string | null;
  readonly summarizerRunId?: string | null;
  readonly generatedAt: Date;
}

export type InsightWriter = Pick<Database['db'], 'insert'>;

/**
 * Replaces the latest AI result of a ticket (one row per ticket, `ai_ticket_insight`). Evidence and
 * the draft reference are not touched here: the investigator and the drafter own them (T-108), so a
 * re-summary does not erase a draft. The history of runs is `ai_run`.
 */
export async function upsertAiInsight(db: InsightWriter, input: AiInsightInput): Promise<void> {
  const values = {
    ticketId: input.ticketId,
    state: input.state,
    reasonCode: input.reasonCode ?? null,
    summary: input.summary ?? null,
    intentKey: input.intent?.key ?? null,
    intentConfidence: input.intent?.confidence ?? null,
    intentReason: input.intent?.reason ?? null,
    nextStepKind: input.nextStep?.kind ?? null,
    nextStepLabel: input.nextStep?.label ?? null,
    stage: input.stage,
    classifierRunId: input.classifierRunId ?? null,
    summarizerRunId: input.summarizerRunId ?? null,
    generatedAt: input.generatedAt,
  };
  const update: Omit<typeof values, 'ticketId'> & { ticketId?: string } = { ...values };
  delete update.ticketId;
  await db
    .insert(schema.aiTicketInsight)
    .values(values)
    .onConflictDoUpdate({
      target: schema.aiTicketInsight.ticketId,
      set: { ...update, updatedAt: sql`now()` },
    });
}
