import { REOPEN_WINDOW_DAYS } from '@watchtower/shared';

import { rejectAiDraft } from './ai/drafts.js';
import {
  assertAssignableStaff,
  nextAssignee,
  nextRoundRobin,
  peekAssignee,
  peekRoundRobin,
  takeTurn,
} from './assignment.js';
import { ackAlert } from './alerts/ack.js';
import { sweepEscalations } from './alerts/escalation.js';
import { recordHeartbeat, sweepHeartbeats } from './alerts/heartbeat.js';
import { ingestAlert } from './alerts/ingest.js';
import { endExpiredSnoozes, snoozeAlert, unsnoozeAlert } from './alerts/snooze.js';
import { readAutonomyState, setAiSwitch, setIntentAutonomy } from './autonomy/state.js';
import { findOrCreateContactByEmail } from './contacts.js';
import {
  confirmProcedureVersion,
  createProcedureDraft,
  publishProcedureVersion,
  readProcedureValidationContext,
  readProcedureVersion,
  readProcedureVersions,
  recordProcedureCompile,
  retireProcedureVersion,
  updateProcedureDraft,
  validateProcedureVersion,
} from './procedures/versions.js';
import { claimCsatEmail, finishCsatEmail, releaseCsatEmail } from './csat/dispatch.js';
import { decideCsatReopen } from './csat/reopen.js';
import {
  answerSurvey,
  findSurveyForLink,
  readCsatDelayMinutes,
  readCsatSettings,
  updateCsatSettings,
  scheduleSurvey,
  setCsatDelayMinutes,
  setCsatOptOut,
  sweepSurveys,
  voidOpenSurveys,
} from './csat/survey.js';
import { mintCsatToken, verifyCsatToken } from './csat/token.js';
import { convertInboundMessage } from './inbound/convert.js';
import { ingestInbound } from './inbound/ingest.js';
import { draftIncidentComm, previewIncidentComm, sendIncidentComm } from './incidents/comms.js';
import { recordDeploy } from './incidents/deploy.js';
import {
  addIncidentNote,
  createIncident,
  linkIncidentAlert,
  linkIncidentTicket,
  unlinkIncidentTicket,
  updateIncident,
} from './incidents/core.js';
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
import { issueLineLinkCode, linkLineUser, redeemLineLinkCode } from './identity/line-link.js';
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
import { plainPortalUrl } from './outbound/templates.js';
import { notifyOpsAlert, notifyShiftAlerts } from './notifications.js';
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
import {
  createStatusComponent,
  deleteStatusComponent,
  updateStatusComponent,
} from './statuspage/components.js';
import {
  cancelStatusMaintenance,
  draftStatusMaintenance,
  publishStatusMaintenance,
  updateStatusMaintenance,
} from './statuspage/maintenance.js';
import {
  deleteStatusPostDraft,
  draftStatusPost,
  draftStatusPostFromIncident,
  publishStatusPost,
  updateStatusPost,
} from './statuspage/posts.js';
import {
  confirmStatusSubscription,
  requestStatusSubscription,
  unsubscribeStatusSubscription,
} from './statuspage/subscriptions.js';
import { computeAllOrgHealth, computeOrgHealth } from './usage/health.js';
import { createUsageMetric, updateUsageMetric } from './usage/metrics.js';
import { dueUsageMetrics, runUsageMetric } from './usage/run.js';
import { assignTicket } from './tickets/assign.js';
import { createTicket } from './tickets/create.js';
import {
  addTicketReference,
  pickUpTicketAsDev,
  releaseTicketAsDev,
  removeTicketReference,
} from './tickets/dev.js';
import { createManualTicket } from './tickets/manual.js';
import { mergeTickets } from './tickets/merge.js';
import { addTicketNote, replyToTicket } from './tickets/messages.js';
import { changeTicketStatus } from './tickets/status.js';
import { updateTicket } from './tickets/update.js';
import type { Actor, CsatConfig, DomainConfig, DomainContext } from './types.js';
import { workflowAllows } from './workflow.js';

