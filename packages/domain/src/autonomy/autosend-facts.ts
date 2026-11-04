import { schema } from '@watchtower/db';
import { parseAutosendPolicy } from '@watchtower/shared';
import { and, asc, eq, ne, sql } from 'drizzle-orm';

import { contentHash } from '../outbound/state.js';
import type { ReadExecutor } from '../types.js';
import {
  countPlaceholders,
  customerWantsHuman,
  disclosureFor,
  linksAllowed,
  senderAuthenticated,
} from './autosend-text.js';
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

/** The stored evidence cards the investigator wrote (`ai_ticket_insight.evidence`); anything else is ignored. */
function customerKbCardIds(evidence: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(evidence)) return ids;
  for (const card of evidence as unknown[]) {
    if (typeof card !== 'object' || card === null) continue;
    const { id, kind, customerSafe } = card as {
      id?: unknown;
      kind?: unknown;
      customerSafe?: unknown;
    };
    if (typeof id === 'string' && kind === 'kb' && customerSafe === true) ids.add(id);
  }
  return ids;
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
    })
    .from(schema.aiGrade)
    .where(eq(schema.aiGrade.id, request.aiGradeId))
    .limit(1);
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
  const inbound = await db
    .select({
      direction: schema.message.direction,
      emailMeta: schema.message.emailMeta,
      visibility: schema.message.visibility,
      text: schema.message.bodyText,
    })
    .from(schema.message)
    .where(and(eq(schema.message.ticketId, ticket.id), eq(schema.message.direction, 'inbound')))
    .orderBy(asc(schema.message.createdAt))
    .limit(200);
  const disclosure: AutoSendDisclosureFacts = {
    contactVerified: disclosureFor(ticket.channel, contact) === 'verified',
    senderAuthenticated: ticket.channel === 'gmail' ? senderAuthenticated(inbound) : null,
  };

  // Condition 9: customer-facing knowledge base citations of the draft.
  const [insight] = await db
    .select({ evidence: schema.aiTicketInsight.evidence })
    .from(schema.aiTicketInsight)
    .where(eq(schema.aiTicketInsight.ticketId, ticket.id))
    .limit(1);
  const safeKb = customerKbCardIds(insight?.evidence);
  const cited = new Set(
    draftOk
      ? draft.citations
          .filter((citation) => safeKb.has(citation.evidenceId))
          .map((c) => c.evidenceId)
      : [],
  );
  const policy = parseAutosendPolicy(intent.policy);
  const content: AutoSendContentFacts = {
    channel: ticket.channel,
    allowedChannels: policy === undefined ? null : policy.channels,
    customerKbCitations: cited.size,
    // A draft we cannot read has claims we cannot vouch for.
    uncitedClaims: draftOk ? draft.uncitedClaims : 1,
    linksAllowed: linksAllowed(request.text, options.linkOrigins),
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
  const ticketFacts: AutoSendTicketFacts = {
    priority: ticket.priority,
    openIncident: incident !== undefined && incident.status !== 'resolved',
    customerWantsHuman: customerWantsHuman(
      inbound.filter((message) => message.visibility === 'public').map((message) => message.text),
    ),
    autoStreak: streak?.n ?? 0,
    reopenedAfterAuto: reopened !== undefined,
  };

  // Condition 11: the published procedure of the intent says autosend 'allowed', and the draft was written
  // under it. Until the drafter records the version it used (ADR-026, T-303c) a draft is "from" the
  // published version when that version was published before the draft was written `[ASSUMED]`.
  const [published] = await db
    .select({
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
    },
  };
}
