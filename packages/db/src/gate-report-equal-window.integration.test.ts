import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const CHECK_VIOLATION = '23514';

let testDb: TestDatabase;
let app: Pool;
const owner = (): Pool => testDb.owner.pool;

async function scalar<T>(pool: Pool, text: string, values: unknown[] = []): Promise<T> {
  const result = await pool.query<{ value: T }>(text, values);
  const row = result.rows[0];
  if (row === undefined) throw new Error('query returned no row');
  return row.value;
}

let counter = 0;
const unique = (prefix: string): string => `${prefix}_${String((counter += 1))}`;

async function newIntent(daysOld = 0): Promise<{ id: string; key: string }> {
  const key = unique('equal_win');
  const id = await scalar<string>(
    owner(),
    `INSERT INTO intent (key, name, created_at)
     VALUES ($1, 'Equal Window Probe', now() - make_interval(days => $2))
     RETURNING id AS value`,
    [key, daysOld],
  );
  return { id, key };
}

const metrics = JSON.stringify({ resolved: 10, aiShare: 0.5 });
const passing = JSON.stringify([{ key: 'precision', pass: true, value: 0.99, threshold: 0.95 }]);
const failing = JSON.stringify([{ key: 'precision', pass: false, value: 0.5, threshold: 0.95 }]);

beforeAll(async () => {
  if (!adminUrl) throw new Error('TEST_DATABASE_URL must point at disposable Postgres');
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 5 });
});

afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

describe('0118 gate report equal-window bug (T-446)', () => {
  it('allows window_start == window_end for fresh intent when status = insufficient_data', async () => {
    const intent = await newIntent(0);

    // Using exact identical timestamps for window_start and window_end
    const nowResult = await owner().query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const now = nowResult.rows[0]?.now ?? new Date();

    const writtenId = await scalar<string>(
      app,
      `SELECT public.record_autonomy_gate_report(
        $1::uuid, 'insufficient_data', 'on_demand', $2::timestamptz, $2::timestamptz,
        $3::jsonb, $4::jsonb, true, NULL
      ) AS value`,
      [intent.id, now.toISOString(), metrics, failing],
    );

    expect(writtenId).toMatch(/^[0-9a-f-]{36}$/);

    const checkRow = await owner().query<{
      status: string;
      window_start: Date;
      window_end: Date;
    }>(`SELECT status, window_start, window_end FROM autonomy_gate_report WHERE id = $1::uuid`, [
      writtenId,
    ]);
    expect(checkRow.rows[0]?.status).toBe('insufficient_data');
    expect(checkRow.rows[0]?.window_start.getTime()).toBe(checkRow.rows[0]?.window_end.getTime());
  });

  it('refuses window_start == window_end when status is red or green', async () => {
    const intent = await newIntent(0);
    const nowResult = await owner().query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const now = nowResult.rows[0]?.now ?? new Date();

    // Red with equal window must fail
    await expect(
      app.query(
        `SELECT public.record_autonomy_gate_report(
          $1::uuid, 'red', 'on_demand', $2::timestamptz, $2::timestamptz,
          $3::jsonb, $4::jsonb, true, NULL
        )`,
        [intent.id, now.toISOString(), metrics, failing],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    // Green with equal window must fail
    await expect(
      app.query(
        `SELECT public.record_autonomy_gate_report(
          $1::uuid, 'green', 'on_demand', $2::timestamptz, $2::timestamptz,
          $3::jsonb, $4::jsonb, true, NULL
        )`,
        [intent.id, now.toISOString(), metrics, passing],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('refuses reversed window (window_end < window_start) for all statuses', async () => {
    const intent = await newIntent(10);
    const nowResult = await owner().query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const now = nowResult.rows[0]?.now ?? new Date();
    const earlier = new Date(now.getTime() - 60_000);

    for (const status of ['insufficient_data', 'red', 'green']) {
      await expect(
        app.query(
          `SELECT public.record_autonomy_gate_report(
            $1::uuid, $2, 'on_demand', $3::timestamptz, $4::timestamptz,
            $5::jsonb, $6::jsonb, true, NULL
          )`,
          [
            intent.id,
            status,
            now.toISOString(), // start is later
            earlier.toISOString(), // end is earlier
            metrics,
            status === 'green' ? passing : failing,
          ],
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
  });

  it('refuses green status with window shorter than 28 days', async () => {
    const intent = await newIntent(60);
    const nowResult = await owner().query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const now = nowResult.rows[0]?.now ?? new Date();
    const shortStart = new Date(now.getTime() - 27 * 86_400_000); // 27 days

    await expect(
      app.query(
        `SELECT public.record_autonomy_gate_report(
          $1::uuid, 'green', 'on_demand', $2::timestamptz, $3::timestamptz,
          $4::jsonb, $5::jsonb, true, NULL
        )`,
        [intent.id, shortStart.toISOString(), now.toISOString(), metrics, passing],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('rolls back cleanly when no equal-window row exists and refuses rollback when equal-window rows exist', async () => {
    // 1. Fresh disposable database to test rollback when empty
    const reversibilityDb = await createTestDatabase(adminUrl);
    const revOwner = reversibilityDb.owner.pool;

    try {
      const later = await migrationsAfter('0118_gate_report_equal_window');
      // Should roll back 0118 cleanly
      expect(await migrateDown(revOwner, { steps: later.length + 1 })).toEqual([
        ...[...later].reverse(),
        '0118_gate_report_equal_window',
      ]);

      // Now under 0111, inserting equal-window row should be rejected by the old constraint
      const intentKey = unique('rev_intent');
      const intentId = await scalar<string>(
        revOwner,
        `INSERT INTO intent (key, name, created_at) VALUES ($1, 'Rollback Probe', now()) RETURNING id AS value`,
        [intentKey],
      );

      const nowResult = await revOwner.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const now = nowResult.rows[0]?.now ?? new Date();

      await expect(
        revOwner.query(
          `SELECT public.record_autonomy_gate_report(
            $1::uuid, 'insufficient_data', 'on_demand', $2::timestamptz, $2::timestamptz,
            $3::jsonb, $4::jsonb, true, NULL
          )`,
          [intentId, now.toISOString(), metrics, failing],
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });

      // Migrate up back to 0118
      expect(await migrateUp(revOwner)).toEqual(['0118_gate_report_equal_window', ...later]);

      // Insert an equal-window row under 0118
      await scalar<string>(
        revOwner,
        `SELECT public.record_autonomy_gate_report(
          $1::uuid, 'insufficient_data', 'on_demand', $2::timestamptz, $2::timestamptz,
          $3::jsonb, $4::jsonb, true, NULL
        ) AS value`,
        [intentId, now.toISOString(), metrics, failing],
      );

      // Now rolling back 0118 must be refused because an equal-window row exists
      await expect(migrateDown(revOwner, { steps: later.length + 1 })).rejects.toThrow(
        /autonomy_gate_report contains equal-window rows/,
      );

      // Verify the equal-window row is still intact
      const remaining = await revOwner.query<{ count: string }>(
        `SELECT count(*) FROM autonomy_gate_report WHERE window_end = window_start`,
      );
      expect(remaining.rows[0]?.count).toBe('1');
    } finally {
      await reversibilityDb.cleanup();
    }
  });
});
