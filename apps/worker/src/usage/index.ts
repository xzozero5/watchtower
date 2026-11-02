import { createRedactor } from '@watchtower/ai';
import type { UsageDataPort } from '@watchtower/domain';
import { USAGE_JOBS, USAGE_REDACTED_DIM } from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';

import type { WorkerLogger } from '../logger.js';
import type { ProcessorContext } from '../processors/index.js';
import { usageDataPortFromConfig } from './data-port.js';

/** What a test replaces; production passes none. */
export interface UsageOverrides {
  /**
   * The product data. Absent: the one built from the environment (the data client of T-203, mock data in
   * development); with that missing too the scheduler runs nothing (this build has no connection to a product
   * database; the real one is behind `[ASK-HUMAN]`, T-208).
   */
  readonly port?: UsageDataPort;
}

/** How many metrics one tick runs at most, so a tick stays short and the next one picks up the rest. */
const TICK_LIMIT = 20;

/**
 * The consumer of the `usage` queue (T-205b). One at a time.
 *
 *  - `tick` (every minute): runs the metrics that are due by the database clock, through the data port.
 *    Each run is idempotent (an upsert over its window), so a repeated or overlapping tick changes nothing.
 *    A dimension value goes through the PII redactor before it is stored. With no port the tick does
 *    nothing and says so once.
 *  - `health` (daily): computes today's Client Health Score of every active organization.
 */
export function createUsageRegistration(context: ProcessorContext) {
  const { database, domain, logger, overrides, realtime, config } = context;
  // A test hands its own port; otherwise the product data comes through the guarded client of T-203
  // (the product database behind PRODUCT_DB_URL, or a fake over the fixtures). Neither: nothing runs.
  const port = overrides.usage?.port ?? usageDataPortFromConfig(config, database.db);
  const redactor = createRedactor();
  let announced = false;

  const system = () => domain.context({ actor: { type: 'system', id: null } });

  return async (job: Job): Promise<unknown> => {
    switch (job.name) {
      case USAGE_JOBS.tick: {
        if (port === undefined) {
          if (!announced) {
            announced = true;
            logger.info('No product data port is connected: usage metrics are not run');
          }
          return { ran: 0, skipped: 'no_data_port' };
        }
        return tick(database, domain, port, redactor, logger);
      }
      case USAGE_JOBS.health: {
        const result = await domain.usage.computeAllHealth(database.db, system());
        logger.info({ ...result }, 'org health computed');
        return result;
      }
      default:
        throw new UnrecoverableError(`unknown usage job "${job.name}"`);
    }
  };

  async function tick(
    db: ProcessorContext['database'],
    d: ProcessorContext['domain'],
    dataPort: UsageDataPort,
    redact: ReturnType<typeof createRedactor>,
    log: WorkerLogger,
  ) {
    const ids = await d.usage.due(db.db, TICK_LIMIT);
    let ran = 0;
    let anomalies = 0;
    for (const id of ids) {
      const session = redact.session({ scope: `usage-${id}` });
      const outcome = await d.usage.run(
        db.db,
        system(),
        {
          port: dataPort,
          // A value the redactor would change is stored as one fixed marker (see `cleanDimValue`). If the
          // redactor refuses a value it is treated the same way: personal data is never the fallback.
          sanitizeDim: (value) => {
            try {
              return session.redact(value);
            } catch {
              return USAGE_REDACTED_DIM;
            }
          },
        },
        id,
      );
      if (outcome.state === 'not_due') continue;
      ran += 1;
      if (outcome.state === 'ok') {
        anomalies += outcome.anomalies;
        // Staff screens learn of the new alert after the commit; a failed publish loses a refresh, not data.
        for (const event of outcome.events) {
          try {
            await realtime.publish(event);
          } catch (error) {
            log.warn({ err: error, eventType: event.type }, 'realtime publish failed');
          }
        }
        log.info(
          { points: outcome.points, anomalies: outcome.anomalies, capped: outcome.capped },
          'usage metric run',
        );
      } else {
        log.warn({ code: outcome.code }, 'usage metric run failed');
      }
    }
    return { ran, anomalies };
  }
}
