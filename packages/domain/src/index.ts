import { REOPEN_WINDOW_DAYS } from '@watchtower/shared';

import { assertAssignableStaff, nextRoundRobin, peekRoundRobin, takeTurn } from './assignment.js';
import { readAutonomyState, setAiSwitch, setIntentAutonomy } from './autonomy/state.js';
import { findOrCreateContactByEmail } from './contacts.js';
import { ingestInbound } from './inbound/ingest.js';
import { resolveIntent } from './intents.js';
import {
  createKbArticle,
  publishKbArticle,
  publishKbArticleBreakGlass,
  reviewKbBreakGlass,
  transitionKbArticle,
  updateKbArticle,
} from './kb/articles.js';
import { NO_NOTIFIER, type TicketNotifier } from './notifier.js';
import { cancelSend } from './outbound/cancel.js';
import {
  claimDelivery,
  denyDelivery,
  markDispatched,
  recordFailure,
  recordSent,
  sweepDeliveries,
  vetDelivery,
} from './outbound/dispatch.js';
import { scheduleCustomerSend, scheduleTemplateAck } from './outbound/schedule.js';
import { readOutboundSettings, setUndoSendSeconds } from './outbound/settings.js';
import { enqueueJob } from './outbox.js';
import type { PolicyGate } from './policy.js';
import {
  finishedSlaPauses,
  recomputeSla,
  resolveSlaPolicy,
  resumeSla,
  slaCalendarFor,
  slaForNewTicket,
} from './sla.js';
import { assignTicket } from './tickets/assign.js';
import { createTicket } from './tickets/create.js';
import { mergeTickets } from './tickets/merge.js';
import { addTicketNote, replyToTicket } from './tickets/messages.js';
import { changeTicketStatus } from './tickets/status.js';
import { updateTicket } from './tickets/update.js';
import type { Actor, DomainConfig, DomainContext } from './types.js';
import { workflowAllows } from './workflow.js';

