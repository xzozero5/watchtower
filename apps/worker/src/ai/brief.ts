import {
  classifyTicket,
  summarizeTicket,
  type TicketClassification,
  type TicketSummary,
  type TicketTurn,
} from '@watchtower/ai';
import { schema, type Database } from '@watchtower/db';
import { effectiveStage, upsertAiInsight } from '@watchtower/domain';
import {
  AI_JOBS,
  aiSummarizeJobSchema,
  type AiInsightReason,
  type AiNextStepKind,
} from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';
import { asc, eq } from 'drizzle-orm';

import type { WorkerLogger } from '../logger.js';
import { loadActiveIntents } from './classifier-hook.js';
import type { AiRuntime } from './runtime.js';

/** Contacts of the organization whose names the redactor should know (the ticket's participants). */
const MAX_NAMES = 200;
const MAX_MESSAGES = 60;

/** What a person sees when the AI did not read the ticket. Stable copy, keyed by the reason code. */
export const NEEDS_HUMAN_LABELS: Readonly<Record<AiInsightReason, string>> = {
  kill_switch_on: 'AI is switched off. Read the ticket.',
  policy_denied: 'AI may not act here. Read the ticket.',
  budget_stop: 'AI daily budget reached. Read the ticket.',
  name_match_limit: 'This message is too unusual for AI. Read the ticket.',
  model_output_invalid: 'AI gave no usable answer. Read the ticket.',
  provider_error: 'AI could not be reached. Read the ticket.',
  provider_unavailable: 'AI is not set up. Read the ticket.',
  audit_failed: 'AI could not be recorded. Read the ticket.',
};

export interface BriefDeps {
  readonly database: Database;
  readonly ai: AiRuntime | undefined;
  readonly logger: WorkerLogger;
  readonly now?: () => Date;
}

export interface BriefResult {
  readonly status: 'classified' | 'needs_human' | 'failed' | 'missing';
  readonly reason?: AiInsightReason;
}

class BriefFailedError extends Error {
  constructor(reason: AiInsightReason) {
    super(`The AI brief failed (${reason})`);
    this.name = 'BriefFailedError';
  }
}

/**
 * Makes the AI brief of one ticket (T-106e): classify, summarize, and upsert `ai_ticket_insight`.
 *
 * - Everything the model sees goes through one redaction session scoped to the ticket; both agents
 *   write their own `ai_run` row.
 * - No model call is made when the guard says no (kill switch, policy, daily budget) or when
 *   redaction refuses the text (`NameMatchLimitError`): the insight is `needs_human` with the reason
 *   code, and the job is done (retrying would not change the answer).
 * - A provider error or an unusable answer writes a `failed` insight and throws, so BullMQ retries;
 *   a later attempt that works replaces it.
 * - Nothing here writes to a customer (N3): the insight is for staff only.
 */
export async function makeAiBrief(deps: BriefDeps, ticketId: string): Promise<BriefResult> {
  const db = deps.database.db;
  const now = deps.now ?? ((): Date => new Date());

  const [ticket] = await db
    .select({
      id: schema.ticket.id,
      subject: schema.ticket.subject,
      channel: schema.ticket.channel,
      orgId: schema.ticket.orgId,
      intentId: schema.ticket.intentId,
    })
    .from(schema.ticket)
    .where(eq(schema.ticket.id, ticketId))
    .limit(1);
  if (ticket === undefined) return { status: 'missing' };

  const write = (
    fields: Omit<Parameters<typeof upsertAiInsight>[1], 'ticketId' | 'generatedAt' | 'stage'> & {
      stage?: number;
    },
  ) =>
    upsertAiInsight(db, {
      ticketId,
      generatedAt: now(),
      stage: 0,
      ...fields,
    });
  const needsHuman = async (reason: AiInsightReason, partial = {}): Promise<BriefResult> => {
    await write({
      state: 'needs_human',
      reasonCode: reason,
      nextStep: { kind: 'other', label: NEEDS_HUMAN_LABELS[reason] },
      ...partial,
    });
    return { status: 'needs_human', reason };
  };

  const runtime = deps.ai;
  if (runtime === undefined) return needsHuman('provider_unavailable');

  const [messages, contacts, intents, ownIntent] = await Promise.all([
    db
      .select({
        direction: schema.message.direction,
        visibility: schema.message.visibility,
        text: schema.message.bodyText,
      })
      .from(schema.message)
      .where(eq(schema.message.ticketId, ticketId))
      .orderBy(asc(schema.message.createdAt))
      .limit(MAX_MESSAGES),
    db
      .select({ name: schema.contact.name })
      .from(schema.contact)
      .where(eq(schema.contact.orgId, ticket.orgId))
      .limit(MAX_NAMES),
    loadActiveIntents(db),
    ticket.intentId === null
      ? Promise.resolve(undefined)
      : db
          .select({ key: schema.intent.key })
          .from(schema.intent)
          .where(eq(schema.intent.id, ticket.intentId))
          .limit(1)
          .then((rows) => rows[0]),
  ]);

  const turns: TicketTurn[] = messages.map((message) => ({
    from:
      message.visibility === 'internal'
        ? 'note'
        : message.direction === 'inbound'
          ? 'customer'
          : 'staff',
    text: message.text,
  }));
  const firstCustomer = turns.find((turn) => turn.from === 'customer')?.text ?? '';

  const agents = runtime.agentDeps(contacts.map((contact) => contact.name));
  const session = agents.redactor.session({ scope: ticketId });

  const classified = await classifyTicket(agents, {
    ticketId,
    scope: ticketId,
    session,
    channel: ticket.channel,
    subject: ticket.subject,
    body: firstCustomer,
    intents,
  });
  if (classified.status === 'skipped') return needsHuman(classified.reason);
  if (classified.status === 'failed') {
    await write({ state: 'failed', reasonCode: classified.reason });
    throw new BriefFailedError(classified.reason);
  }
  const classification: TicketClassification = classified.value;
  const intentKey = classification.intentKey ?? ownIntent?.key ?? null;
  const stage = effectiveStage(intents.find((intent) => intent.key === intentKey)?.stage ?? 0);
  const known = {
    intent: {
      key: classification.intentKey,
      confidence: classification.confidence,
      reason: classification.reason,
    },
    stage,
    classifierRunId: classified.runId,
  };

  const summarized = await summarizeTicket(agents, {
    ticketId,
    scope: ticketId,
    session,
    subject: ticket.subject,
    turns,
    intentKey,
  });
  if (summarized.status === 'skipped') return needsHuman(summarized.reason, known);
  if (summarized.status === 'failed') {
    await write({ state: 'failed', reasonCode: summarized.reason, ...known });
    throw new BriefFailedError(summarized.reason);
  }
  const summary: TicketSummary = summarized.value;
  await write({
    state: 'classified',
    summary: summary.summary,
    nextStep: { kind: summary.nextStep.kind as AiNextStepKind, label: summary.nextStep.label },
    summarizerRunId: summarized.runId,
    ...known,
  });
  return { status: 'classified' };
}

/** The BullMQ processor of the `ai` queue. */
export function createAiProcessor(deps: BriefDeps) {
  return async (job: Job): Promise<BriefResult> => {
    if (job.name !== AI_JOBS.summarize) {
      throw new UnrecoverableError(`unknown ai job "${job.name}"`);
    }
    const parsed = aiSummarizeJobSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError('ai job payload is invalid');
    const result = await makeAiBrief(deps, parsed.data.ticketId);
    deps.logger.info(
      { ticketId: parsed.data.ticketId, status: result.status, reason: result.reason },
      'ai brief',
    );
    return result;
  };
}
