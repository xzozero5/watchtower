import { randomUUID } from 'node:crypto';

import {
  buildAllowList,
  createToolRegistry,
  draftReply,
  investigationTools,
  investigateTicket,
  selectDisclosureRules,
  selectGuidelines,
  withToolBudget,
  type AutonomyStage,
  type InvestigationEvidence,
  type ScopeBasis,
  type SystemToolPorts,
  type TicketTurn,
} from '@watchtower/ai';
import { schema, type Database } from '@watchtower/db';
import {
  createDbToolLedger,
  disclosureFor,
  effectiveStage,
  goldenExamplesFor,
  readPublishedProcedure,
  recordProcedureOutcome,
  saveAiDraft,
  senderAuthenticated,
  TicketKeys,
  writeAiInvestigation,
  type Domain,
} from '@watchtower/domain';
import {
  AI_INTENT_SCOPE_MIN_CONFIDENCE,
  AI_INVESTIGATION_DEADLINE_MS,
  AI_TOOL_BUDGETS,
  aiEvidenceSchema,
  detectLanguage,
  type AiInsightReason,
  type AiProgress,
  type ConditionFacts,
} from '@watchtower/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { WorkerLogger } from '../logger.js';
import type { RealtimeSink } from '../realtime.js';
import { runAutoSendStep } from './autosend.js';
import { NEEDS_HUMAN_LABELS } from './brief.js';
import { replyBlockReason } from './reply-block.js';
import { ticketPeopleNames, warnIfIncomplete } from './people-names.js';
import type { AiRuntime } from './runtime.js';
import {
  createKbSearchPort,
  createOrgContextPort,
  createSimilarTicketsPort,
  type ReadDb,
} from './tool-ports.js';

const MAX_MESSAGES = 60;

export interface InvestigationDeps {
  readonly database: Database;
  /** The handle the data tools read through: the `watchtower_ai_ro` login when configured (N2). */
  readonly readDb: ReadDb;
  readonly ai: AiRuntime | undefined;
  readonly ticketKeyPrefix: string;
  /** The logs, data and repo tools over the read-only clients (T-203d). A missing one leaves that tool unregistered. */
  readonly systems: SystemToolPorts | undefined;
  /** The project whose quota the logs, data and repository tools share with people (rate_budget_window). */
  readonly budgetProject?: string | undefined;
  /** False in production with no read-only database login: no intent can name a system tool then. */
  readonly allowSystemTools: boolean;
  readonly realtime: RealtimeSink;
  readonly logger: WorkerLogger;
  /**
   * Stage 3 (ADR-025): the domain (for the gate and the send) and this process' `AI_AUTOSEND_ENABLED`. Absent:
   * no shadow evaluation and no automatic send, whatever the intent says.
   */
  readonly autosend?: { readonly domain: Domain; readonly flagOn: boolean } | undefined;
  readonly now?: () => Date;
  /** Overrides the 110 s deadline (tests). */
  readonly deadlineMs?: number;
}

export interface InvestigationJob {
  readonly ticketId: string;
  readonly requestedBy: string | null;
  /**
   * `investigate`: the whole run, drafting when the stage allows (stage 2). `draft`: a person asked
   * for a draft (stage 1 and up), using the evidence already collected when there is some.
   */
  readonly mode: 'investigate' | 'draft';
  readonly note?: string | undefined;
  /** A developer asked for the investigation: no draft reply is written (T-137). */
  readonly noDraft?: boolean | undefined;
}

export interface InvestigationResult {
  readonly status: 'drafted' | 'investigated' | 'needs_human' | 'missing' | 'skipped';
  readonly reason?: AiInsightReason | 'stage' | 'no_intent' | 'reply_blocked';
}

class InvestigationFailedError extends Error {
  constructor(reason: AiInsightReason) {
    super(`The investigation failed (${reason})`);
    this.name = 'InvestigationFailedError';
  }
}

/**
 * Which intent the tools are scoped to, and why it is trusted (SR106-R8). The classifier's word is
 * not enough on its own, because a ticket can talk the model into an intent that opens the logs or
 * the data:
 *  - `human_confirmed`: a person created the ticket with an intent or changed its intent. Trusted.
 *  - `confidence`: the brief's classification is at least `AI_INTENT_SCOPE_MIN_CONFIDENCE`.
 *  - `none`: otherwise. Only the generic tools run (knowledge base, similar tickets, organization).
 */
