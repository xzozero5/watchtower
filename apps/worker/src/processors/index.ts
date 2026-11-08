import { schema, type Database } from '@watchtower/db';
import type { Domain } from '@watchtower/domain';
import { QUEUE_NAMES, type QueueName } from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import type { Processor, Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import type { WorkerConfig } from '../config.js';
import { createAiPipelineProcessor } from '../ai/pipeline.js';
import { createProcedureSimulateProcessor } from '../ai/procedure-simulate-processor.js';
import type { AiOverrides, AiRuntime } from '../ai/runtime.js';
import { createGmailRegistration, type GmailOverrides } from '../gmail/index.js';
import type { GmailRuntime } from '../gmail/runtime.js';
import { createDiscordRegistration, type DiscordOverrides } from '../discord/index.js';
import { createAlertsRegistration, type AlertsOverrides } from '../alerts/index.js';
import { createIncidentsRegistration, type IncidentsOverrides } from '../incidents/index.js';
import { createAutonomyRegistration } from '../autonomy/index.js';
import { createCsatRegistration } from '../csat/index.js';
import { createStatusPageRegistration } from '../statuspage/index.js';
import { createWebPushRegistration, type WebPushOverrides } from '../webpush/index.js';
import { createUsageRegistration, type UsageOverrides } from '../usage/index.js';
import { createScanRegistration, type ScanOverrides } from '../scan/index.js';
import { createIngestRegistration, type IngestOverrides } from '../ingest/index.js';
import type { WorkerLogger } from '../logger.js';
import { createLineRegistration } from '../line/index.js';
import type { LineOverrides } from '../line/transports.js';
import {
  createOutboundRegistration,
  outboundChannelsFor,
  type OutboundOverrides,
} from '../outbound/index.js';
import type { Mailer } from '../mailer.js';
import type { RealtimeSink } from '../realtime.js';
import { createEmailProcessor } from './email.js';
import { chunkOptionsFrom, createKbProcessor } from '../kb/processor.js';
import { createCleanupProcessor } from './cleanup.js';
import { createMaintenanceProcessor } from './maintenance.js';
import { processSystemJob } from './system.js';
import { createInsightsProcessor, INSIGHTS_QUEUE, markInsightDirty } from '../insights/index.js';

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
  /** Redis client for marks and background queues (T-418). */
  readonly redis?: Redis;
  /** Queue `ai` handle for yielding background insights when customer jobs wait (T-418). */
  readonly aiQueue?: Queue;
}

export interface ProcessorOverrides {
  readonly ingest?: IngestOverrides;
  readonly ai?: AiOverrides;
  readonly outbound?: OutboundOverrides;
  readonly gmail?: GmailOverrides;
  readonly discord?: DiscordOverrides;
  readonly line?: LineOverrides;
  readonly alerts?: AlertsOverrides;
  readonly incidents?: IncidentsOverrides;
  readonly usage?: UsageOverrides;
  readonly scan?: ScanOverrides;
  readonly webPush?: WebPushOverrides;
}

export interface ProcessorRegistration {
  /** The queue this processor consumes. Declare the name in `packages/shared/src/features/<feature>.ts`. */
  readonly queue: QueueName;
  /** Builds the processor; called once, at start, after the shared dependencies exist. */
  readonly create: (context: ProcessorContext) => Processor;
  /** Overrides `WORKER_CONCURRENCY` for this queue (for example 1 for a strictly ordered one). */
  readonly concurrency?: number;
}

