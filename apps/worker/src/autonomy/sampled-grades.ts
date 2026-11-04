import { gradePreSend } from '@watchtower/ai';
import { schema, type Database } from '@watchtower/db';
import {
  findSampleCandidates,
  readAutosendSampling,
  recordPreSendGrade,
  type SampleCandidate,
} from '@watchtower/domain';
import { detectLanguage } from '@watchtower/shared';
import { and, desc, eq } from 'drizzle-orm';

import { modelsOf } from '../ai/autosend.js';
import { ticketPeopleNames, warnIfIncomplete } from '../ai/people-names.js';
import type { AiRuntime } from '../ai/runtime.js';
import type { WorkerLogger } from '../logger.js';

/**
 * Sampled grades of automatic replies that were sent (T-306e C-4c, ADR-025 section 7). For one intent at stage 3,
 * takes the sent `ai_auto` replies the sampling picks (the first 20 after a promotion all of them, then 20%, both
 * settable in `instance_setting` `autosend.sampling`) that have no `sampled` grade yet, has the independent grader
 * read what the customer actually got, and stores the verdict (`ai_grade`, phase `sampled`). A violation in it is
 * what the watch's first rule rolls the intent back on, in the same run.
 *
 * It only measures: nothing here sends or changes a ticket (N3). A reply the guard or the redactor refuses to grade
 * is left for the next run; so is one whose drafter or grader `ai_run` row cannot be found (the models cannot be
 * vouched for). Never throws: a failed grade must not stop the watch from looking at the other rules.
 */

export interface SampledGradeDeps {
  readonly database: Pick<Database, 'db'>;
  readonly ai?: AiRuntime | undefined;
  readonly logger: WorkerLogger;
}

export interface SampledGradeResult {
  readonly picked: number;
  readonly graded: number;
  readonly violations: number;
}

const MAX_PER_RUN = 10;

export async function sampleSentReplies(
  deps: SampledGradeDeps,
  intent: { readonly id: string; readonly key: string },
): Promise<SampledGradeResult> {
  const none: SampledGradeResult = { picked: 0, graded: 0, violations: 0 };
  const runtime = deps.ai;
  if (runtime === undefined) return none;
  const db = deps.database.db;
  let candidates: SampleCandidate[];
  try {
    const sampling = await readAutosendSampling(db);
    candidates = await findSampleCandidates(db, intent.id, sampling, MAX_PER_RUN);
  } catch (error) {
    deps.logger.error({ err: error, intent: intent.key }, 'could not pick replies to sample');
    return none;
  }
  let graded = 0;
  let violations = 0;
  for (const candidate of candidates) {
    try {
      const outcome = await gradeOne(deps, runtime, intent, candidate);
      if (outcome === null) continue;
      graded += 1;
      violations += outcome;
    } catch (error) {
      deps.logger.error(
        { err: error, intent: intent.key, ticketId: candidate.ticketId },
        'sampled grade failed',
      );
    }
  }
  return { picked: candidates.length, graded, violations };
}

/** Grades one reply; returns its violation count, or null when nothing was recorded. */
async function gradeOne(
  deps: SampledGradeDeps,
  runtime: AiRuntime,
  intent: { readonly id: string; readonly key: string },
  candidate: SampleCandidate,
): Promise<number | null> {
  const db = deps.database.db;
  const [ticket] = await db
    .select({
      id: schema.ticket.id,
      orgId: schema.ticket.orgId,
      requesterContactId: schema.ticket.requesterContactId,
    })
    .from(schema.ticket)
    .where(eq(schema.ticket.id, candidate.ticketId))
    .limit(1);
  const [draft] = await db
    .select({ aiRunId: schema.aiDraft.aiRunId, citations: schema.aiDraft.citations })
    .from(schema.aiDraft)
    .where(eq(schema.aiDraft.id, candidate.aiDraftId))
    .limit(1);
  if (ticket === undefined || draft === undefined) return null;

  const turns = await db
    .select({ text: schema.message.bodyText })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.ticketId, ticket.id),
        eq(schema.message.direction, 'inbound'),
        eq(schema.message.visibility, 'public'),
      ),
    )
    .orderBy(desc(schema.message.createdAt), desc(schema.message.id))
    .limit(4);
  const customerTurns = turns.map((turn) => turn.text).reverse();

  // The passages the reply cited, from the cards the investigator stored (customer-facing ones only).
  const [insight] = await db
    .select({ evidence: schema.aiTicketInsight.evidence })
    .from(schema.aiTicketInsight)
    .where(eq(schema.aiTicketInsight.ticketId, ticket.id))
    .limit(1);
  const cited = new Set(draft.citations.map((citation) => citation.evidenceId));
  const sources: { id: string; title: string; snippet: string }[] = [];
  for (const card of Array.isArray(insight?.evidence) ? (insight.evidence as unknown[]) : []) {
    if (typeof card !== 'object' || card === null) continue;
    const { id, kind, customerSafe, title, snippet } = card as Record<string, unknown>;
    if (
      typeof id === 'string' &&
      kind === 'kb' &&
      customerSafe === true &&
      cited.has(id) &&
      typeof title === 'string' &&
      typeof snippet === 'string'
    ) {
      sources.push({ id, title, snippet });
    }
  }

  const people = await ticketPeopleNames(db, ticket);
  warnIfIncomplete(deps.logger, ticket.id, people);
  const agents = runtime.agentDeps(people.names, { dictionaryIncomplete: !people.complete });
  const graded = await gradePreSend(agents, {
    ticketId: ticket.id,
    intentKey: intent.key,
    locale: detectLanguage(candidate.text) === 'th' ? 'th' : 'en',
    customerTurns,
    reply: candidate.text,
    sources,
  });
  // Refused (kill switch, budget, redaction) or no usable answer: nothing to store, the next run asks again.
  if (graded.status !== 'ok') return null;

  const runs = await modelsOf(db, [graded.runId, draft.aiRunId]);
  const graderRun = graded.runId === null ? undefined : runs.get(graded.runId);
  const draftRun = draft.aiRunId === null ? undefined : runs.get(draft.aiRunId);
  if (graded.runId === null || graderRun === undefined || draftRun === undefined) {
    deps.logger.warn(
      { ticketId: ticket.id },
      'sampled grade not stored: the ai_run row of the drafter or the grader is missing',
    );
    return null;
  }
  await recordPreSendGrade(db, {
    phase: 'sampled',
    aiDraftId: candidate.aiDraftId,
    ticketId: ticket.id,
    text: candidate.text,
    graderAiRunId: graded.runId,
    score: graded.value.score,
    passed: graded.value.passed,
    violations: graded.value.violations,
    promptVersion: graded.value.promptVersion,
  });
  return graded.value.violations.length;
}
