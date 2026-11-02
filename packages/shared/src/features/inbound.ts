/**
 * Inbound ingestion (T-122): this feature's own audit actions, ticket event types and queue names (T-123a).
 *
 * The task that owns this feature adds entries here and nowhere else in `packages/shared`. The
 * global `AUDIT_ACTIONS`, `TICKET_EVENT_TYPES` and `QUEUE_NAMES` are composed from these records
 * (see `./index.ts`), and importing `@watchtower/shared` throws if two features use the same key
 * or the same value. Keys are camelCase; values are lowercase strings (dotted for audit actions and
 * ticket events, the BullMQ queue name for queues). Start a value with the feature name so
 * collisions are unlikely.
 */
import { z } from 'zod';

/** Audit `action` strings written by this feature. */
export const INBOUND_AUDIT_ACTIONS = {
  /** A received message got its disposition (ticket, appended, noise, auto_reply, internal). */
  inboundIngest: 'inbound.ingest',
  /** A person turned a message from "Other mail" into a ticket (T-119). */
  inboundConvert: 'inbound.convert',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const INBOUND_TICKET_EVENTS = {
  /** A new ticket opened because the customer wrote again after the earlier one was closed or too old to reopen. */
  followsUp: 'ticket.follows_up',
} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: api, consumer: worker). */
export const INBOUND_QUEUES = {
  /** Orchestration of one `inbound_event`: normalise, store raw, classify, ingest (ADR-009). */
  ingest: 'ingest',
} as const satisfies Record<string, string>;

export const INGEST_JOBS = {
  /** Process one `inbound_event`. `jobId` is the event id, so the same event is one job. */
  process: 'process',
} as const;

/** Payload of an `ingest` job: only the id; the worker loads the event from the database. */
export const ingestJobSchema = z.object({ inboundEventId: z.uuid() });
export type IngestJob = z.infer<typeof ingestJobSchema>;

/** Retry with backoff; a finished job is dropped (the event row is the record). */
export const INGEST_OUTBOX_JOB_OPTIONS = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

export const INBOUND_EVENT_STATUSES = ['pending', 'processed', 'failed'] as const;
export type InboundEventStatus = (typeof INBOUND_EVENT_STATUSES)[number];

/** `inbound_message.disposition`: what became of a received message (PRD R-2.6, R-2.7). */
export const INBOUND_DISPOSITIONS = [
  'pending',
  'ticket',
  'appended',
  'noise',
  'auto_reply',
  'internal',
] as const;
export type InboundDisposition = (typeof INBOUND_DISPOSITIONS)[number];

/** The dispositions that stay out of the ticket flow and show in "Other mail" (R-2.7). */
export const OTHER_MAIL_DISPOSITIONS = ['noise', 'auto_reply', 'internal'] as const;

/** PRD section 5.1 step 3: the classes the classifier (AI or rules) chooses between. */
export const INBOUND_CLASSIFICATION_TYPES = [
  'noise',
  'reply_to_existing',
  'new_customer_issue',
  'internal_or_machine',
  'triage',
] as const;

export const inboundClassificationSchema = z.object({
  type: z.enum(INBOUND_CLASSIFICATION_TYPES),
  /** Key of an intent; ignored when no active intent has it. */
  intentKey: z.string().min(1).max(120).nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null),
  /** `ai`: the classifier answered in time. `rules`: header rules only (no classifier, timeout, failure). */
  source: z.enum(['ai', 'rules']),
  aiRunId: z.uuid().nullable().default(null),
});
export type InboundClassification = z.infer<typeof inboundClassificationSchema>;
