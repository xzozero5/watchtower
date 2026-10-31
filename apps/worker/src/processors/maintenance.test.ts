import type { Database } from '@watchtower/db';
import { MAINTENANCE_JOBS } from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { createMaintenanceProcessor, PARTITION_MONTHS_AHEAD } from './maintenance.js';

function fakeDatabase(created: number) {
  const query = vi.fn().mockResolvedValue({ rows: [{ created }] });
  return { database: { pool: { query } } as unknown as Database, query };
}

describe('maintenance processor', () => {
  it('asks for the next months of partitions of every append-only table, append-only', async () => {
    const { database, query } = fakeDatabase(2);
    const result = await createMaintenanceProcessor(database)({
      name: MAINTENANCE_JOBS.ensurePartitions,
    } as Job);
    expect(result).toEqual({ created: 4 });
    expect(query).toHaveBeenCalledTimes(2);
    const calls = query.mock.calls as [string, unknown[]][];
    expect(calls[0]?.[0]).toContain("ensure_monthly_partitions('audit_log'");
    expect(calls[1]?.[0]).toContain("ensure_monthly_partitions('ticket_event'");
    for (const [sql, params] of calls) {
      expect(sql).toContain('true');
      expect(params).toEqual([PARTITION_MONTHS_AHEAD]);
    }
  });

  it('ends an unknown job without touching the database', async () => {
    const { database, query } = fakeDatabase(0);
    await expect(
      createMaintenanceProcessor(database)({ name: 'mystery' } as Job),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(query).not.toHaveBeenCalled();
  });
});
