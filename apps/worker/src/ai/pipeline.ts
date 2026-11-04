import {
  AI_JOBS,
  AI_OUTBOX_JOB_OPTIONS,
  QUEUE_NAMES,
  aiDraftJobSchema,
  aiGradeJobSchema,
  aiInvestigateJobSchema,
  aiKbAuthorJobSchema,
  aiSummarizeJobSchema,
} from '@watchtower/shared';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';

import type { ProcessorContext } from '../processors/index.js';
import { delayWhileOffline, makeAiBrief } from './brief.js';
import { runGrader } from './grade-job.js';
import { runInvestigation } from './investigation.js';
import { runKbAuthor } from './kb-author-job.js';
import { createInvestigationDepsFactory } from './investigation-deps.js';

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
  const { database, ai, logger, domain, config } = context;
  const investigationDeps = createInvestigationDepsFactory(context);

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