export async function resolveToolScope(
  db: Pick<Database['db'], 'select'>,
  input: {
    readonly ticketId: string;
    readonly ticketIntentKey: string | null;
    readonly briefIntent: { readonly key: string | null; readonly confidence: number | null };
    readonly knownIntentKeys: ReadonlySet<string>;
  },
): Promise<{ intent: string | null; basis: ScopeBasis }> {
  if (input.ticketIntentKey !== null) {
    const [event] = await db
      .select({ id: schema.ticketEvent.id })
      .from(schema.ticketEvent)
      .where(
        and(
          eq(schema.ticketEvent.ticketId, input.ticketId),
          eq(schema.ticketEvent.actorType, 'user'),
          // A person on the staff, not just any signed-in user: a client is a user too (SR108-1).
          sql`EXISTS (SELECT 1 FROM users u WHERE u.id::text = ${schema.ticketEvent.actorId}
                AND u.role IN ('agent', 'lead', 'head'))`,
          sql`(${schema.ticketEvent.type} = 'ticket.created'
               OR (${schema.ticketEvent.type} = 'ticket.updated' AND ${schema.ticketEvent.payload}->'changed' ? 'intent'))`,
        ),
      )
      .limit(1);
    if (event !== undefined) return { intent: input.ticketIntentKey, basis: 'human_confirmed' };
  }
  const { key, confidence } = input.briefIntent;
  if (
    key !== null &&
    confidence !== null &&
    confidence >= AI_INTENT_SCOPE_MIN_CONFIDENCE &&
    input.knownIntentKeys.has(key)
  ) {
    return { intent: key, basis: 'confidence' };
  }
  return { intent: null, basis: 'none' };
}

/** The tier slug of the ticket's organization (a `when` of a procedure may read it); undefined when unknown. */
async function orgTier(
  db: Pick<Database['db'], 'select'>,
  orgId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ tier: schema.organization.tier })
    .from(schema.organization)
    .where(eq(schema.organization.id, orgId))
    .limit(1);
  return row?.tier ?? undefined;
}

// The disclosure policy (po #26, T-114a) lives in the domain so the gate of an automatic send asks the very same
// question (ADR-025 condition 8); re-exported here for the callers and tests that import it from this file.
export { disclosureFor, senderAuthenticated };

/**
 * What the investigator stores per card: the contract fields plus where it came from and whether it is
 * written for customers. The API reads the contract fields only (the schema drops the rest), so the
 * extra keys never reach the web; a later draft on request needs them.
 */
const storedEvidenceSchema = aiEvidenceSchema.extend({
  tool: z.string().min(1).max(64),
  customerSafe: z.boolean(),
  mock: z.boolean(),
});
const evidenceList = z.array(storedEvidenceSchema);

