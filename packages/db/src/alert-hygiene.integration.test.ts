import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PG, isPgError } from './errors.js';
import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0043 (T-201e): snooze, correlation and heartbeats. The constraints keep a snooze whole
// (expiry, reason and start together, reason bounded), a heartbeat's state honest, and the default
// correlation rule in place.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
let app: Pool;
const owner = (): Pool => testDb.owner.pool;
let counter = 0;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
});
afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

async function rejects(work: Promise<unknown>, code: string): Promise<void> {
  try {
    await work;
  } catch (error) {
    expect(isPgError(error, code), String(error)).toBe(true);
    return;
  }
  throw new Error(`expected Postgres error ${code}`);
}

async function insertAlert(source = 'alertmanager'): Promise<string> {
  counter += 1;
  const result = await app.query<{ id: string }>(
    `INSERT INTO alert (fingerprint, source, title) VALUES ($1, $2, 'Alert') RETURNING id`,
    [counter.toString(16).padStart(64, '0'), source],
  );
  return result.rows[0]?.id ?? '';
}

describe('0043 snooze', () => {
  it('needs an expiry, a reason and a start together; the reason is bounded', async () => {
    const id = await insertAlert();
    await rejects(
      app.query(`UPDATE alert SET snoozed_until = now() + interval '1 hour' WHERE id = $1`, [id]),
      PG.checkViolation,
    );
    await rejects(
      app.query(`UPDATE alert SET snooze_reason = 'because' WHERE id = $1`, [id]),
      PG.checkViolation,
    );
    await rejects(
      app.query(
        `UPDATE alert SET snoozed_until = now() + interval '1 hour', snooze_reason = 'x', snoozed_at = now() WHERE id = $1`,
        [id],
      ),
      PG.checkViolation,
    );
    await rejects(
      app.query(
        `UPDATE alert SET snoozed_until = now() + interval '1 hour', snooze_reason = repeat('x', 501), snoozed_at = now() WHERE id = $1`,
        [id],
      ),
      PG.checkViolation,
    );
    await app.query(
      `UPDATE alert SET snoozed_until = now() + interval '1 hour', snooze_reason = 'Planned failover', snoozed_at = now() WHERE id = $1`,
      [id],
    );
  });
});

describe('0043 correlation_rule', () => {
  it('seeds one default rule: same service, ten minutes, two alerts', async () => {
    const rows = await owner().query(
      `SELECT name, kind, window_minutes, min_alerts, active FROM correlation_rule`,
    );
    expect(rows.rows).toEqual([
      {
        name: 'Same service',
        kind: 'same_service',
        window_minutes: 10,
        min_alerts: 2,
        active: true,
      },
    ]);
  });

  it('bounds the window and the minimum, knows one kind, and keeps names unique ignoring case', async () => {
    const insert = (name: string, kind: string, window: number, min: number) =>
      app.query(
        `INSERT INTO correlation_rule (name, kind, window_minutes, min_alerts) VALUES ($1, $2, $3, $4)`,
        [name, kind, window, min],
      );
    await rejects(insert('a', 'same_service', 0, 2), PG.checkViolation);
    await rejects(insert('a', 'same_service', 1441, 2), PG.checkViolation);
    await rejects(insert('a', 'same_service', 5, 1), PG.checkViolation);
    await rejects(insert('a', 'same_service', 5, 51), PG.checkViolation);
    await rejects(insert('a', 'same_org', 5, 2), PG.checkViolation);
    await insert('Fast', 'same_service', 5, 2);
    await rejects(insert('FAST', 'same_service', 5, 2), PG.uniqueViolation);
  });
});

describe('0043 heartbeat', () => {
  const insert = (fields: string, values: unknown[]) =>
    app.query(
      `INSERT INTO heartbeat (${fields}) VALUES (${values.map((_, i) => `$${String(i + 1)}`).join(', ')})`,
      values,
    );

  it('keeps slug, interval, grace and severity in range and the slug unique', async () => {
    await insert('slug, name, expected_interval_seconds', ['nightly-job', 'Nightly', 3600]);
    await rejects(
      insert('slug, name, expected_interval_seconds', ['nightly-job', 'Again', 3600]),
      PG.uniqueViolation,
    );
    await rejects(
      insert('slug, name, expected_interval_seconds', ['Bad Slug', 'Bad', 3600]),
      PG.checkViolation,
    );
    await rejects(
      insert('slug, name, expected_interval_seconds', ['too-quick', 'Quick', 29]),
      PG.checkViolation,
    );
    await rejects(
      insert('slug, name, expected_interval_seconds, grace_seconds', [
        'long-grace',
        'Grace',
        60,
        86401,
      ]),
      PG.checkViolation,
    );
    await rejects(
      insert('slug, name, expected_interval_seconds, severity', ['odd-sev', 'Odd', 60, 'unknown']),
      PG.checkViolation,
    );
  });

  it('is missing if and only if it says since when', async () => {
    await insert('slug, name, expected_interval_seconds', ['state-check', 'State', 60]);
    await rejects(
      app.query(`UPDATE heartbeat SET state = 'missing' WHERE slug = 'state-check'`),
      PG.checkViolation,
    );
    await rejects(
      app.query(`UPDATE heartbeat SET missing_since = now() WHERE slug = 'state-check'`),
      PG.checkViolation,
    );
    await app.query(
      `UPDATE heartbeat SET state = 'missing', missing_since = now() WHERE slug = 'state-check'`,
    );
  });

  it('the source of an alert and of its deliveries can be heartbeat', async () => {
    const id = await insertAlert('heartbeat');
    await app.query(
      `INSERT INTO alert_event (alert_id, source, provider_event_id, type) VALUES ($1, 'heartbeat', 'hb-1', 'fired')`,
      [id],
    );
    await rejects(insertAlert('carrier-pigeon'), PG.checkViolation);
  });
});

describe('0043 is reversible', () => {
  it('goes down (dropping heartbeat alerts) and up again', async () => {
    const later = await migrationsAfter('0043_alert_hygiene');
    if (later.length > 0) await migrateDown(owner(), { steps: later.length });
    const reverted = await migrateDown(owner(), { steps: 1 });
    expect(reverted).toEqual(['0043_alert_hygiene']);
    const gone = await owner().query(
      `SELECT 1 FROM information_schema.tables WHERE table_name IN ('heartbeat', 'correlation_rule')`,
    );
    expect(gone.rowCount).toBe(0);
    const heartbeatAlerts = await owner().query(`SELECT 1 FROM alert WHERE source = 'heartbeat'`);
    expect(heartbeatAlerts.rowCount).toBe(0);
    expect(await migrateUp(owner())).toEqual(['0043_alert_hygiene', ...later]);
  });
});
