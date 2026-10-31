import type { Database } from '@watchtower/db';
import { QUEUE_NAMES, type QueueName } from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import type { Processor } from 'bullmq';

import type { WorkerConfig } from '../config.js';
import type { WorkerLogger } from '../logger.js';
import type { Mailer } from '../mailer.js';
import { createEmailProcessor } from './email.js';
import { createMaintenanceProcessor } from './maintenance.js';
import { processSystemJob } from './system.js';

/** What a processor may need. Add a field here only when two features want it. */
export interface ProcessorContext {
  readonly config: WorkerConfig;
  readonly logger: WorkerLogger;
  readonly database: Database;
  readonly mailer: Mailer;
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

  // --- inbound (T-122) ---

  // --- outbound (T-122d) ---

  // --- gmail (T-102) ---

  // --- line (T-103) ---

  // --- discord (T-104) ---

  // --- notifications (T-105) ---

  // --- ai (T-106, T-108) ---

  // --- kb (T-107) ---

  // --- csat (T-110) ---

  // --- shifts (T-111) ---

  // --- autonomy (T-112) ---

  // --- credentials (T-116) ---

  // --- views (T-119) ---
];