export { ackAlert, type AckAlertInput, type AckAlertOutcome } from './alerts/ack.js';
export {
  escalationStepsFor,
  resolveRecipients,
  sweepEscalations,
  type EscalationRecipients,
  type EscalationSweepOptions,
  type EscalationSweepResult,
} from './alerts/escalation.js';
export {
  heartbeatFingerprint,
  recordHeartbeat,
  sweepHeartbeats,
  type HeartbeatSweepResult,
} from './alerts/heartbeat.js';
export { ingestAlert, type IngestAlertInput, type IngestAlertOutcome } from './alerts/ingest.js';
export {
  endExpiredSnoozes,
  snoozeAlert,
  unsnoozeAlert,
  type EndSnoozesResult,
  type SnoozeAlertInput,
  type SnoozeOutcome,
} from './alerts/snooze.js';
export { correlateOpenedAlert } from './alerts/correlate.js';
export {
  addIncidentNote,
  createIncident,
  linkIncidentAlert,
  linkIncidentTicket,
  unlinkIncidentTicket,
  updateIncident,
  type IncidentRef,
  type UpdateIncidentInput,
} from './incidents/core.js';
export {
  draftIncidentComm,
  incidentCommAudience,
  previewIncidentComm,
  sendIncidentComm,
  type SendIncidentCommInput,
  type SendIncidentCommResult,
} from './incidents/comms.js';
export { recordDeploy } from './incidents/deploy.js';
export {
  createStatusComponent,
  deleteStatusComponent,
  updateStatusComponent,
  requirePerson as requireStatusPerson,
} from './statuspage/components.js';
export {
  cancelStatusMaintenance,
  draftStatusMaintenance,
  publishStatusMaintenance,
  updateStatusMaintenance,
} from './statuspage/maintenance.js';
export {
  deleteStatusPostDraft,
  draftStatusPost,
  draftStatusPostFromIncident,
  publishStatusPost,
  updateStatusPost,
} from './statuspage/posts.js';
export {
  STATUS_CONFIRM_WINDOW_HOURS,
  STATUS_RESEND_AFTER_SECONDS,
  confirmStatusSubscription,
  requestStatusSubscription,
  unsubscribeStatusSubscription,
  type SubscriptionRequestOutcome,
} from './statuspage/subscriptions.js';
export {
  mintStatusLink,
  newStatusNonce,
  verifyStatusLink,
  type StatusLinkClaims,
  type StatusLinkPurpose,
} from './statuspage/links.js';
export { canonicalDims, dimsHash, templateHash, type DimSet } from './usage/dims.js';
export { anomalyDedupeKey, detectUsageAnomalies, isAnomalous } from './usage/anomaly.js';
export {
  computeAllOrgHealth,
  computeOrgHealth,
  scoreHealth,
  type HealthFacts,
} from './usage/health.js';
export { createUsageMetric, updateUsageMetric } from './usage/metrics.js';
export { cleanDimValue, parseUsageRows, type ParsedPoint } from './usage/rows.js';
export {
  dueUsageMetrics,
  runUsageMetric,
  type RunOutcome,
  type RunUsageOptions,
  type UsageDataPort,
  type UsageDataResult,
} from './usage/run.js';