export { recordAuditInTx, type AuditEntry, type AuditWriter } from './audit.js';
export {
  DEFAULT_AI_BUDGET_ALERT_PERCENT,
  DEFAULT_AI_DAILY_COST_CAP_USD,
  DEFAULT_AI_DAILY_TOKEN_CAP,
  createBudgetMonitor,
  evaluateBudget,
  readAiUsage,
  resolveAiCaps,
  utcDayStart,
  type AiCaps,
  type AiUsage,
  type BudgetDatabase,
  type BudgetDimension,
  type BudgetEventNotice,
  type BudgetFinding,
  type BudgetLevel,
  type BudgetMonitor,
  type BudgetMonitorOptions,
  type BudgetStatus,
} from './ai/budget.js';
export {
  createAiGuard,
  type AiGuardDecision,
  type AiGuardOptions,
  type AiGuardRequest,
} from './ai/guard.js';
export { upsertAiInsight, type AiInsightInput, type InsightWriter } from './ai/insight.js';
export {
  createAiRunRecorder,
  type AiRunDatabase,
  type AiRunInput,
  type AiRunReceipt,
  type AiRunRecorder,
} from './ai/recorder.js';
export {
  assertAssignableStaff,
  nextRoundRobin,
  peekRoundRobin,
  pickNextMember,
  takeTurn,
} from './assignment.js';
export {
  contactSnapshot,
  findOrCreateContactByEmail,
  type FindOrCreateContactInput,
} from './contacts.js';
export { DOMAIN_ERROR_CODES, DomainError, isDomainError, type DomainErrorCode } from './errors.js';
export {
  UNIDENTIFIED_ORG_ID,
  UNIDENTIFIED_ORG_NAME,
  ensureSenderContact,
  lookupSender,
  type SenderLookup,
  type SenderVia,
} from './inbound/identity.js';
export { ingestInbound, ruleClassification, ticketSubject } from './inbound/ingest.js';
export {
  HEURISTIC_WINDOW_DAYS,
  findTicketForMessage,
  joinability,
  normalizeSubject,
  type NoMatch,
  type TicketMatch,
} from './inbound/match.js';
export {
  THREAD_CANDIDATE_KINDS,
  type AutomatedVerdict,
  type IngestInboundInput,
  type IngestOutcome,
  type InboundAttachment,
  type NormalisedInboundMessage,
  type ThreadCandidate,
  type ThreadCandidateKind,
  type ThreadMatchKind,
} from './inbound/types.js';
export { resolveIntent } from './intents.js';
export {
  contentHash,
  createKbArticle,
  publishKbArticle,
  publishKbArticleBreakGlass,
  reviewKbBreakGlass,
  transitionKbArticle,
  updateKbArticle,
  type BreakGlassPublishKbArticleInput,
  type KbWriteResult,
  type PublishKbArticleInput,
  type ReviewKbBreakGlassInput,
  type TransitionKbArticleInput,
  type UpdateKbArticleInput,
} from './kb/articles.js';
export {
  ChunkOptionsError,
  DEFAULT_CHUNK_OPTIONS,
  assertChunkOptions,
  chunkMarkdown,
  type Chunk,
  type ChunkOptions,
} from './kb/chunker.js';
export {
  articlesNeedingEmbedding,
  dropArticleChunksIfNotLive,
  ensureActiveEmbeddingIndex,
  readActiveEmbeddingIndex,
  replaceArticleChunks,
  type ChunkToStore,
  type EmbeddingIndexRef,
  type EmbeddingIndexSpec,
  type ReembedTarget,
  type ReplaceChunksInput,
} from './kb/chunks.js';
export { RRF_K, reciprocalRankFusion, type FusedItem, type RankedList } from './kb/rrf.js';
export {
  audienceWidens,
  canMove,
  canPublishFrom,
  sameAudience,
  type KbAudienceSpec,
} from './kb/rules.js';
export {
  DEFAULT_MIN_VECTOR_SIMILARITY,
  audienceCondition,
  queryTerms,
  searchKb,
  type KbAudience,
  type KbSearchInput,
  type KbSearchOutcome,
} from './kb/search.js';
export { NO_NOTIFIER, type TicketNotifier } from './notifier.js';
export { enqueueJob, type OutboxRequest } from './outbox.js';
export { cancelSend, type CancelSendInput } from './outbound/cancel.js';
export { loadDeliveryContext, type DeliveryContext, type ParentMail } from './outbound/context.js';
export {
  OVERDUE_GRACE_SECONDS,
  REPLY_TOKEN_KEEP_SECONDS,
  actorOfDelivery,
  claimDelivery,
  countRecentFailures,
  denyDelivery,
  markDispatched,
  recordFailure,
  recordSent,
  sweepDeliveries,
  vetDelivery,
  type SentResult,
  type SweepOptions,
  type SweepResult,
  type Vetting,
} from './outbound/dispatch.js';
export { billingPeriod, lockQuota, moveQuota, type QuotaSnapshot } from './outbound/quota.js';
export {
  clearStaleReplyTokens,
  findReplyToken,
  sealReplyToken,
  spendReplyToken,
  type StoredToken,
} from './outbound/reply-token.js';
export {
  approveAiDraftSent,
  scheduleCustomerSend,
  scheduleTemplateAck,
  usesDispatcher,
  type ScheduleOrigin,
  type ScheduleSendInput,
  type ScheduledSend,
  type TemplateAckInput,
} from './outbound/schedule.js';
export {
  readOutboundSettings,
  readUndoSendSeconds,
  setUndoSendSeconds,
} from './outbound/settings.js';
export {
  backoffSeconds,
  canTransition,
  contentHash,
  decideFailure,
  dispatchJobId,
  hasIdempotencyKey,
  isFinal,
  retryKeyExpired,
  type FailureDecision,
  type FailureFacts,
} from './outbound/state.js';
export { toDeliverySummary } from './outbound/summary.js';
export {
  RENDERABLE_TEMPLATE_KEYS,
  renderSystemTemplate,
  safeKeysWithoutRenderer,
  type TemplateVars,
} from './outbound/templates.js';
export {
  SEND_ORIGINS,
  requireAiAction,
  requireCustomerSend,
  type AiActionRequest,
  type CustomerSendRequest,
  type GateAuditMeta,
  type PolicyDecision,
  type PolicyGate,
  type SendOrigin,
} from './policy.js';
export {
  GATE_REASONS,
  ORIGIN_ACTOR,
  decide,
  effectiveStage,
  type DecisionInput,
  type GateReason,
  type IntentStanding,
  type SwitchState,
} from './autonomy/decide.js';
export {
  createPolicyGate,
  readSwitchState,
  switchStateFrom,
  type GateDatabase,
  type PolicyGateOptions,
} from './autonomy/gate.js';
export { SAFE_AUTO_ACK_TEMPLATES } from './autonomy/safe-templates.js';
export {
  readAutonomyState,
  readSwitches,
  setAiSwitch,
  setIntentAutonomy,
  toAutonomyIntent,
  type SetAiSwitchInput,
  type SetIntentAutonomyInput,
  type SetIntentAutonomyResult,
} from './autonomy/state.js';
export type {
  AiDraftRow,
  ContactRow,
  IntentRow,
  MessageRow,
  OutboundDeliveryRow,
  SlaPolicyRow,
  TicketRow,
} from './rows.js';
export {
  FALLBACK_CALENDAR,
  calendarFromRow,
  finishedSlaPauses,
  recomputeSla,
  resolveSlaPolicy,
  resumeSla,
  slaCalendarFor,
  slaForNewTicket,
  targetsFromRow,
  type SlaDue,
  type TicketSla,
  type TicketSlaInput,
} from './sla.js';
export { TicketKeys } from './ticket-keys.js';
export { assignTicket, type AssignTicketInput } from './tickets/assign.js';
export { createTicket, type CreateTicketInput, type CreateTicketResult } from './tickets/create.js';
export { mergeTickets, type MergeTicketInput } from './tickets/merge.js';
export {
  addTicketNote,
  replyToTicket,
  type MessageResult,
  type NoteInput,
  type ReplyInput,
} from './tickets/messages.js';
export { changeTicketStatus, type ChangeStatusInput } from './tickets/status.js';
export {
  lockTicketRow,
  replyDeliveryStatus,
  ticketRefCondition,
  type Sender,
} from './tickets/support.js';
export { updateTicket, type UpdateTicketInput } from './tickets/update.js';
export {
  Effects,
  type Actor,
  type DbTransaction,
  type DomainConfig,
  type DomainContext,
  type DomainResult,
  type ReadExecutor,
} from './types.js';
export { workflowAllows } from './workflow.js';

