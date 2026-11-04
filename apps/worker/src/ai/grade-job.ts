import { buildGradeFacts, gradeResolution, type TicketTurn } from '@watchtower/ai';
import { schema, type Database } from '@watchtower/db';
import { TicketKeys, hasResolutionGrade, recordResolutionGrade } from '@watchtower/domain';
import { detectLanguage, type AiInsightReason } from '@watchtower/shared';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import type { WorkerLogger } from '../logger.js';
import { ticketPeopleNames, warnIfIncomplete } from './people-names.js';
import type { AiRuntime } from './runtime.js';

const MAX_MESSAGES = 60;

export interface GradeDeps {
  readonly database: Database;
  readonly ai: AiRuntime | undefined;
  readonly logger: WorkerLogger;
  readonly ticketKeyPrefix: string;
}

export interface GradeResult {
  readonly status: 'graded' | 'skipped' | 'failed' | 'missing';
  readonly reason?: AiInsightReason | 'not_resolved' | 'reopened' | 'already_graded';
}

class GradeFailedError extends Error {
  constructor(reason: AiInsightReason) {
    super(`The grader failed (${reason})`);
    this.name = 'GradeFailedError';
  }
}

/**
 * T-301 (PRD 6.2, 6.4): grades one resolved ticket and stores the verdict in `ai_resolution_grade`.
 *
 *  - Idempotent: one row per (ticket, resolution). A job that finds its row, a ticket that is no longer
 *    resolved or was reopened since (a different `reopen_count`) does nothing and costs no model call.
 *  - Everything the model sees goes through a redaction session scoped to the ticket; the grader writes
 *    its own `ai_run` row and asks the guard first (kill switch, budget).
 *  - No model call is made when the guard says no or redaction refuses: the job is done and writes
 *    nothing (the next resolve gets its own grade). A provider error or an unusable answer throws, so
 *    BullMQ retries; `provider_offline` is a wait, handled by the processor like the brief.
 *  - It only measures: nothing here changes a ticket, a stage or a customer (N3).
 */
