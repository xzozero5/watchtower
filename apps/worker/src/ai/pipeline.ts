import {
  AI_JOBS,
  AI_OUTBOX_JOB_OPTIONS,
  QUEUE_NAMES,
  aiDraftJobSchema,
  aiGradeJobSchema,
  aiInvestigateJobSchema,
  aiKbAuthorJobSchema,
  aiSummarizeJobSchema,
  DATA_COLUMN_ALLOW_LIST,
  budgetProjectFor,
} from '@watchtower/shared';
import { assembleToolClients } from '@watchtower/connectors';
import { createDatabase, createProductDbExecutor, type Database } from '@watchtower/db';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';

import type { ProcessorContext } from '../processors/index.js';
import { delayWhileOffline, makeAiBrief } from './brief.js';
import { runGrader } from './grade-job.js';
import { runInvestigation } from './investigation.js';
import { runKbAuthor } from './kb-author-job.js';
import { createSystemToolPorts } from './system-tool-ports.js';
import { readOnlyLoginProblems, systemToolsAllowed, type ReadDb } from './tool-ports.js';

/**
 * The consumer of the `ai` queue (T-106e, T-108). One queue, five jobs:
 *  - `summarize`: classify and summarize a new ticket; when that worked, queue an `investigate` job;
 *  - `investigate`: tools, evidence, report, and a draft reply when the intent is at stage 2;
 *  - `draft`: a person asked for a draft (stage 1 and up), or for a new one;
 *  - `kb_author`: a resolved ticket that cited no article becomes a draft article in review;
 *  - `grade`: a resolved ticket is graded (verified/contained/assumed, draft quality, T-301).
 * Each is its own job, so a failure retries only that step (the tool budget is per ticket and hour).
 * The investigation never sends anything to a customer (N3): the draft waits for a person.
 */
