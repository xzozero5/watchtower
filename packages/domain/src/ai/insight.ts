import { schema, type Database } from '@watchtower/db';
import type {
  AiEvidence,
  AiInsightReason,
  AiNextStepKind,
  AiProgress,
  AiReport,
  AiState,
} from '@watchtower/shared';
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

export interface InvestigationWrite {
  readonly ticketId: string;
  readonly state: AiState;
  readonly stage: number;
  readonly generatedAt: Date;
  /** A field left out is not touched; `null` clears it. */
  readonly reasonCode?: AiInsightReason | null;
  readonly evidence?: readonly AiEvidence[];
  readonly report?: AiReport | null;
  readonly progress?: AiProgress | null;
  readonly draftId?: string | null;
  readonly nextStep?: { readonly kind: AiNextStepKind; readonly label: string } | null;
  readonly requestedBy?: string | null;
  readonly investigatedAt?: Date | null;
}

/**
 * The investigator's and drafter's share of `ai_ticket_insight` (T-108). It is a partial upsert: the
 * classifier's and summarizer's columns (summary, intent) are left alone, so a re-run of one agent
 * never erases another's work. The row is created when it does not exist yet, with what is given.
 */
export async function writeAiInvestigation(
  db: InsightWriter,
  input: InvestigationWrite,
): Promise<void> {
  const fields = {
    state: input.state,
    stage: input.stage,
    generatedAt: input.generatedAt,
    ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
    ...(input.evidence === undefined ? {} : { evidence: [...input.evidence] }),
    ...(input.report === undefined ? {} : { report: input.report }),
    ...(input.progress === undefined ? {} : { progress: input.progress }),
    ...(input.draftId === undefined ? {} : { draftId: input.draftId }),
    ...(input.nextStep === undefined
      ? {}
      : {
          nextStepKind: input.nextStep?.kind ?? null,
          nextStepLabel: input.nextStep?.label ?? null,
        }),
    ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
    ...(input.investigatedAt === undefined ? {} : { investigatedAt: input.investigatedAt }),
  };
  await db
    .insert(schema.aiTicketInsight)
    .values({ ticketId: input.ticketId, ...fields })
    .onConflictDoUpdate({
      target: schema.aiTicketInsight.ticketId,
      set: { ...fields, updatedAt: sql`now()` },
    });
}
