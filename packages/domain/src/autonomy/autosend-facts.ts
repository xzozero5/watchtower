import { schema } from '@watchtower/db';
import { parseAutosendPolicy } from '@watchtower/shared';
import { and, desc, eq, ne, sql } from 'drizzle-orm';

import { readProcedureProposals } from '../procedures/escalation.js';
import { ticketRequiresHuman } from '../procedures/runtime.js';
import { contentHash } from '../outbound/state.js';
import type { ReadExecutor } from '../types.js';
import {
  countPlaceholders,
  autosendContactVerified,
  customerWantsHuman,
  linksAllowed,
} from './autosend-text.js';
import { replayPassedForSet } from './replay.js';
import type {
  AutoSendBudgetFacts,
  AutoSendContentFacts,
  AutoSendDisclosureFacts,
  AutoSendFacts,
  AutoSendGradeFacts,
  AutoSendProcedureFacts,
  AutoSendTicketFacts,
  IntentStanding,
} from './decide.js';

/** The newest public inbound messages read for the "wants a person" check; more than this and the answer is yes. */
const MAX_INBOUND_TEXTS = 1000;

/** What the caller names; everything else is read from the tables, never taken from the caller. */
export interface AutoSendRequest {
  readonly ticketId: string;
  readonly aiDraftId: string;
  readonly aiGradeId: string;
  /** The exact text that would be (or is about to be) sent: the composed body, or the stored message body. */
  readonly text: string;
  /** Files on the message (0 for a composed text that has no message yet). */
  readonly attachmentCount: number;
  /** The message carries an HTML part (never allowed for an automatic reply). */
  readonly hasHtml: boolean;
  /** The delivery being claimed, so a count of automatic sends does not include itself. */
  readonly excludeDeliveryId?: string | undefined;
}

export interface AutoSendLoadOptions {
  /** `AI_AUTOSEND_ENABLED` of this process. */
  readonly flagOn: boolean;
  /** The portal and knowledge base origins of this instance; a link anywhere else is refused. */
  readonly linkOrigins: readonly string[];
  /** Today's AI spend is at a cap. `null` when it cannot be known (then the decision is a denial). */
  readonly aiBudgetExceeded: () => Promise<boolean | null>;
}

export interface LoadedAutoSend {
  readonly intent: IntentStanding;
  readonly intentId: string | null;
  readonly facts: AutoSendFacts;
  /** Counts and flags the decision used, for the evaluation row. Never customer text. */
  readonly summary: Readonly<Record<string, unknown>>;
}

/**
 * The customer-safe knowledge base cards the investigator stored (`ai_ticket_insight.evidence`), by id, with the
 * passage each shows; anything else is ignored.
 */
function customerKbCards(evidence: unknown): Map<string, string> {
  const ids = new Map<string, string>();
  if (!Array.isArray(evidence)) return ids;
  for (const card of evidence as unknown[]) {
    if (typeof card !== 'object' || card === null) continue;
    const { id, kind, customerSafe, title, snippet } = card as {
      id?: unknown;
      kind?: unknown;
      customerSafe?: unknown;
      title?: unknown;
      snippet?: unknown;
    };
    if (typeof id === 'string' && kind === 'kb' && customerSafe === true) {
      ids.set(
        id,
        [typeof title === 'string' ? title : '', typeof snippet === 'string' ? snippet : ''].join(
          '\n',
        ),
      );
    }
  }
  return ids;
}

/** The `ai_run` row a call wrote: which agent, for which ticket, with which model alias and prompt version. */
async function runOf(
  db: ReadExecutor,
  id: string | null,
): Promise<
  { agent: string; ticketId: string | null; model: string; promptVersion: number } | undefined
> {
  if (id === null) return undefined;
  const [row] = await db
    .select({
      agent: schema.aiRun.agent,
      ticketId: schema.aiRun.ticketId,
      model: schema.aiRun.model,
      promptVersion: schema.aiRun.promptVersion,
    })
    .from(schema.aiRun)
    .where(eq(schema.aiRun.id, id))
    .limit(1);
  return row;
}

/**
 * Reads the facts of ADR-025 section 4 fresh from the tables (no cache). A group that cannot be read, or
 * whose row is missing, is `null`: the pure decision treats an unknown fact as a denial. The caller's own
 * claims (`text`, ids) are checked against the rows: the grade must belong to this draft, the draft to
 * this ticket.
 */