export { addTimelineEntry } from './incidents/timeline.js';
export {
  matchService,
  ruleMatches,
  ruleSpecificity,
  type AlertFacts,
  type CatalogEntry,
} from './alerts/match.js';
export { authorityNow } from './clock.js';
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
export {
  upsertAiInsight,
  writeAiInvestigation,
  type AiInsightInput,
  type InsightWriter,
  type InvestigationWrite,
} from './ai/insight.js';
export {
  recordDraftEdited,
  rejectAiDraft,
  saveAiDraft,
  type EditedDraftInput,
  type NewAiDraft,
  type RejectAiDraftInput,
} from './ai/drafts.js';
export {
  hasResolutionGrade,
  intentGradeMetrics,
  recordResolutionGrade,
  type NewResolutionGrade,
} from './ai/grades.js';
export {
  createAiKbDraft,
  ticketKbGap,
  type AiKbDraftInput,
  type KbGapVerdict,
} from './ai/kb-draft.js';
export {
  createDbToolLedger,
  type DbToolLedger,
  type DbToolLedgerOptions,
  type ToolDenialReason,
  type ToolLedgerDecision,
  type ToolLedgerEntry,
  type ToolLedgerFinish,
  type ToolLedgerLimits,
} from './ai/tool-ledger.js';
export {
  acquireRateBudget,
  takeRateBudget,
  type AcquireInput,
  type RateDecision,
  type RateRefusal,
  type RateTx,
} from './tools/rate-budget.js';
export {
  getToolTemplate,
  listToolTemplates,
  templateForAi,
  templatesForTicket,
  type ToolTemplateRecord,
} from './tools/templates.js';
export {
  createHumanToolLedger,
  type HumanToolDecision,
  type HumanToolEntry,
  type HumanToolLedger,
} from './tools/human-ledger.js';
export {
  createAiRunRecorder,
  type AiRunDatabase,
  type AiRunInput,
  type AiRunReceipt,
  type AiRunRecorder,
} from './ai/recorder.js';
export {
  ASSIGN_STRATEGIES,
  assertAssignableStaff,
  isAssignStrategy,
  nextAssignee,
  nextRoundRobin,
  onShiftCondition,
  openTicketCounts,
  peekAssignee,
  peekRoundRobin,
  pickLeastLoaded,
  pickNextMember,
  takeTurn,
  type AssignHints,
  type AssignStrategy,
} from './assignment.js';
export {
  contactSnapshot,
  findOrCreateContactByEmail,
  type FindOrCreateContactInput,
} from './contacts.js';
export {
  generateLinkCode,
  hashLinkCode,
  issueLineLinkCode,
  linkLineUser,
  parseLinkCode,
  redeemLineLinkCode,
  type IssueLinkCodeInput,
  type IssuedLinkCode,
  type LinkLineUserInput,
  type LinkVia,
  type LinkedLineUser,
  type RedeemInput,
  type RedeemOutcome,
} from './identity/line-link.js';
export { DOMAIN_ERROR_CODES, DomainError, isDomainError, type DomainErrorCode } from './errors.js';
export {
  UNIDENTIFIED_ORG_ID,
  UNIDENTIFIED_ORG_NAME,
  ensureSenderContact,
  lookupSender,
  type SenderLookup,
  type SenderVia,
} from './inbound/identity.js';
export {
  convertInboundMessage,
  type ConvertInboundInput,
  type ConvertInboundOutcome,
} from './inbound/convert.js';
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
  kbContentHash,
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
  DEFAULT_SEARCH_TIMEOUT_MS,
  KbSearchTimeoutError,
  MAX_CANDIDATES,
  audienceCondition,
  candidateCount,
  queryTerms,
  searchKb,
  type KbAudience,
  type KbSearchInput,
  type KbSearchOutcome,
} from './kb/search.js';
export { NO_NOTIFIER, type TicketNotifier } from './notifier.js';
export {
  notifyIn,
  notifyOpsAlert,
  notifyShiftAlerts,
  notifyTicketAssigned,
  notifyTicketP1,
  type NotifyInput,
  type OpsNoticeInput,
  type OpsNoticeResult,
  type ShiftAlertInput,
} from './notifications.js';
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
  plainPortalUrl,
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
  confirmProcedureVersion,
  createProcedureDraft,
  publishProcedureVersion,
  readProcedureValidationContext,
  readProcedureVersion,
  readProcedureVersions,
  recordProcedureCompile,
  retireProcedureVersion,
  toProcedureVersion,
  updateProcedureDraft,
  validateProcedureVersion,
  type CreateProcedureDraftInput,
  type RecordProcedureCompileInput,
  type UpdateProcedureDraftInput,
} from './procedures/versions.js';
export { validateProcedureSteps, type ProcedureValidationContext } from './procedures/validate.js';
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
export {
  addTicketReference,
  pickUpTicketAsDev,
  releaseTicketAsDev,
  removeTicketReference,
  type AddTicketReferenceInput,
  type DevOwnerInput,
  type ReleaseDevOwnerInput,
  type RemoveTicketReferenceInput,
} from './tickets/dev.js';
export {
  MANUAL_CONFIRMATION_TEMPLATE,
  createManualTicket,
  type CreateManualTicketResult,
} from './tickets/manual.js';
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
export {
  decideCsatReopen,
  isWithinReopenWindow,
  type CsatReopenDecision,
  type CsatReopenInput,
} from './csat/reopen.js';
export type {
  AnswerSurveyInput,
  AnswerSurveyOutcome,
  SurveyLookup,
  SweepSurveysOptions,
  SweepSurveysResult,
} from './csat/survey.js';
export {
  mintCsatToken,
  verifyCsatToken,
  wholeSeconds,
  type CsatTokenClaims,
} from './csat/token.js';
export type { CsatConfig };

