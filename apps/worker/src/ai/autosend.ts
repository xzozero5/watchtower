import {
  gradePreSend,
  resolveModel,
  type AgentDeps,
  type InvestigationEvidence,
  type SettingsSource,
} from '@watchtower/ai';
import { schema, type Database } from '@watchtower/db';
import {
  DomainError,
  composeAutoSendText,
  effectiveStage,
  noteAutoSendHeld,
  readAutosendDisclosure,
  readSwitchState,
  recordAutoSendEvaluation,
  recordPreSendGrade,
  type Domain,
} from '@watchtower/domain';
import type { RealtimeEvent } from '@watchtower/shared';
import { inArray } from 'drizzle-orm';

import type { WorkerLogger } from '../logger.js';
import type { RealtimeSink } from '../realtime.js';

/**
 * Stage 3 in the worker (T-304c, ADR-025 sections 3 and 4). After the drafter has written a draft, and only
 * for an intent whose stage allows it, this step:
 *
 *   compose (the draft plus the notice that the reply is automatic)
 *     -> the independent grader reads that exact text (`grader_pre_send`, a model other than the drafter's)
 *     -> `ai_grade` (the database hashes the text)
 *     -> the gate evaluates the twelve conditions from the tables (`evaluateAutoSend`)
 *     -> `ai_autosend_evaluation` ('shadow' or 'live')
 *     -> live and allowed: `scheduleAutoSend` (message + `ai_auto` delivery held 120 s). Anything else: the
 *        draft stays a draft for a person; live and refused adds the note "AI meant to send but was held".
 *
 * Shadow mode asks the same question for an intent that is not promoted (the flag, the cap switch and the
 * stage are taken as given) and never sends. This function never throws: a failure here must not make the
 * investigation job retry (a retry would write another draft); the draft is already saved and a person
 * handles it.
 */

export interface AutoSendStepDeps {
  readonly database: Database;
  readonly domain: Domain;
  readonly settings: SettingsSource;
  readonly realtime: RealtimeSink;
  readonly logger: WorkerLogger;
  /** `AI_AUTOSEND_ENABLED` of this process. */
  readonly flagOn: boolean;
}

export interface AutoSendStepInput {
  readonly ticket: { readonly id: string; readonly channel: string };
  readonly intent: {
    readonly id: string;
    readonly key: string;
    readonly stage: number;
    readonly autosendShadow: boolean;
  };
  readonly draft: {
    readonly id: string;
    readonly body: string;
    readonly aiRunId: string | null;
    readonly language: 'th' | 'en';
    readonly citedEvidenceIds: readonly string[];
  };
  readonly evidence: readonly InvestigationEvidence[];
  /** What the customer wrote, oldest first. */
  readonly customerTurns: readonly string[];
  readonly agents: AgentDeps;
  readonly locale: 'th' | 'en';
  readonly signal?: AbortSignal;
}

export type AutoSendStepResult = 'off' | 'shadow' | 'scheduled' | 'held' | 'error';

async function modelsOf(
  db: Database['db'],
  runIds: readonly (string | null)[],
): Promise<Map<string, { provider: string; model: string }>> {
  const ids = runIds.filter((id): id is string => id !== null);
  const found = new Map<string, { provider: string; model: string }>();
  if (ids.length === 0) return found;
  const rows = await db
    .select({ id: schema.aiRun.id, provider: schema.aiRun.provider, model: schema.aiRun.model })
    .from(schema.aiRun)
    .where(inArray(schema.aiRun.id, [...ids]));
  for (const row of rows) found.set(row.id, { provider: row.provider, model: row.model });
  return found;
}

