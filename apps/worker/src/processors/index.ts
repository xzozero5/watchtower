import type { Database } from '@watchtower/db';
import type { Domain } from '@watchtower/domain';
import { QUEUE_NAMES, type QueueName } from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import type { Processor } from 'bullmq';

import type { WorkerConfig } from '../config.js';
import { createAiPipelineProcessor } from '../ai/pipeline.js';
import type { AiOverrides, AiRuntime } from '../ai/runtime.js';
import { createGmailRegistration, type GmailOverrides } from '../gmail/index.js';
import type { GmailRuntime } from '../gmail/runtime.js';
import { createDiscordRegistration, type DiscordOverrides } from '../discord/index.js';
import { createCsatRegistration } from '../csat/index.js';
import { createIngestRegistration, type IngestOverrides } from '../ingest/index.js';
import type { WorkerLogger } from '../logger.js';
import { createLineRegistration } from '../line/index.js';
import type { LineOverrides } from '../line/transports.js';
import { createOutboundRegistration, type OutboundOverrides } from '../outbound/index.js';
import type { Mailer } from '../mailer.js';
import type { RealtimeSink } from '../realtime.js';
import { createEmailProcessor } from './email.js';
import { chunkOptionsFrom, createKbProcessor } from '../kb/processor.js';
import { createCleanupProcessor } from './cleanup.js';
import { createMaintenanceProcessor } from './maintenance.js';
import { processSystemJob } from './system.js';

/** What a processor may need. Add a field here only when two features want it. */
export interface ProcessorContext {
  readonly config: WorkerConfig;
  readonly logger: WorkerLogger;
  readonly database: Database;
  readonly mailer: Mailer;
  /** The shared write logic, built once at boot from the worker config (ADR-009). */
  readonly domain: Domain;
  /** Publishes realtime events after a commit. */
  readonly realtime: RealtimeSink;
  /** The AI layer (T-106e, T-132): the adapter `AI_PROVIDER` selects. Absent only in tests that leave AI out. */
  readonly ai: AiRuntime | undefined;
  /** How the worker reaches Gmail mailboxes: fakes in mock mode, the live transport only with a complete credential (T-102). */
  readonly gmail: GmailRuntime;
  /** Test doubles for the outside world (storage, provider transports, classifier). Production passes none. */
  readonly overrides: ProcessorOverrides;
}

export interface ProcessorOverrides {
  readonly ingest?: IngestOverrides;
  readonly ai?: AiOverrides;
  readonly outbound?: OutboundOverrides;
  readonly gmail?: GmailOverrides;
  readonly discord?: DiscordOverrides;
  readonly line?: LineOverrides;
}

export interface ProcessorRegistration {
  /** The queue this processor consumes. Declare the name in `packages/shared/src/features/<feature>.ts`. */
  readonly queue: QueueName;
  /** Builds the processor; called once, at start, after the shared dependencies exist. */
  readonly create: (context: ProcessorContext) => Processor;
  /** Overrides `WORKER_CONCURRENCY` for this queue (for example 1 for a strictly ordered one). */
  readonly concurrency?: number;
}

/**
 * Every queue consumer of the worker (T-123a). To add one: write `processors/<name>.ts`, then add
 * one line to your own feature section below and nothing else (the queue name is declared in
 * `packages/shared/src/features/<feature>.ts`; a repeating job goes in `../schedules.ts`).
 * Sections are separated by blank lines on purpose, so two features adding a line do not conflict.
 */
export const PROCESSORS: readonly ProcessorRegistration[] = [
  // --- core ---
  { queue: QUEUE_NAMES.system, create: () => processSystemJob },
  {
    queue: QUEUE_NAMES.email,
    create: ({ config, mailer }) =>
      createEmailProcessor(mailer, {
        sealKey: deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.outboxSecret),
      }),
  },
  {
    queue: QUEUE_NAMES.maintenance,
    create: ({ database }) => createMaintenanceProcessor(database),
  },
  {
    // Strictly one at a time: two cleanups would only contend for the same rows.
    queue: QUEUE_NAMES.cleanup,
    create: ({ config, database, logger }) =>
      createCleanupProcessor(database, logger, {
        authRetentionDays: config.CLEANUP_AUTH_RETENTION_DAYS,
        breakGlassRetentionDays: config.CLEANUP_BREAK_GLASS_RETENTION_DAYS,
      }),
    concurrency: 1,
  },

  // --- inbound (T-122) ---
  { queue: QUEUE_NAMES.ingest, create: createIngestRegistration },

  // --- outbound (T-122d) ---
  { queue: QUEUE_NAMES.outbound, create: createOutboundRegistration },

  // --- gmail (T-102) ---
  // One at a time: a sync, a renewal and a heartbeat of the same mailbox must not race.
  { queue: QUEUE_NAMES.gmail, create: createGmailRegistration, concurrency: 1 },

  // --- line (T-103) ---
  { queue: QUEUE_NAMES.line, create: createLineRegistration, concurrency: 1 },

  // --- discord (T-104) ---
  { queue: QUEUE_NAMES.discord, create: createDiscordRegistration },

  // --- notifications (T-105) ---

  // --- ai (T-106, T-108) ---
  {
    queue: QUEUE_NAMES.ai,
    create: createAiPipelineProcessor,
  },

  // --- kb (T-107) ---
  {
    queue: QUEUE_NAMES.kb,
    create: ({ config, database, ai, logger }) =>
      createKbProcessor({ database, ai, logger, chunking: chunkOptionsFrom(config) }),
  },

  // --- csat (T-110) ---
  { queue: QUEUE_NAMES.csat, create: createCsatRegistration, concurrency: 1 },

  // --- shifts (T-111) ---

  // --- autonomy (T-112) ---

  // --- credentials (T-116) ---

  // --- views (T-119) ---
];