export interface DomainOptions {
  /** Ticket key prefix, the same value in api and worker (`TICKET_KEY_PREFIX`). */
  readonly ticketKeyPrefix: string;
  /** The subkey that seals outbox secrets (`deriveSubkey(APP_ENCRYPTION_KEY, KEY_LABELS.outboxSecret)`). */
  readonly sealKey: Buffer;
  /** Portal address for the acknowledgment text (ADR-010); optional. */
  readonly portalUrl?: string | undefined;
  /** Seconds a delivery may be retried under one LINE retry key; default `DELIVERY_RETRY_KEY_MAX_AGE_SECONDS`. */
  readonly retryKeyMaxAgeSeconds?: number | undefined;
  /** Days a resolved ticket still reopens on a customer reply. Default: `REOPEN_WINDOW_DAYS`. */
  readonly reopenWindowDays?: number;
  /** Absent means every customer-bound AI action is refused (fail closed, N3). `createPolicyGate` builds the real one. */
  readonly policyGate?: PolicyGate | undefined;
  readonly now?: () => Date;
}

export interface ContextOptions {
  readonly actor: Actor;
  readonly auditMeta?: { readonly ip: string | null; readonly requestId: string | null };
  /** Default: no customer notices. */
  readonly notifier?: TicketNotifier;
}

/**
 * The domain, configured once at boot by the app (ADR-009). The apps validate their environment
 * and pass plain values in; nothing here reads `process.env`. Operations are plain functions
 * `(tx, ctx, input) => { value, events, audited }`; `context()` builds the `ctx`.
 */