export async function runGrader(
  deps: GradeDeps,
  job: { readonly ticketId: string; readonly reopenCount: number },
): Promise<GradeResult> {
  const db = deps.database.db;
  const [ticket] = await db
    .select({
      id: schema.ticket.id,
      number: schema.ticket.number,
      subject: schema.ticket.subject,
      status: schema.ticket.status,
      reopenCount: schema.ticket.reopenCount,
      orgId: schema.ticket.orgId,
      intentId: schema.ticket.intentId,
      requesterContactId: schema.ticket.requesterContactId,
    })
    .from(schema.ticket)
    .where(eq(schema.ticket.id, job.ticketId))
    .limit(1);
  if (ticket === undefined) return { status: 'missing' };
  if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
    return { status: 'skipped', reason: 'not_resolved' };
  }
  if (ticket.reopenCount !== job.reopenCount) return { status: 'skipped', reason: 'reopened' };
  if (await hasResolutionGrade(db, ticket.id, job.reopenCount)) {
    return { status: 'skipped', reason: 'already_graded' };
  }
  const runtime = deps.ai;
  if (runtime === undefined) return { status: 'skipped', reason: 'provider_unavailable' };

  const [messages, contacts, intent, drafts, survey] = await Promise.all([
    db
      .select({
        id: schema.message.id,
        direction: schema.message.direction,
        visibility: schema.message.visibility,
        text: schema.message.bodyText,
      })
      .from(schema.message)
      .where(eq(schema.message.ticketId, ticket.id))
      .orderBy(asc(schema.message.createdAt))
      .limit(MAX_MESSAGES),
    ticketPeopleNames(db, ticket),
    ticket.intentId === null
      ? Promise.resolve(undefined)
      : db
          .select({ key: schema.intent.key })
          .from(schema.intent)
          .where(eq(schema.intent.id, ticket.intentId))
          .limit(1)
          .then((rows) => rows[0]),
    // The draft a person acted on last: what the grade compares with the reply that was sent.
    db
      .select({
        id: schema.aiDraft.id,
        body: schema.aiDraft.bodyText,
        finalMessageId: schema.aiDraft.finalMessageId,
        cited: sql<boolean>`jsonb_path_exists(${schema.aiDraft.citations}, '$[*] ? (@.kind == "kb")')`,
        disposition: schema.aiDraft.disposition,
      })
      .from(schema.aiDraft)
      .where(
        and(eq(schema.aiDraft.ticketId, ticket.id), sql`${schema.aiDraft.disposition} IS NOT NULL`),
      )
      .orderBy(desc(schema.aiDraft.resolvedAt))
      .limit(5),
    db
      .select({
        score: schema.csatSurvey.score,
        resolved: schema.csatSurvey.resolved,
        comment: schema.csatSurvey.comment,
      })
      .from(schema.csatSurvey)
      .where(
        and(eq(schema.csatSurvey.ticketId, ticket.id), eq(schema.csatSurvey.status, 'answered')),
      )
      .orderBy(desc(schema.csatSurvey.answeredAt))
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
  // A rejected draft is no part of the reply; the one a person sent (approved or edited) is the one to compare.
  const used = drafts.find((draft) => draft.disposition !== 'rejected');
  const shown = used ?? drafts[0];
  const sentReply =
    used?.finalMessageId === undefined || used.finalMessageId === null
      ? null
      : (messages.find((message) => message.id === used.finalMessageId)?.text ?? null);
  const csat =
    survey === undefined
      ? null
      : { score: survey.score, resolved: survey.resolved, comment: survey.comment };
  const kbCited = drafts.some((draft) => draft.disposition !== 'rejected' && draft.cited);
  const key = new TicketKeys(deps.ticketKeyPrefix).format(ticket.number);
  const built = buildGradeFacts({
    ticketKey: key,
    ticketHref: `/?ticket=${key}`,
    turns,
    sentReply,
    draftText: shown?.body ?? null,
    csat,
    kbCited,
  });

  warnIfIncomplete(deps.logger, ticket.id, contacts);
  const agents = runtime.agentDeps(contacts.names, { dictionaryIncomplete: !contacts.complete });
  const firstCustomer = turns.find((turn) => turn.from === 'customer')?.text ?? ticket.subject;
  const outcome = await gradeResolution(agents, {
    ticketId: ticket.id,
    intentKey: intent?.key ?? null,
    locale: detectLanguage(firstCustomer) === 'th' ? 'th' : 'en',
    facts: built.facts,
    hasDraft: built.hasDraft,
    csat,
    kbCited,
  });
  if (outcome.status === 'skipped') return { status: 'skipped', reason: outcome.reason };
  if (outcome.status === 'failed' && outcome.reason === 'provider_offline') {
    return { status: 'failed', reason: 'provider_offline' };
  }
  if (outcome.status === 'failed') throw new GradeFailedError(outcome.reason);

  const grade = outcome.value;
  await recordResolutionGrade(db, {
    ticketId: ticket.id,
    cycle: job.reopenCount,
    intentKey: intent?.key ?? null,
    resolutionClass: grade.resolutionClass,
    modelClass: grade.modelClass,
    draftId: built.hasDraft ? (shown?.id ?? null) : null,
    draftVerdict: grade.draftVerdict,
    draftQuality: grade.draftQuality,
    policyViolations: grade.violations.map((violation) => ({
      code: violation.code,
      ...violation.claim,
    })),
    kbGap: grade.kbGap,
    reasoning: grade.reasons,
    csatScore: csat?.score ?? null,
    csatResolved: csat?.resolved ?? null,
    aiRunId: outcome.runId,
    promptVersion: grade.promptVersion,
    mock: grade.mock,
  });
  return { status: 'graded' };
}
