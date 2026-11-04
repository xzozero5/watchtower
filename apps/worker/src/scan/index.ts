import type { ObjectStore } from '@watchtower/channels';
import { SCAN_JOBS } from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';

import { createS3ObjectStore } from '../ingest/object-store.js';
import type { ProcessorContext } from '../processors/index.js';
import { createClamd, type Clamd } from './clamd.js';
import { enrol, housekeeping, retryRemovals, scanDue, type ScannerDeps } from './scanner.js';

/** What a test replaces; production passes none. */
export interface ScanOverrides {
  /** The scanner. Absent: clamd at `CLAMAV_HOST:CLAMAV_PORT` when `UPLOAD_SCAN=clamav`, none when `off`. */
  readonly clamd?: Clamd;
  /** Where files are read from and deleted. Absent: the deployment's S3 bucket. */
  readonly objects?: ObjectStore;
}

/**
 * The consumer of the `scan` queue (T-155, ADR-022). One at a time.
 *
 *  - `tick` (every few seconds): enrols new files, scans the ones that are due through clamd, and
 *    finishes deleting infected files. Does nothing when no file needs tracking (`UPLOAD_SCAN=off` and
 *    no retention).
 *  - `housekeeping` (daily, and once at start): the one-off retroactive enrolment, re-arming files whose
 *    scan gave up, deleting unattached staff uploads, and the retention.
 */
export function createScanRegistration(context: ProcessorContext) {
  const { config, database, logger, overrides } = context;
  const scanning = config.UPLOAD_SCAN === 'clamav';
  const track = scanning || config.UPLOAD_RETENTION_DAYS > 0;
  const deps: ScannerDeps = {
    database,
    logger,
    store:
      overrides.scan?.objects ??
      createS3ObjectStore({
        endpoint: config.S3_ENDPOINT,
        region: config.S3_REGION,
        bucket: config.S3_BUCKET,
        accessKey: config.S3_ACCESS_KEY,
        secretKey: config.S3_SECRET_KEY,
      }),
    clamd: scanning
      ? (overrides.scan?.clamd ??
        createClamd({ host: config.CLAMAV_HOST, port: config.CLAMAV_PORT }))
      : undefined,
  };

  return async (job: Job): Promise<unknown> => {
    switch (job.name) {
      case SCAN_JOBS.tick: {
        if (!track) return { skipped: 'not_tracking' };
        const enrolled = await enrol(deps, 'recent');
        const scanned = await scanDue(deps);
        const removed = await retryRemovals(deps);
        if (scanned.infected > 0)
          logger.warn({ infected: scanned.infected }, 'infected files found and removed');
        return { enrolled, removed, ...scanned };
      }
      case SCAN_JOBS.housekeeping: {
        return housekeeping(deps, { track, retentionDays: config.UPLOAD_RETENTION_DAYS });
      }
      default:
        throw new UnrecoverableError(`unknown scan job "${job.name}"`);
    }
  };
}