export interface Domain {
  readonly config: DomainConfig;
  context(options: ContextOptions): DomainContext;
  readonly tickets: {
    readonly create: typeof createTicket;
    readonly update: typeof updateTicket;
    readonly changeStatus: typeof changeTicketStatus;
    readonly assign: typeof assignTicket;
    readonly merge: typeof mergeTickets;
    readonly reply: typeof replyToTicket;
    readonly note: typeof addTicketNote;
  };
  readonly contacts: { readonly findOrCreateByEmail: typeof findOrCreateContactByEmail };
  readonly intents: { readonly resolve: typeof resolveIntent };
  /** Stage per intent and the two global switches (T-112a, ADR-011). */
  readonly autonomy: {
    readonly read: typeof readAutonomyState;
    readonly setSwitch: typeof setAiSwitch;
    readonly setIntentStage: typeof setIntentAutonomy;
  };
  /** Knowledge base articles (T-107): create, edit, move between statuses, publish. */
  readonly kb: {
    readonly create: typeof createKbArticle;
    readonly update: typeof updateKbArticle;
    readonly transition: typeof transitionKbArticle;
    readonly publish: typeof publishKbArticle;
    readonly publishBreakGlass: typeof publishKbArticleBreakGlass;
    readonly reviewBreakGlass: typeof reviewKbBreakGlass;
  };
  readonly workflow: { readonly allows: typeof workflowAllows };
  readonly sla: {
    readonly resolvePolicy: typeof resolveSlaPolicy;
    readonly calendarFor: typeof slaCalendarFor;
    readonly forNewTicket: typeof slaForNewTicket;
    readonly recompute: typeof recomputeSla;
    readonly finishedPauses: typeof finishedSlaPauses;
    readonly resume: typeof resumeSla;
  };
  readonly assignment: {
    readonly assertAssignableStaff: typeof assertAssignableStaff;
    readonly nextRoundRobin: typeof nextRoundRobin;
    readonly peekRoundRobin: typeof peekRoundRobin;
    readonly takeTurn: typeof takeTurn;
  };
  readonly outbox: { readonly enqueue: typeof enqueueJob };
  /**
   * Delivery to customers (T-122d, ADR-010). `schedule` is called by staff replies on Gmail and LINE
   * (inside `tickets.reply`); the worker's dispatcher uses the claim / vet / record functions.
   */
  readonly outbound: {
    readonly schedule: typeof scheduleCustomerSend;
    readonly scheduleTemplateAck: typeof scheduleTemplateAck;
    readonly cancel: typeof cancelSend;
    readonly claim: typeof claimDelivery;
    readonly vet: typeof vetDelivery;
    readonly deny: typeof denyDelivery;
    readonly markDispatched: typeof markDispatched;
    readonly recordSent: typeof recordSent;
    readonly recordFailure: typeof recordFailure;
    readonly sweep: typeof sweepDeliveries;
    readonly readSettings: typeof readOutboundSettings;
    readonly setUndoSendSeconds: typeof setUndoSendSeconds;
  };
  /** Received messages (ADR-009): used by the worker's `ingest` consumer. */
  readonly inbound: { readonly ingest: typeof ingestInbound };
}

export function createDomain(options: DomainOptions): Domain {
  const config: DomainConfig = {
    ticketKeyPrefix: options.ticketKeyPrefix,
    reopenWindowDays: options.reopenWindowDays ?? REOPEN_WINDOW_DAYS,
    sealKey: options.sealKey,
    portalUrl: options.portalUrl,
    retryKeyMaxAgeSeconds: options.retryKeyMaxAgeSeconds,
  };
  const now = options.now ?? ((): Date => new Date());
  return {
    config,
    context: (contextOptions) => ({
      actor: contextOptions.actor,
      auditMeta: contextOptions.auditMeta ?? { ip: null, requestId: null },
      now,
      config,
      policyGate: options.policyGate,
      notifier: contextOptions.notifier ?? NO_NOTIFIER,
    }),
    tickets: {
      create: createTicket,
      update: updateTicket,
      changeStatus: changeTicketStatus,
      assign: assignTicket,
      merge: mergeTickets,
      reply: replyToTicket,
      note: addTicketNote,
    },
    contacts: { findOrCreateByEmail: findOrCreateContactByEmail },
    intents: { resolve: resolveIntent },
    autonomy: {
      read: readAutonomyState,
      setSwitch: setAiSwitch,
      setIntentStage: setIntentAutonomy,
    },
    kb: {
      create: createKbArticle,
      update: updateKbArticle,
      transition: transitionKbArticle,
      publish: publishKbArticle,
      publishBreakGlass: publishKbArticleBreakGlass,
      reviewBreakGlass: reviewKbBreakGlass,
    },
    workflow: { allows: workflowAllows },
    sla: {
      resolvePolicy: resolveSlaPolicy,
      calendarFor: slaCalendarFor,
      forNewTicket: slaForNewTicket,
      recompute: recomputeSla,
      finishedPauses: finishedSlaPauses,
      resume: resumeSla,
    },
    assignment: { assertAssignableStaff, nextRoundRobin, peekRoundRobin, takeTurn },
    outbox: { enqueue: enqueueJob },
    outbound: {
      schedule: scheduleCustomerSend,
      scheduleTemplateAck,
      cancel: cancelSend,
      claim: claimDelivery,
      vet: vetDelivery,
      deny: denyDelivery,
      markDispatched,
      recordSent,
      recordFailure,
      sweep: sweepDeliveries,
      readSettings: readOutboundSettings,
      setUndoSendSeconds,
    },
    inbound: { ingest: ingestInbound },
  };
}