export async function runAutoSendStep(
  deps: AutoSendStepDeps,
  input: AutoSendStepInput,
): Promise<AutoSendStepResult> {
  const db = deps.database.db;
  try {
    const switches = await readSwitchState(db);
    if (switches.killSwitch) return 'off';
    const stage = effectiveStage(input.intent.stage, deps.flagOn);
    // "Limit all intents to stage 2" turns a live intent into a shadow one: nothing is sent, and what would
    // have been sent is still measured.
    const live = stage >= 3 && !switches.stageCapPinned;
    const shadow = !live && input.intent.autosendShadow && stage >= 2;
    if (!live && !shadow) return 'off';
    const mode = live ? 'live' : 'shadow';

    const ctx = deps.domain.context({ actor: { type: 'ai', id: null } });
    const gate = ctx.policyGate;
    if (gate?.evaluateAutoSend === undefined) return 'off';

    const settings = await deps.settings.load();
    const drafterRef = resolveModel(settings, 'drafter');
    const graderRef = resolveModel(settings, 'grader');
    const disclosure = await readAutosendDisclosure(db);
    const text = composeAutoSendText(input.draft.body, disclosure, input.draft.language);
    const actor = { type: 'ai', id: null } as const;
    const request = (gradeId: string) =>
      ({
        ticketId: input.ticket.id,
        channel: input.ticket.channel,
        intentId: input.intent.id,
        actor,
        origin: 'ai_auto',
        autoSend: {
          aiDraftId: input.draft.id,
          aiGradeId: gradeId,
          text,
          attachmentCount: 0,
          hasHtml: false,
        },
      }) as const;

    const record = async (
      failed: readonly string[],
      gradeId: string | null,
      facts: Record<string, unknown>,
    ): Promise<void> => {
      await recordAutoSendEvaluation(db, {
        aiDraftId: input.draft.id,
        ticketId: input.ticket.id,
        intentId: input.intent.id,
        mode,
        failedConditions: failed,
        effectiveStage: stage,
        aiGradeId: gradeId,
        facts,
      });
    };
    const held = async (reason: string, failed: readonly string[]): Promise<AutoSendStepResult> => {
      if (mode === 'live') {
        await noteAutoSendHeld(db, actor, {
          ticketId: input.ticket.id,
          aiDraftId: input.draft.id,
          reason,
          failed,
        });
        return 'held';
      }
      return 'shadow';
    };

    // The owner's rule (decision 2): the grader is a model other than the drafter's. When the settings give
    // both the same model there is no point in calling it: the answer could never be used.
    if (graderRef.provider === drafterRef.provider && graderRef.model === drafterRef.model) {
      await record(['grader_not_independent', 'grade_missing'], null, { reason: 'same_model' });
      return held('grader_not_independent', ['grader_not_independent', 'grade_missing']);
    }

    const cited = new Set(input.draft.citedEvidenceIds);
    const graded = await gradePreSend(input.agents, {
      ticketId: input.ticket.id,
      intentKey: input.intent.key,
      locale: input.locale,
      customerTurns: input.customerTurns,
      reply: text,
      sources: input.evidence
        .filter((card) => card.customerSafe && cited.has(card.id))
        .map((card) => ({ id: card.id, title: card.title, snippet: card.snippet })),
      ...(input.signal === undefined ? {} : { abortSignal: input.signal }),
    });
    if (graded.status !== 'ok') {
      // No grade: nothing can clear the send. Record it and leave the draft to a person.
      await record(['grade_missing'], null, { grader: graded.status, reason: graded.reason });
      return held('grade_missing', ['grade_missing']);
    }
    const runs = await modelsOf(db, [graded.runId]);
    const graderRun = graded.runId === null ? undefined : runs.get(graded.runId);
    const draftRun = (await modelsOf(db, [input.draft.aiRunId ?? null])).get(input.draft.aiRunId ?? '');
    const gradeId = await recordPreSendGrade(db, {
      aiDraftId: input.draft.id,
      ticketId: input.ticket.id,
      text,
      graderAiRunId: graded.runId,
      graderProvider: graderRun?.provider ?? graderRef.provider,
      graderModel: graderRun?.model ?? graderRef.model,
      drafterProvider: draftRun?.provider ?? drafterRef.provider,
      drafterModel: draftRun?.model ?? drafterRef.model,
      score: graded.value.score,
      passed: graded.value.passed,
      violations: graded.value.violations,
      promptVersion: graded.value.promptVersion,
      mock: graded.value.mock,
    });

    const evaluation = await gate.evaluateAutoSend(request(gradeId), mode);
    await record(evaluation.failed, gradeId, { ...evaluation.summary });
    if (mode === 'shadow') return 'shadow';
    if (evaluation.failed.length > 0) {
      return held(evaluation.failed[0] ?? 'policy_denied', evaluation.failed);
    }

    try {
      const events: RealtimeEvent[] = [];
      await db.transaction(async (tx) => {
        const result = await deps.domain.outbound.scheduleAutoSend(tx, ctx, {
          ref: input.ticket.id,
          aiDraftId: input.draft.id,
          aiGradeId: gradeId,
          text,
        });
        events.push(...result.events);
      });
      for (const event of events) {
        await deps.realtime.publish(event).catch((error: unknown) => {
          deps.logger.warn({ err: error, eventType: event.type }, 'realtime publish failed');
        });
      }
      return 'scheduled';
    } catch (error) {
      const reason =
        error instanceof DomainError
          ? String((error.details as { reason?: unknown } | undefined)?.reason ?? error.code)
          : 'schedule_failed';
      if (!(error instanceof DomainError)) {
        deps.logger.error({ err: error, ticketId: input.ticket.id }, 'automatic send could not be scheduled');
      }
      return held(reason, [reason]);
    }
  } catch (error) {
    deps.logger.error({ err: error, ticketId: input.ticket.id }, 'auto-send step failed');
    return 'error';
  }
}
