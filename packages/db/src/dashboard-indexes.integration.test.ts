import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0070 (T-206b): indexes for the ops dashboard windows. Indexes only, so the test checks that they
// exist, that the dashboard's window filters can use them, and that the migration reverses and applies again.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const INDEXES = [
  'ai_draft_resolved_idx',
  'alert_first_seen_idx',
  'csat_survey_sent_idx',
  'incident_started_idx',
  'ticket_resolved_idx',
] as const;

let testDb: TestDatabase;
const owner = (): Pool => testDb.owner.pool;
const existing = async (): Promise<string[]> => {
  const { rows } = await owner().query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE indexname = ANY($1) ORDER BY indexname`,
    [INDEXES],
  );
  return rows.map((row) => row.indexname);
};

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
});
afterAll(async () => {
  await testDb.cleanup();
});

describe('0070 dashboard indexes', () => {
  it('creates the five indexes', async () => {
    expect(await existing()).toEqual([...INDEXES]);
  });

  it('lets a window filter on resolved tickets use its index', async () => {
    const connection = await owner().connect();
    let plan: string;
    try {
      await connection.query('SET enable_seqscan = off');
      const { rows } = await connection.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT count(*) FROM ticket WHERE resolved_at >= now() - interval '7 days'`,
      );
      plan = rows.map((row) => row['QUERY PLAN']).join('\n');
    } finally {
      connection.release();
    }
    expect(plan).toContain('ticket_resolved_idx');
  });

  it('goes down and up again without touching data', async () => {
    const later = await migrationsAfter('0070_dashboard_indexes');
    if (later.length > 0) await migrateDown(owner(), { steps: later.length });
    expect(await migrateDown(owner(), { steps: 1 })).toEqual(['0070_dashboard_indexes']);
    expect(await existing()).toEqual([]);
    expect(await migrateUp(owner())).toContain('0070_dashboard_indexes');
    expect(await existing()).toEqual([...INDEXES]);
  });
});
