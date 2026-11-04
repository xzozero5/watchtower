import { procedureSimulateJobSchema } from '@watchtower/shared';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';

import type { ProcessorContext } from '../processors/index.js';
import { delayWhileOffline } from './brief.js';
import { createInvestigationDepsFactory } from './investigation-deps.js';
import { runProcedureSimulationJob } from './procedure-simulate.js';

/**
 * The consumer of the `procedure-simulate` queue (T-303d, ADR-026 section 6): one job is one simulation of one
 * version. It shares the tools and the read-only login of the investigation (`createInvestigationDepsFactory`)
 * and runs one at a time, because a simulation is many model calls. An offline provider (ADR-019) is a wait, not a
 * failure; any other stop writes nothing and leaves the version as it was.
 */
export function createProcedureSimulateProcessor(context: ProcessorContext): Processor {
  const deps = createInvestigationDepsFactory(context);
  return async (job: Job, token?: string): Promise<unknown> => {
    const parsed = procedureSimulateJobSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError('procedure-simulate payload is invalid');
    const result = await runProcedureSimulationJob(await deps(), {
      versionId: parsed.data.versionId,
      requestedBy: parsed.data.requestedBy,
    });
    context.logger.info({ versionId: parsed.data.versionId, ...result }, 'procedure simulation');
    if (result.status === 'stopped' && result.reason === 'provider_offline') {
      await delayWhileOffline(job, token);
    }
    return result;
  };
}