export async function runInvestigation(
  deps: InvestigationDeps,
  job: InvestigationJob,
): Promise<InvestigationResult> {
  const db = deps.database.db;
  const now = deps.now ?? ((): Date => new Date());
  const [ticket] = await db
    .select({
      id: schema.ticket.id,
      number: schema.ticket.number,
      subject: schema.ticket.subject,
      channel: schema.ticket.channel,
      channelAccountId: schema.ticket.channelAccountId,
      orgId: schema.ticket.orgId,
      intentId: schema.ticket.intentId,
      requesterContactId: schema.ticket.requesterContactId,
      status: schema.ticket.status,
      priority: schema.ticket.priority,
      reopenCount: schema.ticket.reopenCount,
    })
    .from(schema.ticket)
    .where(eq(schema.ticket.id, job.ticketId))
    .limit(1);
  if (ticket === undefined) return { status: 'missing' };

  const insightRow = (
    await db
      .select()
      .from(schema.aiTicketInsight)
      .where(eq(schema.aiTicketInsight.ticketId, ticket.id))
      .limit(1)
  )[0];
  const keys = new TicketKeys(deps.ticketKeyPrefix);

  const announce = async (): Promise<void> => {
    await deps.realtime
      .publish({
        id: randomUUID(),
        type: 'ticket.updated',
        occurredAt: now().toISOString(),
        orgId: ticket.orgId,
        ticketId: ticket.id,
        ticketKey: keys.format(ticket.number),
        data: {
          subject: ticket.subject,
          status: ticket.status as 'open',
          priority: ticket.priority as 'P3',
          changed: ['ai'],
        },
      })
      .catch((error: unknown) => {
        deps.logger.warn({ err: error }, 'ai progress event not published');
      });
  };
  const stageNow = insightRow?.stage ?? 0;
  const write = async (
    fields: Omit<
      Parameters<typeof writeAiInvestigation>[1],
      'ticketId' | 'generatedAt' | 'stage'
    > & {
      stage?: number;
    },
  ): Promise<void> => {
    await writeAiInvestigation(db, {
      ticketId: ticket.id,
      generatedAt: now(),
      stage: stageNow,
      ...fields,
    });
    await announce();
  };
  const needsHuman = async (
    reason: AiInsightReason,
    stage?: number,
  ): Promise<InvestigationResult> => {
    await write({
      state: 'needs_human',
      reasonCode: reason,
      progress: null,
      nextStep: { kind: 'other', label: NEEDS_HUMAN_LABELS[reason] },
      ...(stage === undefined ? {} : { stage }),
    });
    return { status: 'needs_human', reason };
  };

  const runtime = deps.ai;
  if (runtime === undefined) return needsHuman('provider_unavailable');

  const [messages, contacts, intents, requester] = await Promise.all([
    db
      .select({
        direction: schema.message.direction,
        visibility: schema.message.visibility,
        text: schema.message.bodyText,
        emailMeta: schema.message.emailMeta,
      })
      .from(schema.message)
      .where(eq(schema.message.ticketId, ticket.id))
      .orderBy(asc(schema.message.createdAt))
      .limit(MAX_MESSAGES),
    ticketPeopleNames(db, ticket),
    db
      .select({
        id: schema.intent.id,
        key: schema.intent.key,
        stage: schema.intent.autonomyStage,
        autosendShadow: schema.intent.autosendShadow,
        allowedTools: schema.intent.allowedTools,
      })
      .from(schema.intent)
      .where(eq(schema.intent.isActive, true)),
    ticket.requesterContactId === null
      ? Promise.resolve(undefined)
      : db
          .select({
            verifiedAt: schema.contact.verifiedAt,
            lineVerifiedAt: schema.contact.lineVerifiedAt,
          })
          .from(schema.contact)
          .where(eq(schema.contact.id, ticket.requesterContactId))
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
  const customerText = turns
    .filter((turn) => turn.from === 'customer')
    .map((turn) => turn.text)
    .join(' ');
  const ticketIntent = intents.find((intent) => intent.id === ticket.intentId);
  // The stage that governs drafts is the one of the ticket's own intent (the gate reads that one).
  const stage =
    ticketIntent === undefined
      ? 0
      : effectiveStage(ticketIntent.stage, deps.autosend?.flagOn === true);
  const scopeStage = Math.min(4, Math.max(0, stage)) as AutonomyStage;

  warnIfIncomplete(deps.logger, ticket.id, contacts);
  const agents = runtime.agentDeps(contacts.names, { dictionaryIncomplete: !contacts.complete });
  const session = agents.redactor.session({ scope: ticket.id });
  const signal = AbortSignal.timeout(deps.deadlineMs ?? AI_INVESTIGATION_DEADLINE_MS);

  const progress = async (value: AiProgress): Promise<void> => {
    await write({ state: 'investigating', progress: value, stage });
  };

  const scope = await resolveToolScope(db, {
    ticketId: ticket.id,
    ticketIntentKey: ticketIntent?.key ?? null,
    briefIntent: {
      key: insightRow?.intentKey ?? null,
      confidence: insightRow?.intentConfidence ?? null,
    },
    knownIntentKeys: new Set(intents.map((intent) => intent.key)),
  });
  // The ticket's own intent may have been put there by the model (ingest) or by a customer (the portal
  // category). A draft on its own is only made when that intent is one we trust for the tools too; a
  // person can still ask for one (SR108-1).
  const intentTrusted = ticketIntent !== undefined && scope.intent === ticketIntent.key;
  // T-147: no draft and no `reply` step on a ticket nothing can be sent on.
  const replyBlocked =
    (await replyBlockReason(db, ticket.channel, ticket.channelAccountId)) ?? undefined;

  // --- the published procedure of the intent (T-303c, ADR-026): none means the default runbook, as before ---
  // Only for an intent we trust: a ticket cannot pick a procedure by talking the classifier into an intent.
  const published =
    ticketIntent !== undefined && intentTrusted
      ? await readPublishedProcedure(db, ticketIntent.id)
      : null;
  const procedureFacts: ConditionFacts =
    published === null
      ? {}
      : {
          'classifier.confidence': insightRow?.intentConfidence ?? undefined,
          'ticket.priority': ticket.priority,
          'ticket.channel': ticket.channel,
          'org.tier': await orgTier(db, ticket.orgId),
          'contact.verified':
            disclosureFor(ticket.channel, requester, senderAuthenticated(messages)) === 'verified',
          'ticket.reopenCount': ticket.reopenCount,
        };

  // --- evidence: collect it now, or reuse what the last investigation stored (a draft on request) ---
  let evidence: InvestigationEvidence[];
  let investigated = false;
  const stored = evidenceList.safeParse(insightRow?.evidence);
  const reuse = job.mode === 'draft' && stored.success && stored.data.length > 0;

  if (reuse) {
    evidence = [...stored.data];
  } else {
    const registry = createToolRegistry(
      buildAllowList(
        intents.map((i) => ({
          key: i.key,
          allowedTools: deps.allowSystemTools ? i.allowedTools : [],
        })),
      ),
    );
    for (const tool of investigationTools({
      kb: createKbSearchPort({ db, ai: runtime, names: contacts.names }),
      tickets: createSimilarTicketsPort(deps.readDb, keys),
      org: createOrgContextPort(deps.readDb),
      systems: deps.systems,
    })) {
      registry.register(tool);
    }
    const settings = await runtime.settings.load();
    const tools = withToolBudget({
      scoped: registry.scope(
        { agent: 'investigator', intent: scope.intent, stage: scopeStage },
        { abortSignal: signal, ticketId: ticket.id },
      ),
      ledger: createDbToolLedger({
        db,
        limits: AI_TOOL_BUDGETS,
        ...(deps.budgetProject === undefined ? {} : { project: deps.budgetProject }),
      }),
      runKey: randomUUID(),
      ticketId: ticket.id,
      agent: 'investigator',
      intent: scope.intent,
      stage: scopeStage,
      hashKey: settings.inputHashKey,
    });

    await progress({ phase: 'queued', step: 0, steps: 1 });
    const outcome = await investigateTicket(agents, {
      ticketId: ticket.id,
      session,
      channel: ticket.channel,
      subject: ticket.subject,
      turns,
      intentKey: scope.intent,
      scopeBasis: scope.basis,
      stage: scopeStage,
      replyBlocked,
      procedure:
        published === null
          ? undefined
          : { versionId: published.versionId, steps: published.steps, facts: procedureFacts },
      tools,
      onProgress: progress,
      abortSignal: signal,
    });
    if (outcome.status === 'skipped') return needsHuman(outcome.reason, stage);
    // Offline (ADR-019) is a wait, not a failure: the processor puts the job back (T-170).
    if (outcome.status === 'failed' && outcome.reason === 'provider_offline') {
      return needsHuman('provider_offline', stage);
    }
    if (outcome.status === 'failed') {
      await write({ state: 'failed', reasonCode: outcome.reason, progress: null, stage });
      throw new InvestigationFailedError(outcome.reason);
    }
    evidence = [...outcome.value.evidence];
    investigated = true;
    // What the procedure asked for stays with the ticket: a proposal a person accepts with one click, and a
    // call for a person that the auto-send gate reads (ADR-026 section 7, ADR-025 condition 11).
    const asked = outcome.value.report.procedure;
    if (asked !== undefined) {
      await recordProcedureOutcome(db, {
        ticketId: ticket.id,
        versionId: asked.versionId,
        escalations: asked.escalations,
        requireHuman: asked.requireHuman,
      });
    }
    await write({
      state: 'classified',
      reasonCode: null,
      progress: null,
      stage,
      evidence,
      report: outcome.value.report,
      nextStep: outcome.value.nextStep,
      requestedBy: job.requestedBy,
      investigatedAt: now(),
    });
  }

  // --- draft: stage 2 drafts on its own, stage 1 only when a person asked, stage 0 never (N3) ---
  const draftsOnItsOwn =
    job.mode === 'investigate' && stage >= 2 && intentTrusted && job.noDraft !== true;
  const draftsOnRequest = job.mode === 'draft' && stage >= 1;
  // Not drafting: close the "working" state a request opened (an investigation already did).
  const finish = async (
    reason: 'stage' | 'no_intent' | 'reply_blocked',
  ): Promise<InvestigationResult> => {
    if (!investigated) await write({ state: 'classified', progress: null, stage });
    return { status: investigated ? 'investigated' : 'skipped', reason };
  };
  if (!draftsOnItsOwn && !draftsOnRequest) return finish('stage');
  if (replyBlocked !== undefined) return finish('reply_blocked');
  if (ticketIntent === undefined) return finish('no_intent');

  await progress({ phase: 'drafting', step: 0, steps: 1 });
  const customerLanguage = detectLanguage(customerText);
  // Golden answers of the same intent (T-302a): stored redacted, and the drafter feeds them through its session.
  const golden = await goldenExamplesFor(db, ticketIntent.id, customerLanguage, ticket.orgId);
  const drafted = await draftReply(agents, {
    ticketId: ticket.id,
    subject: ticket.subject,
    turns,
    intentKey: ticketIntent.key,
    customerLanguage,
    disclosure: disclosureFor(ticket.channel, requester, senderAuthenticated(messages)),
    evidence,
    note: job.note,
    examples: golden.map((example) => example.text),
    procedure:
      published === null
        ? undefined
        : {
            versionId: published.versionId,
            guidelines: selectGuidelines(published.steps, { stage, facts: procedureFacts }),
            disclosure: selectDisclosureRules(published.steps, { stage, facts: procedureFacts }),
          },
    abortSignal: signal,
  });
  if (drafted.status === 'skipped') return needsHuman(drafted.reason, stage);
  if (drafted.status === 'failed' && drafted.reason === 'provider_offline') {
    return needsHuman('provider_offline', stage);
  }
  if (drafted.status === 'failed') {
    await write({ state: 'failed', reasonCode: drafted.reason, progress: null, stage });
    throw new InvestigationFailedError(drafted.reason);
  }
  const kindOf = new Map(evidence.map((card) => [card.id, card.kind]));
  const saved = await saveAiDraft(db, {
    ticketId: ticket.id,
    body: drafted.value.body,
    aiRunId: drafted.runId,
    language: drafted.value.language,
    customerLanguage: drafted.value.customerLanguage,
    citations: drafted.value.citations.map((citation) => ({
      ...citation,
      kind: kindOf.get(citation.evidenceId) ?? 'unknown',
    })),
    uncitedClaims: drafted.value.uncitedClaims,
    promptId: 'drafter',
    promptVersion: drafted.value.promptVersion,
    disclosureLevel: drafted.value.disclosure.level,
    disclosureRemoved: drafted.value.disclosure.removedSentences,
    needsReview: drafted.value.needsReview,
    requestedBy: job.requestedBy,
  });
  await write({
    state: 'draft_ready',
    reasonCode: null,
    progress: null,
    stage,
    draftId: saved.id,
    nextStep: { kind: 'approve_draft', label: 'Review the draft reply' },
  });
  // Stage 3 and its shadow mode (ADR-025): the draft stays a draft unless every condition holds. A failure
  // here never fails the job (a retry would write another draft); a person reviews the draft either way.
  if (deps.autosend !== undefined && job.mode === 'investigate') {
    await runAutoSendStep(
      {
        database: deps.database,
        domain: deps.autosend.domain,
        settings: runtime.settings,
        realtime: deps.realtime,
        logger: deps.logger,
        flagOn: deps.autosend.flagOn,
      },
      {
        ticket: { id: ticket.id, channel: ticket.channel },
        intent: {
          id: ticketIntent.id,
          key: ticketIntent.key,
          stage: ticketIntent.stage,
          autosendShadow: ticketIntent.autosendShadow,
        },
        draft: {
          id: saved.id,
          body: drafted.value.body,
          aiRunId: drafted.runId,
          language: drafted.value.language,
          citedEvidenceIds: drafted.value.citedEvidenceIds,
        },
        evidence,
        customerTurns: turns.filter((turn) => turn.from === 'customer').map((turn) => turn.text),
        agents,
        locale: customerLanguage,
        signal,
      },
    );
  }
  return { status: 'drafted' };
}