export interface DomainOptions {
  /** Ticket key prefix, the same value in api and worker (`TICKET_KEY_PREFIX`). */
  readonly ticketKeyPrefix: string;
  /** The subkey that seals outbox secrets (`deriveSubkey(APP_ENCRYPTION_KEY, KEY_LABELS.outboxSecret)`). */
  readonly sealKey: Buffer;
  /** Portal address for the acknowledgment text (ADR-010); optional. */
  readonly portalUrl?: string | undefined;
  /** Seconds a delivery may be retried under one LINE retry key; default `DELIVERY_RETRY_KEY_MAX_AGE_SECONDS`. */
  readonly retryKeyMaxAgeSeconds?: number | undefined;
  /** CSAT survey links and page (T-110); absent means the scheduler cannot send. */
  readonly csat?: CsatConfig | undefined;
  /** Days a resolved ticket still reopens on a customer reply. Default: `REOPEN_WINDOW_DAYS`. */
  readonly reopenWindowDays?: number;
  /** Free mail provider domains (matched by whole address when replying by email); default: the built-in list. */
  readonly freeMailDomains?: readonly string[] | undefined;
  /** Absent means every customer-bound AI action is refused (fail closed, N3). `createPolicyGate` builds the real one. */
  readonly policyGate?: PolicyGate | undefined;
  readonly now?: () => Date;
}

