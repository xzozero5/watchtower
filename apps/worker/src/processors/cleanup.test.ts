import type { Database } from '@watchtower/db';
import { CLEANUP_JOBS } from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { createCleanupProcessor } from './cleanup.js';

function fakes(rowCount: number) {
  const query = vi.fn().mockResolvedValue({ rowCount });
  const logger = { info: vi.fn(), warn: vi.fn() };
  return { database: { pool: { query } } as unknown as Database, query, logger };
}

describe('cleanup processor', () => {
  it('purges with the configured retention and logs counts only', async () => {
    const { database, query, logger } = fakes(0);
    const result = await createCleanupProcessor(database, logger, {
      authRetentionDays: 3,
      breakGlassRetentionDays: 10,
    })({ name: CLEANUP_JOBS.purgeExpired } as Job);
    expect(result).toMatchObject({ sessions: 0, more: false });
    const calls = query.mock.calls as [string, number[]][];
    expect(calls).toHaveLength(5);
    // Four auth tables use the auth retention, the break-glass table its own.
    expect(calls.map(([, params]) => params[0])).toEqual([3, 3, 3, 3, 10]);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reports what it deleted, and warns when a backlog is left', async () => {
    const { database, logger } = fakes(1000);
    const result = await createCleanupProcessor(database, logger, { maxBatches: 2 })({
      name: CLEANUP_JOBS.purgeExpired,
    } as Job);
    expect(result.more).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      { deleted: expect.objectContaining({ sessions: 2000 }) as unknown },
      'expired rows deleted',
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('ends an unknown job without touching the database', async () => {
    const { database, query, logger } = fakes(0);
    await expect(
      createCleanupProcessor(database, logger)({ name: 'mystery' } as Job),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(query).not.toHaveBeenCalled();
  });
});
