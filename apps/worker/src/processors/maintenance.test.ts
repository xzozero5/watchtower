import type { Database } from '@watchtower/db';
import { MAINTENANCE_JOBS } from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import {
  createMaintenanceProcessor,
  PARTITION_MONTHS_AHEAD,
  PARTITIONED_TABLES,
} from './maintenance.js';

function fakeDatabase(created: number) {
  const query = vi.fn().mockResolvedValue({ rows: [{ created }] });
  return { database: { pool: { query } } as unknown as Database, query };
}

describe('maintenance processor', () => {
  it('asks for the next months of partitions of every partitioned table, append-only except the updatable ones', async () => {
    const { database, query } = fakeDatabase(2);
    const result = await createMaintenanceProcessor(database)({
      name: MAINTENANCE_JOBS.ensurePartitions,
    } as Job);
    expect(result).toEqual({ created: 2 * PARTITIONED_TABLES.length });
    expect(query).toHaveBeenCalledTimes(PARTITIONED_TABLES.length);
    const calls = query.mock.calls as [string, unknown[]][];
    expect(calls[0]?.[0]).toContain("ensure_monthly_partitions('audit_log'");
    expect(calls[1]?.[0]).toContain("ensure_monthly_partitions('ticket_event'");
    // The AI audit trail (T-106d) is partitioned like the audit log.
    expect(calls[2]?.[0]).toContain("ensure_monthly_partitions('ai_run'");
    // The incident timeline (T-202a) is append-only and partitioned too.
    expect(calls[3]?.[0]).toContain("ensure_monthly_partitions('incident_timeline'");
    // The cached usage points (T-205a) are upserted, so their partitions are not append-only.
    expect(calls[4]?.[0]).toContain("ensure_monthly_partitions('usage_metric_point'");
    // The tool ledger (T-203b) stays updatable in the columns it closes a row with, and no others.
    expect(calls[5]?.[0]).toContain("ensure_monthly_partitions('tool_execution'");
    expect(calls[5]?.[0]).toContain(
      "ARRAY['status', 'error_code', 'finished_at', 'latency_ms', 'result_count']",
    );
    for (const [sql, params] of calls) {
      expect(sql).toContain(sql.includes('usage_metric_point') ? 'false' : 'true');
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