export interface ContextOptions {
  readonly actor: Actor;
  /** The person an AI actor works for (T-108e). */
  readonly onBehalfOf?: string | null | undefined;
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
    /** A ticket filed by hand (T-136). */
    readonly createManual: typeof createManualTicket;
    /** The developer's part (T-137). */
    readonly devPickUp: typeof pickUpTicketAsDev;
    readonly devRelease: typeof releaseTicketAsDev;
    readonly referenceAdd: typeof addTicketReference;
    readonly referenceRemove: typeof removeTicketReference;
  };
  readonly contacts: { readonly findOrCreateByEmail: typeof findOrCreateContactByEmail };
  readonly intents: { readonly resolve: typeof resolveIntent };
  /** Stage per intent and the two global switches (T-112a, ADR-011). */
  readonly autonomy: {
    readonly read: typeof readAutonomyState;
    readonly setSwitch: typeof setAiSwitch;
    readonly setIntentStage: typeof setIntentAutonomy;
  };
  /** Procedures per intent (T-303b, ADR-026): drafts, the compiler's steps, confirm, publish, retire. */
  readonly procedures: {
    readonly readVersions: typeof readProcedureVersions;
    readonly readVersion: typeof readProcedureVersion;
    readonly validationContext: typeof readProcedureValidationContext;
    readonly validate: typeof validateProcedureVersion;
    readonly createDraft: typeof createProcedureDraft;
    readonly updateDraft: typeof updateProcedureDraft;
    readonly recordCompile: typeof recordProcedureCompile;
    readonly confirm: typeof confirmProcedureVersion;
    readonly publish: typeof publishProcedureVersion;
    readonly retire: typeof retireProcedureVersion;
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
    readonly nextAssignee: typeof nextAssignee;
    readonly peekAssignee: typeof peekAssignee;
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
  /**
   * Alerts from GCP and Alertmanager (T-201c, ADR-015): `ingest` takes one delivery per call,
   * idempotent. `ack` and `sweepEscalations` are the escalation of R-3.8 (T-201d).
   */
  readonly alerts: {
    readonly ingest: typeof ingestAlert;
    readonly ack: typeof ackAlert;
    readonly sweepEscalations: typeof sweepEscalations;
    /** Snooze with a mandatory expiry and reason (R-3.9), lifted by hand or by `endExpiredSnoozes`. */
    readonly snooze: typeof snoozeAlert;
    readonly unsnooze: typeof unsnoozeAlert;
    readonly endExpiredSnoozes: typeof endExpiredSnoozes;
    /** Heartbeats / dead-man's switches (R-3.10). */
    readonly recordHeartbeat: typeof recordHeartbeat;
    readonly sweepHeartbeats: typeof sweepHeartbeats;
  };
  /** Incidents (R-3.12) and the deploy feed (R-5.4): written by people, never opened by the system. */
  readonly incidents: {
    readonly create: typeof createIncident;
    readonly update: typeof updateIncident;
    readonly linkTicket: typeof linkIncidentTicket;
    readonly unlinkTicket: typeof unlinkIncidentTicket;
    readonly linkAlert: typeof linkIncidentAlert;
    readonly note: typeof addIncidentNote;
    readonly recordDeploy: typeof recordDeploy;
    /** Mass communication (R-3.14, N3): anyone may draft, only a person sends, the count is confirmed. */
    readonly draftComm: typeof draftIncidentComm;
    readonly previewComm: typeof previewIncidentComm;
    readonly sendComm: typeof sendIncidentComm;
  };
  /** The public status page (T-204): drafts by people or the AI, publishing only by a person (N3). */
  readonly statusPage: {
    readonly createComponent: typeof createStatusComponent;
    readonly updateComponent: typeof updateStatusComponent;
    readonly deleteComponent: typeof deleteStatusComponent;
    readonly draftPost: typeof draftStatusPost;
    readonly draftPostFromIncident: typeof draftStatusPostFromIncident;
    readonly updatePost: typeof updateStatusPost;
    readonly publishPost: typeof publishStatusPost;
    readonly deletePostDraft: typeof deleteStatusPostDraft;
    readonly draftMaintenance: typeof draftStatusMaintenance;
    readonly updateMaintenance: typeof updateStatusMaintenance;
    readonly publishMaintenance: typeof publishStatusMaintenance;
    readonly cancelMaintenance: typeof cancelStatusMaintenance;
    readonly requestSubscription: typeof requestStatusSubscription;
    readonly confirmSubscription: typeof confirmStatusSubscription;
    readonly unsubscribe: typeof unsubscribeStatusSubscription;
  };
  /** Product usage metrics, anomalies and the Client Health Score (T-205). */
  readonly usage: {
    readonly createMetric: typeof createUsageMetric;
    readonly updateMetric: typeof updateUsageMetric;
    readonly run: typeof runUsageMetric;
    readonly due: typeof dueUsageMetrics;
    readonly computeHealth: typeof computeOrgHealth;
    readonly computeAllHealth: typeof computeAllOrgHealth;
  };
  /** Received messages (ADR-009): used by the worker's `ingest` consumer. */
  readonly inbound: {
    readonly ingest: typeof ingestInbound;
    /** A person turns a message from Other mail into a ticket (T-119). */
    readonly convert: typeof convertInboundMessage;
  };
  /** AI drafts (T-108c): a person's verdict on a draft. */
  readonly ai: { readonly rejectDraft: typeof rejectAiDraft };
  /** Who is behind a LINE user id: link codes and LINE Login (T-103d, R-2.11). */
  readonly identity: {
    readonly issueLineLinkCode: typeof issueLineLinkCode;
    readonly redeemLineLinkCode: typeof redeemLineLinkCode;
    readonly linkLineUser: typeof linkLineUser;
  };
  /** CSAT surveys and the reopen rules they feed (T-110, R-10.x, R-1.10). */
  readonly csat: {
    readonly schedule: typeof scheduleSurvey;
    readonly voidOpen: typeof voidOpenSurveys;
    readonly sweep: typeof sweepSurveys;
    readonly findForLink: typeof findSurveyForLink;
    readonly answer: typeof answerSurvey;
    readonly readDelayMinutes: typeof readCsatDelayMinutes;
    readonly setDelayMinutes: typeof setCsatDelayMinutes;
    readonly readSettings: typeof readCsatSettings;
    readonly updateSettings: typeof updateCsatSettings;
    /** At-most-once ledger for a survey sent through a Gmail mailbox (T-174). */
    readonly claimEmail: typeof claimCsatEmail;
    readonly finishEmail: typeof finishCsatEmail;
    readonly releaseEmail: typeof releaseCsatEmail;
    readonly setOptOut: typeof setCsatOptOut;
    readonly mintToken: typeof mintCsatToken;
    readonly verifyToken: typeof verifyCsatToken;
    readonly decideReopen: typeof decideCsatReopen;
  };
  /**
   * In-app notifications (T-105). Ticket alerts (P1, assigned) are raised inside `tickets.*`; the
   * shift alerts for leads are raised by whoever has the shift overview (T-111).
   */
  readonly notifications: {
    readonly shiftAlerts: typeof notifyShiftAlerts;
    /** A system notice for the heads, once an hour per kind (T-176). */
    readonly opsAlert: typeof notifyOpsAlert;
  };
}

