import { classifyRedacted, type AgentDeps } from '@watchtower/ai';
import { schema, type Database } from '@watchtower/db';
import { eq } from 'drizzle-orm';

import type { InboundClassifierFactory } from '../ingest/classifier.js';
import type { WorkerLogger } from '../logger.js';

/** The classifier gave no usable answer; the ingest falls back to the header rules. */
export class AiClassifierUnavailableError extends Error {
  constructor(reason: string) {
    super(`The AI classifier gave no answer (${reason})`);
    this.name = `AiClassifier_${reason}`;
  }
}

/** The active intents the instance defines, for the classifier's list. */
export async function loadActiveIntents(
  db: Pick<Database['db'], 'select'>,
): Promise<{ key: string; name: string; stage: number }[]> {
  const rows = await db
    .select({
      key: schema.intent.key,
      name: schema.intent.name,
      stage: schema.intent.autonomyStage,
    })
    .from(schema.intent)
    .where(eq(schema.intent.isActive, true))
    .orderBy(schema.intent.key);
  return rows;
}

/**
 * The ingest classifier (ADR-009 step 4, PRD section 5.1 step 3) backed by the `classifyTicket`
 * agent. Each message gets its own hook with its own redaction session: `redact` and `classify`
 * share it, so the `ai_run` row carries that session's counts. A refusal (kill switch, budget,
 * policy), a failed call or an unusable answer throws, and `classifyMessage` then uses the header
 * rules; ingestion never waits for an LLM and never fails because of one.
 */
export function createAiClassifierFactory(options: {
  readonly agentDeps: (names: readonly string[]) => AgentDeps;
  readonly database: Database;
  readonly logger: WorkerLogger;
}): InboundClassifierFactory {
  return (scope, participants) => {
    const deps = options.agentDeps(participants);
    const session = deps.redactor.session({ scope });
    return {
      redact: (text) => session.redact(text),
      async classify(input, signal) {
        const intents = await loadActiveIntents(options.database.db);
        const outcome = await classifyRedacted(deps, {
          ticketId: null,
          session,
          channel: input.channel,
          subject: input.subject,
          body: input.body,
          intents,
          abortSignal: signal,
        });
        if (outcome.status !== 'ok') throw new AiClassifierUnavailableError(outcome.reason);
        return {
          type: outcome.value.type,
          intentKey: outcome.value.intentKey,
          confidence: outcome.value.confidence,
          source: 'ai',
          aiRunId: outcome.runId,
        };
      },
    };
  };
}