export async function loadAutoSendFacts(
  db: ReadExecutor,
  request: AutoSendRequest,
  options: AutoSendLoadOptions,
): Promise<LoadedAutoSend> {
  const [ticket] = await db
    .select({
      id: schema.ticket.id,
      channel: schema.ticket.channel,
      priority: schema.ticket.priority,
      intentId: schema.ticket.intentId,
      incidentId: schema.ticket.incidentId,
      requesterContactId: schema.ticket.requesterContactId,
      portalRequesterVerified: sql<unknown>`${schema.ticket.customFields}->'portal'->'requesterVerified'`,
    })
    .from(schema.ticket)
    .where(eq(schema.ticket.id, request.ticketId))
    .limit(1);
  const empty: AutoSendFacts = {
    flagOn: options.flagOn,
    grade: null,
    disclosure: null,
    content: null,
    ticket: null,
    procedure: null,
    budget: null,
  };
  if (ticket === undefined) {
    return { intent: { kind: 'missing' }, intentId: null, facts: empty, summary: {} };
  }
  if (ticket.intentId === null) {
    return { intent: { kind: 'none' }, intentId: null, facts: empty, summary: {} };
  }
  const intentId = ticket.intentId;
  const [intent] = await db
    .select({
      stage: schema.intent.autonomyStage,
      minScore: schema.intent.autosendMinScore,
      dailyCap: schema.intent.autosendDailyCap,
      policy: schema.intent.autosendPolicy,
    })
    .from(schema.intent)
    .where(eq(schema.intent.id, intentId))
    .limit(1);
  if (intent === undefined) {
    return { intent: { kind: 'missing' }, intentId, facts: empty, summary: {} };
  }

  const [draft] = await db
    .select({
      ticketId: schema.aiDraft.ticketId,
      aiRunId: schema.aiDraft.aiRunId,
      citations: schema.aiDraft.citations,
      uncitedClaims: schema.aiDraft.uncitedClaims,
      createdAt: schema.aiDraft.createdAt,
    })
    .from(schema.aiDraft)
    .where(eq(schema.aiDraft.id, request.aiDraftId))
    .limit(1);
  const draftOk = draft !== undefined && draft.ticketId === ticket.id;

  // Condition 6 and 7.
  const [gradeRow] = await db
    .select({
      draftId: schema.aiGrade.aiDraftId,
      ticketId: schema.aiGrade.ticketId,
      phase: schema.aiGrade.phase,
      hash: schema.aiGrade.contentHash,
      ageSeconds: sql<string>`extract(epoch from (clock_timestamp() - ${schema.aiGrade.gradedAt}))`,
      passed: schema.aiGrade.passed,
      violationCount: schema.aiGrade.violationCount,
      score: schema.aiGrade.score,
      mock: schema.aiGrade.mock,
      independent: schema.aiGrade.independent,
      graderAiRunId: schema.aiGrade.graderAiRunId,
      graderPromptVersion: schema.aiGrade.promptVersion,
    })
    .from(schema.aiGrade)
    .where(eq(schema.aiGrade.id, request.aiGradeId))
    .limit(1);
  // T-306e C-11: the runs of the drafter and the grader. No row = the models cannot be vouched for = deny.
  const drafterRun = draftOk ? await runOf(db, draft.aiRunId) : undefined;
  const graderRun = gradeRow === undefined ? undefined : await runOf(db, gradeRow.graderAiRunId);
  const runsKnown =
    drafterRun !== undefined &&
    drafterRun.agent === 'drafter' &&
    drafterRun.ticketId === ticket.id &&
    graderRun !== undefined &&
    graderRun.agent === 'grader' &&
    graderRun.ticketId === ticket.id;
  const grade: AutoSendGradeFacts | null =
    gradeRow === undefined ||
    gradeRow.draftId !== request.aiDraftId ||
    gradeRow.ticketId !== ticket.id ||
    gradeRow.phase !== 'pre_send'
      ? null
      : {
          hashMatches: gradeRow.hash === contentHash(request.text),
          ageSeconds: Number(gradeRow.ageSeconds),
          passed: gradeRow.passed,
          violationCount: gradeRow.violationCount,
          score: Number(gradeRow.score),
          minScore: Number(intent.minScore),
          mock: gradeRow.mock,
          // A generated column: null would be unknown, and unknown is "not independent".
          independent: gradeRow.independent === true,
          runsKnown,
        };

  // Condition 8.
  const [contact] =
    ticket.requesterContactId === null
      ? []
      : await db
          .select({
            verifiedAt: schema.contact.verifiedAt,
            lineVerifiedAt: schema.contact.lineVerifiedAt,
          })
          .from(schema.contact)
          .where(eq(schema.contact.id, ticket.requesterContactId))
          .limit(1);
  // T-306e C-10: aggregated in SQL over every inbound message (the old read took the first 200 and so never saw
  // the latest). The sender check covers all of them; the texts come newest first.
  const inboundOfTicket = and(
    eq(schema.message.ticketId, ticket.id),
    eq(schema.message.direction, 'inbound'),
  );
  const [inboundAgg] = await db
    .select({
      publicCount: sql<number>`(count(*) FILTER (WHERE ${schema.message.visibility} = 'public'))::int`,
      allAuthenticated: sql<boolean>`coalesce(bool_and(coalesce(${schema.message.emailMeta}->>'senderAuth', '') = 'pass'), true)`,
    })
    .from(schema.message)
    .where(inboundOfTicket);
  const recentPublic = await db
    .select({ text: sql<string>`left(${schema.message.bodyText}, 4000)` })
    .from(schema.message)
    .where(and(inboundOfTicket, eq(schema.message.visibility, 'public')))
    .orderBy(desc(schema.message.createdAt), desc(schema.message.id))
    .limit(MAX_INBOUND_TEXTS);
  const disclosure: AutoSendDisclosureFacts = {
    // T-306e C-3: a portal ticket is verified only by the portal's own `requesterVerified`, never by the contact.
    contactVerified: autosendContactVerified(
      ticket.channel,
      contact,
      ticket.portalRequesterVerified,
    ),
    senderAuthenticated: ticket.channel === 'gmail' ? inboundAgg?.allAuthenticated === true : null,
  };

  // Condition 9: customer-facing knowledge base citations of the draft.
  const [insight] = await db
    .select({ evidence: schema.aiTicketInsight.evidence })
    .from(schema.aiTicketInsight)
    .where(eq(schema.aiTicketInsight.ticketId, ticket.id))
    .limit(1);
  const safeKb = customerKbCards(insight?.evidence);
  const citedCards = draftOk
    ? draft.citations.filter((citation) => safeKb.has(citation.evidenceId))
    : [];
  const cited = new Set(citedCards.map((c) => c.evidenceId));
  // T-306e C-2: the passages the reply cites are the only place a contact or host outside the instance may come from.
  const citedSnippets = [...cited].map((id) => safeKb.get(id) ?? '');
  const policy = parseAutosendPolicy(intent.policy);
  const content: AutoSendContentFacts = {
    channel: ticket.channel,
    allowedChannels: policy === undefined ? null : policy.channels,
    customerKbCitations: cited.size,
    // A draft we cannot read has claims we cannot vouch for.
    uncitedClaims: draftOk ? draft.uncitedClaims : 1,
    linksAllowed: linksAllowed(request.text, options.linkOrigins, citedSnippets),
    attachments: request.attachmentCount + (request.hasHtml ? 1 : 0),
    placeholders: countPlaceholders(request.text),
    length: Array.from(request.text).length,
    maxChars: policy?.maxChars ?? 0,
  };

  // Condition 10.
  const [incident] =
    ticket.incidentId === null
      ? []
      : await db
          .select({ status: schema.incident.status })
          .from(schema.incident)
          .where(eq(schema.incident.id, ticket.incidentId))
          .limit(1);
  const others =
    request.excludeDeliveryId === undefined
      ? sql`true`
      : ne(schema.outboundDelivery.id, request.excludeDeliveryId);
  const [streak] = await db
    .select({
      n: sql<number>`count(*)::int`,
      first: sql<string | null>`min(${schema.outboundDelivery.createdAt})::text`,
    })
    .from(schema.outboundDelivery)
    .where(
      and(
        eq(schema.outboundDelivery.ticketId, ticket.id),
        eq(schema.outboundDelivery.origin, 'ai_auto'),
        sql`${schema.outboundDelivery.state} NOT IN ('failed', 'cancelled')`,
        others,
      ),
    );
  const firstAuto = streak?.first ?? null;
  const [reopened] =
    firstAuto === null
      ? []
      : await db
          .select({ id: schema.ticketEvent.id })
          .from(schema.ticketEvent)
          .where(
            and(
              eq(schema.ticketEvent.ticketId, ticket.id),
              eq(schema.ticketEvent.type, 'ticket.reopened'),
              sql`${schema.ticketEvent.createdAt} > ${firstAuto}::timestamptz`,
            ),
          )
          .limit(1);
  // T-306e C-2: once an automatic reply has gone out on the ticket, every later inbound message counts as a request
  // for a person until a person has answered it. A customer who writes back to a bot is not asked twice.
  const [unanswered] =
    firstAuto === null
      ? []
      : await db
          .select({ id: schema.message.id })
          .from(schema.message)
          .where(
            and(
              inboundOfTicket,
              eq(schema.message.visibility, 'public'),
              sql`${schema.message.createdAt} > ${firstAuto}::timestamptz`,
              sql`NOT EXISTS (
                SELECT 1 FROM message AS h
                 WHERE h.ticket_id = ${schema.message.ticketId} AND h.direction = 'outbound'
                   AND h.visibility = 'public' AND h.sender_user_id IS NOT NULL
                   AND h.created_at > ${schema.message.createdAt})`,
            ),
          )
          .limit(1);
  const inboundTruncated = (inboundAgg?.publicCount ?? 0) > recentPublic.length;
  const ticketFacts: AutoSendTicketFacts = {
    priority: ticket.priority,
    openIncident: incident !== undefined && incident.status !== 'resolved',
    customerWantsHuman:
      // More messages than were read: the rest cannot be vouched for.
      inboundTruncated ||
      unanswered !== undefined ||
      customerWantsHuman(recentPublic.map((message) => message.text)),
    autoStreak: streak?.n ?? 0,
    reopenedAfterAuto: reopened !== undefined,
  };

  // Condition 11: the published procedure of the intent says autosend 'allowed', and the draft was written
  // under it. Until the drafter records the version it used (ADR-026, T-303c) a draft is "from" the
  // published version when that version was published before the draft was written `[ASSUMED]`.
  const [published] = await db
    .select({
      versionId: schema.procedureVersion.id,
      stepsHash: schema.procedureVersion.stepsHash,
      steps: schema.procedureVersion.steps,
      publishedAt: schema.procedureVersion.publishedAt,
    })
    .from(schema.procedure)
    .innerJoin(
      schema.procedureVersion,
      and(
        eq(schema.procedureVersion.procedureId, schema.procedure.id),
        eq(schema.procedureVersion.status, 'published'),
      ),
    )
    .where(eq(schema.procedure.intentId, intentId))
    .limit(1);
  const stepsAutosend =
    published === undefined
      ? null
      : ((published.steps as { autosend?: unknown } | null)?.autosend ?? null);
  const procedure: AutoSendProcedureFacts = {
    autosendAllowed: stepsAutosend === 'allowed',
    stale:
      published === undefined ||
      published.publishedAt === null ||
      !draftOk ||
      published.publishedAt.getTime() > draft.createdAt.getTime(),
    // T-306e C-1: a require_human step matched, or an escalation card still waits for a person.
    requiresHuman: await ticketRequiresHuman(db, ticket.id),
    escalationPending: (await readProcedureProposals(db, ticket.id)).some(
      (proposal) => proposal.status === 'pending',
    ),
    // T-306e C-4: a passing replay of the combination in force (the models and prompts of this draft and grade,
    // the published procedure). Without the runs of the drafter and the grader the combination is unknown.
    replayPassed: runsKnown
      ? await replayPassedForSet(db, {
          intentId,
          drafterModel: drafterRun.model,
          graderModel: graderRun.model,
          drafterPromptVersion: drafterRun.promptVersion,
          graderPromptVersion: graderRun.promptVersion,
          procedureVersionId: published?.versionId ?? null,
          procedureStepsHash: published?.stepsHash ?? null,
        })
      : false,
  };

  // Condition 12.
  const [today] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.outboundDelivery)
    .innerJoin(schema.ticket, eq(schema.ticket.id, schema.outboundDelivery.ticketId))
    .where(
      and(
        eq(schema.ticket.intentId, intentId),
        eq(schema.outboundDelivery.origin, 'ai_auto'),
        sql`${schema.outboundDelivery.state} NOT IN ('failed', 'cancelled')`,
        sql`${schema.outboundDelivery.createdAt} > clock_timestamp() - interval '24 hours'`,
        others,
      ),
    );
  const exceeded = await options.aiBudgetExceeded();
  const budget: AutoSendBudgetFacts | null =
    exceeded === null
      ? null
      : {
          autoSentToday: today?.n ?? 0,
          dailyCap: intent.dailyCap,
          aiBudgetExceeded: exceeded,
        };

  const facts: AutoSendFacts = {
    flagOn: options.flagOn,
    grade,
    disclosure,
    content,
    ticket: ticketFacts,
    procedure,
    budget,
  };
  return {
    intent: { kind: 'found', stage: intent.stage },
    intentId,
    facts,
    summary: {
      stage: intent.stage,
      channel: ticket.channel,
      priority: ticket.priority,
      gradeScore: grade?.score ?? null,
      gradeAgeSeconds: grade === null ? null : Math.round(grade.ageSeconds),
      gradeIndependent: grade?.independent ?? null,
      gradeMock: grade?.mock ?? null,
      minScore: grade?.minScore ?? Number(intent.minScore),
      customerKbCitations: content.customerKbCitations,
      uncitedClaims: content.uncitedClaims,
      length: content.length,
      maxChars: content.maxChars,
      autoStreak: ticketFacts.autoStreak,
      autoSentToday: budget?.autoSentToday ?? null,
      dailyCap: intent.dailyCap,
      contactVerified: disclosure.contactVerified,
      senderAuthenticated: disclosure.senderAuthenticated,
      procedureAutosend: typeof stepsAutosend === 'string' ? stepsAutosend : null,
      procedureStale: procedure.stale,
      procedureRequiresHuman: procedure.requiresHuman,
      escalationPending: procedure.escalationPending,
      replayPassed: procedure.replayPassed,
      runsKnown,
    },
  };
}