export function createAiPipelineProcessor(context: ProcessorContext): Processor {
  const { database, ai, logger, domain, realtime, config } = context;
  // The clients the logs, data and repo tools read through (mock: fakes over the fixtures and the
  // local product database; no live adapter before T-208). A client that is not connected leaves its tool unregistered.
  const toolClients = assembleToolClients({
    fixturesDir: config.AI_TOOL_FIXTURES_DIR,
    productDb:
      config.PRODUCT_DB_URL === undefined
        ? undefined
        : createProductDbExecutor({
            url: config.PRODUCT_DB_URL,
            applicationName: `${config.OTEL_SERVICE_NAME}-product`,
          }),
    allowColumns: DATA_COLUMN_ALLOW_LIST,
  });
  const systems = createSystemToolPorts(database.db, toolClients);
  const budgetProject = budgetProjectFor(config.GCP_PROJECT_ID);
  const allowSystemTools = systemToolsAllowed(config);
  if (!allowSystemTools) {
    logger.warn(
      'No read-only database login for the AI tools: the logs, data and repo tools are off',
    );
  }

  // The AI tools' own read-only login, created on first use. With none configured they read the same
  // views through the worker's connection (a local mock run); production sets the URL (N2).
  let readOnly: Database | undefined;
  const readDb = (): ReadDb => {
    if (config.AI_READONLY_DATABASE_URL === undefined) return database.db;
    readOnly ??= createDatabase({
      url: config.AI_READONLY_DATABASE_URL,
      max: 3,
      applicationName: `${config.OTEL_SERVICE_NAME}-ai-ro`,
      onError: (error) => {
        logger.error({ err: error }, 'ai read-only connection failed');
      },
    });
    return readOnly.db;
  };

  // The read-only login is checked on first use and again a minute after a failure (N2, T-114a C-4):
  // a login that can write switches the logs, data and repo tools off and says so in the log.
  const RECHECK_MS = 60_000;
  let loginVerified = config.AI_READONLY_DATABASE_URL === undefined;
  let loginCheckedAt = 0;
  const readOnlyLoginOk = async (): Promise<boolean> => {
    if (loginVerified) return true;
    if (Date.now() - loginCheckedAt < RECHECK_MS && loginCheckedAt !== 0) return false;
    loginCheckedAt = Date.now();
    const problems = await readOnlyLoginProblems(readDb());
    if (problems.length === 0) {
      loginVerified = true;
      return true;
    }
    logger.error(
      { problems },
      'AI_READONLY_DATABASE_URL is not a read-only login: the logs, data and repo tools are off',
    );
    return false;
  };
  if (allowSystemTools) void readOnlyLoginOk();

  const investigationDeps = async () => ({
    database,
    readDb: readDb(),
    ai,
    ticketKeyPrefix: config.TICKET_KEY_PREFIX,
    systems,
    budgetProject,
    allowSystemTools: allowSystemTools && (await readOnlyLoginOk()),
    realtime,
    logger,
  });

  return async (job: Job, token?: string): Promise<unknown> => {
    switch (job.name) {
      case AI_JOBS.summarize: {
        const parsed = aiSummarizeJobSchema.safeParse(job.data);
        if (!parsed.success) throw new UnrecoverableError('ai job payload is invalid');
        const result = await makeAiBrief({ database, ai, logger }, parsed.data.ticketId);
        logger.info(
          { ticketId: parsed.data.ticketId, status: result.status, reason: result.reason },
          'ai brief',
        );
        // Offline (ADR-019, T-170): wait for the AI host without using an attempt.
        if (result.reason === 'provider_offline') await delayWhileOffline(job, token);
        if (result.status === 'classified') {
          // Same transaction-free outbox write as the api uses: the job exists once per ticket.
          await domain.outbox.enqueue(database.db, domain.config, {
            queue: QUEUE_NAMES.ai,
            name: AI_JOBS.investigate,
            jobId: `ai-investigate-${parsed.data.ticketId}`,
            payload: { ticketId: parsed.data.ticketId, requestedBy: null },
            options: AI_OUTBOX_JOB_OPTIONS,
          });
        }
        return result;
      }

      case AI_JOBS.investigate: {
        const parsed = aiInvestigateJobSchema.safeParse(job.data);
        if (!parsed.success) throw new UnrecoverableError('ai job payload is invalid');
        const result = await runInvestigation(await investigationDeps(), {
          ticketId: parsed.data.ticketId,
          requestedBy: parsed.data.requestedBy,
          mode: 'investigate',
          noDraft: parsed.data.noDraft,
        });
        logger.info({ ticketId: parsed.data.ticketId, ...result }, 'ai investigation');
        if (result.reason === 'provider_offline') await delayWhileOffline(job, token);
        return result;
      }

      case AI_JOBS.draft: {
        const parsed = aiDraftJobSchema.safeParse(job.data);
        if (!parsed.success) throw new UnrecoverableError('ai job payload is invalid');
        const result = await runInvestigation(await investigationDeps(), {
          ticketId: parsed.data.ticketId,
          requestedBy: parsed.data.requestedBy,
          mode: 'draft',
          note: parsed.data.note,
        });
        logger.info({ ticketId: parsed.data.ticketId, ...result }, 'ai draft');
        if (result.reason === 'provider_offline') await delayWhileOffline(job, token);
        return result;
      }

      case AI_JOBS.kbAuthor: {
        const parsed = aiKbAuthorJobSchema.safeParse(job.data);
        if (!parsed.success) throw new UnrecoverableError('ai job payload is invalid');
        const result = await runKbAuthor(
          { database, domain, ai, logger },
          { ticketId: parsed.data.ticketId, requestedBy: parsed.data.requestedBy },
        );
        logger.info({ ticketId: parsed.data.ticketId, ...result }, 'ai kb author');
        return result;
      }

      case AI_JOBS.grade: {
        const parsed = aiGradeJobSchema.safeParse(job.data);
        if (!parsed.success) throw new UnrecoverableError('ai job payload is invalid');
        const result = await runGrader(
          { database, ai, logger, ticketKeyPrefix: config.TICKET_KEY_PREFIX },
          {
            ticketId: parsed.data.ticketId,
            reopenCount: parsed.data.reopenCount,
            afterCsat: parsed.data.afterCsat,
          },
        );
        logger.info({ ticketId: parsed.data.ticketId, ...result }, 'ai grade');
        // Offline (ADR-019): wait for the AI host without using an attempt, as the brief does.
        if (result.reason === 'provider_offline') await delayWhileOffline(job, token);
        return result;
      }

      default:
        throw new UnrecoverableError(`unknown ai job "${job.name}"`);
    }
  };
}