async function findTicketAssignee(
  database: Database,
  ticketId?: string,
): Promise<string | undefined> {
  if (!ticketId) return undefined;
  const [t] = await database.db
    .select({ assigneeId: schema.ticket.assigneeId })
    .from(schema.ticket)
    .where(eq(schema.ticket.id, ticketId))
    .limit(1);
  return t?.assigneeId ?? undefined;
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
    create: (context) =>
      createEmailProcessor(context.mailer, {
        sealKey: deriveSubkey(context.config.APP_ENCRYPTION_KEY, KEY_LABELS.outboxSecret),
        // A CSAT survey of a Gmail ticket leaves from that support mailbox (T-174).
        csatGmail: {
          database: context.database,
          domain: context.domain,
          channels: outboundChannelsFor(context),
          logger: context.logger,
          appHost: new URL(context.config.APP_URL).hostname,
        },
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
        assistantRetentionDays: config.ASSISTANT_RETENTION_DAYS,
      }),
    concurrency: 1,
  },

  // --- inbound (T-122) ---
  {
    queue: QUEUE_NAMES.ingest,
    create: (context) => {
      const processor: Processor = createIngestRegistration(context);
      return async (job, token, signal) => {
        const result: unknown = await processor(job, token, signal);
        if (context.redis) {
          try {
            const data =
              typeof job.data === 'object' && job.data !== null
                ? (job.data as Record<string, unknown>)
                : {};
            const res =
              typeof result === 'object' && result !== null
                ? (result as Record<string, unknown>)
                : {};
            const ticketId =
              typeof data.ticketId === 'string'
                ? data.ticketId
                : typeof res.ticketId === 'string'
                  ? res.ticketId
                  : undefined;
            const userId = await findTicketAssignee(context.database, ticketId);
            await markInsightDirty(context.redis, 'ticket', userId ? { userId } : undefined);
          } catch (err) {
            context.logger.warn({ err }, 'best-effort markInsightDirty failed for ingest');
          }
        }
        return result;
      };
    },
  },

  // --- outbound (T-122d) ---
  { queue: QUEUE_NAMES.outbound, create: createOutboundRegistration },

  // --- gmail (T-102) ---
  // One at a time: a sync, a renewal and a heartbeat of the same mailbox must not race.
  { queue: QUEUE_NAMES.gmail, create: createGmailRegistration, concurrency: 1 },

  // --- line (T-103) ---
  // One at a time: a webhook may deliver several events in one batch; process them in order.
  { queue: QUEUE_NAMES.line, create: createLineRegistration, concurrency: 1 },

  // --- discord (T-104) ---
  { queue: QUEUE_NAMES.discord, create: createDiscordRegistration },

  // --- notifications (T-105) ---
  { queue: QUEUE_NAMES.webPush, create: createWebPushRegistration },

  // --- ai (T-106, T-108) ---
  {
    queue: QUEUE_NAMES.ai,
    create: (context) => {
      const processor = createAiPipelineProcessor(context);
      return async (job, token, signal) => {
        const result: unknown = await processor(job, token, signal);
        if (context.redis) {
          try {
            const data =
              typeof job.data === 'object' && job.data !== null
                ? (job.data as Record<string, unknown>)
                : {};
            const ticketId = typeof data.ticketId === 'string' ? data.ticketId : undefined;
            const userId = await findTicketAssignee(context.database, ticketId);
            await markInsightDirty(context.redis, 'ticket', userId ? { userId } : undefined);
            await markInsightDirty(context.redis, 'sla');
          } catch (err) {
            context.logger.warn({ err }, 'best-effort markInsightDirty failed for ai');
          }
        }
        return result;
      };
    },
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

  // --- autonomy (T-112, T-304e) ---
  // One at a time: two watches would only read the same rows.
  { queue: QUEUE_NAMES.autonomy, create: createAutonomyRegistration, concurrency: 1 },

  // --- credentials (T-116) ---

  // --- views (T-119) ---

  // --- alerts (T-201d) ---
  // One at a time: two sweeps would only contend for the same alerts (the rows are locked anyway).
  {
    queue: QUEUE_NAMES.alerts,
    create: (context) => {
      const processor: Processor = createAlertsRegistration(context);
      return async (job, token, signal) => {
        const result: unknown = await processor(job, token, signal);
        if (context.redis) {
          try {
            await markInsightDirty(context.redis, 'alert');
          } catch (err) {
            context.logger.warn({ err }, 'best-effort markInsightDirty failed for alerts');
          }
        }
        return result;
      };
    },
    concurrency: 1,
  },

  // --- incidents (T-202b) ---
  // The Discord thread of an incident, then the lines mirrored into it.
  {
    queue: QUEUE_NAMES.incidents,
    create: (context) => {
      const processor: Processor = createIncidentsRegistration(context);
      return async (job, token, signal) => {
        const result: unknown = await processor(job, token, signal);
        if (context.redis) {
          try {
            await markInsightDirty(context.redis, 'incident');
          } catch (err) {
            context.logger.warn({ err }, 'best-effort markInsightDirty failed for incidents');
          }
        }
        return result;
      };
    },
  },

  // --- statuspage (T-204c) ---
  // The double opt-in email and the notices of a published post or window.
  { queue: QUEUE_NAMES.statuspage, create: createStatusPageRegistration },

  // --- usage (T-205b) ---
  // One at a time: two ticks would only contend for the same metrics (each is claimed under a row lock).
  { queue: QUEUE_NAMES.usage, create: createUsageRegistration, concurrency: 1 },

  // --- procedure (T-303d) ---
  // One at a time: a simulation is up to 150 model calls and a few hundred tool calls on one intent.
  {
    queue: QUEUE_NAMES.procedureSimulate,
    create: createProcedureSimulateProcessor,
    concurrency: 1,
  },

  // --- uploads (T-155) ---
  // One at a time: two ticks would scan the same files twice.
  { queue: QUEUE_NAMES.scan, create: createScanRegistration, concurrency: 1 },

  // --- insights (T-418, ADR-029 section 9.4) ---
  // Strictly one at a time, isolated from the main `ai` queue.
  {
    queue: INSIGHTS_QUEUE,
    create: createInsightsProcessor,
    concurrency: 1,
  },
];