export function createDomain(options: DomainOptions): Domain {
  const config: DomainConfig = {
    ticketKeyPrefix: options.ticketKeyPrefix,
    reopenWindowDays: options.reopenWindowDays ?? REOPEN_WINDOW_DAYS,
    freeMailDomains: options.freeMailDomains,
    sealKey: options.sealKey,
    portalUrl: plainPortalUrl(options.portalUrl),
    retryKeyMaxAgeSeconds: options.retryKeyMaxAgeSeconds,
    csat: options.csat,
  };
  const now = options.now ?? ((): Date => new Date());
  return {
    config,
    context: (contextOptions) => ({
      actor: contextOptions.actor,
      onBehalfOf: contextOptions.onBehalfOf ?? null,
      auditMeta: contextOptions.auditMeta ?? { ip: null, requestId: null },
      now,
      databaseClock: options.now === undefined,
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
      createManual: createManualTicket,
      devPickUp: pickUpTicketAsDev,
      devRelease: releaseTicketAsDev,
      referenceAdd: addTicketReference,
      referenceRemove: removeTicketReference,
    },
    contacts: { findOrCreateByEmail: findOrCreateContactByEmail },
    intents: { resolve: resolveIntent },
    autonomy: {
      read: readAutonomyState,
      setSwitch: setAiSwitch,
      setIntentStage: setIntentAutonomy,
    },
    procedures: {
      readVersions: readProcedureVersions,
      readVersion: readProcedureVersion,
      validationContext: readProcedureValidationContext,
      validate: validateProcedureVersion,
      createDraft: createProcedureDraft,
      updateDraft: updateProcedureDraft,
      recordCompile: recordProcedureCompile,
      confirm: confirmProcedureVersion,
      publish: publishProcedureVersion,
      retire: retireProcedureVersion,
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
    assignment: {
      assertAssignableStaff,
      nextRoundRobin,
      peekRoundRobin,
      nextAssignee,
      peekAssignee,
      takeTurn,
    },
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
    alerts: {
      ingest: ingestAlert,
      ack: ackAlert,
      sweepEscalations,
      snooze: snoozeAlert,
      unsnooze: unsnoozeAlert,
      endExpiredSnoozes,
      recordHeartbeat,
      sweepHeartbeats,
    },
    incidents: {
      create: createIncident,
      update: updateIncident,
      linkTicket: linkIncidentTicket,
      unlinkTicket: unlinkIncidentTicket,
      linkAlert: linkIncidentAlert,
      note: addIncidentNote,
      recordDeploy,
      draftComm: draftIncidentComm,
      previewComm: previewIncidentComm,
      sendComm: sendIncidentComm,
    },
    ai: { rejectDraft: rejectAiDraft },
    statusPage: {
      createComponent: createStatusComponent,
      updateComponent: updateStatusComponent,
      deleteComponent: deleteStatusComponent,
      draftPost: draftStatusPost,
      draftPostFromIncident: draftStatusPostFromIncident,
      updatePost: updateStatusPost,
      publishPost: publishStatusPost,
      deletePostDraft: deleteStatusPostDraft,
      draftMaintenance: draftStatusMaintenance,
      updateMaintenance: updateStatusMaintenance,
      publishMaintenance: publishStatusMaintenance,
      cancelMaintenance: cancelStatusMaintenance,
      requestSubscription: requestStatusSubscription,
      confirmSubscription: confirmStatusSubscription,
      unsubscribe: unsubscribeStatusSubscription,
    },
    usage: {
      createMetric: createUsageMetric,
      updateMetric: updateUsageMetric,
      run: runUsageMetric,
      due: dueUsageMetrics,
      computeHealth: computeOrgHealth,
      computeAllHealth: computeAllOrgHealth,
    },
    inbound: { ingest: ingestInbound, convert: convertInboundMessage },
    identity: { issueLineLinkCode, redeemLineLinkCode, linkLineUser },
    csat: {
      schedule: scheduleSurvey,
      voidOpen: voidOpenSurveys,
      sweep: sweepSurveys,
      findForLink: findSurveyForLink,
      answer: answerSurvey,
      readDelayMinutes: readCsatDelayMinutes,
      setDelayMinutes: setCsatDelayMinutes,
      readSettings: readCsatSettings,
      updateSettings: updateCsatSettings,
      claimEmail: claimCsatEmail,
      finishEmail: finishCsatEmail,
      releaseEmail: releaseCsatEmail,
      setOptOut: setCsatOptOut,
      mintToken: mintCsatToken,
      verifyToken: verifyCsatToken,
      decideReopen: decideCsatReopen,
    },
    notifications: { shiftAlerts: notifyShiftAlerts, opsAlert: notifyOpsAlert },
  };
}
