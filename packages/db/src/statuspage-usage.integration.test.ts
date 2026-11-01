import { createHash } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PG, isPgError } from './errors.js';
import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migrations 0060 to 0063 (T-204a, T-205a, T-205c, T-205d). The constraints are the database's half of N3
// (only a person publishes) and of the metric rules (declared dimensions, hourly points, one row per series).
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
let app: Pool;
const owner = (): Pool => testDb.owner.pool;
let personId = '';
let orgId = '';
let metricId = '';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
  const person = await owner().query<{ id: string }>(
    `INSERT INTO users (email, name, role) VALUES ('lead@example.test', 'Lead', 'lead') RETURNING id`,
  );
  personId = person.rows[0]?.id ?? '';
  const org = await owner().query<{ id: string }>(
    `INSERT INTO organization (name) VALUES ('Metric org') RETURNING id`,
  );
  orgId = org.rows[0]?.id ?? '';
  const metric = await app.query<{ id: string }>(
    `INSERT INTO usage_metric_def (key, name, sql_template, dims) VALUES ('tx_per_hour', 'Transactions', 'SELECT 1', ARRAY['org'])
     RETURNING id`,
  );
  metricId = metric.rows[0]?.id ?? '';
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

const draftPost = async (origin: string): Promise<string> =>
  (
    await app.query<{ id: string }>(
      `INSERT INTO status_post (title, body, origin) VALUES ('Investigating', 'We are looking into it', $1) RETURNING id`,
      [origin],
    )
  ).rows[0]?.id ?? '';

describe('0060 status_post (N3)', () => {
  it('a post is not public without the person who published it, whoever drafted it', async () => {
    const id = await draftPost('ai');
    for (const sql of [
      `UPDATE status_post SET state = 'published' WHERE id = $1`,
      `UPDATE status_post SET state = 'published', published_at = now() WHERE id = $1`,
      `UPDATE status_post SET state = 'published', published_by = '${personId}' WHERE id = $1`,
      `UPDATE status_post SET published_by = '${personId}', published_at = now() WHERE id = $1`,
    ]) {
      await rejects(app.query(sql, [id]), PG.checkViolation);
    }
    await app.query(
      `UPDATE status_post SET state = 'published', published_by = $2, published_at = now() WHERE id = $1`,
      [id, personId],
    );
  });

  it('only knows its phases, impacts, states and origins', async () => {
    const id = await draftPost('human');
    for (const sql of [
      `UPDATE status_post SET phase = 'fixing' WHERE id = $1`,
      `UPDATE status_post SET impact = 'huge' WHERE id = $1`,
      `UPDATE status_post SET state = 'archived' WHERE id = $1`,
      `UPDATE status_post SET body = '  ' WHERE id = $1`,
    ]) {
      await rejects(app.query(sql, [id]), PG.checkViolation);
    }
    await rejects(draftPost('robot'), PG.checkViolation);
  });
});

describe('0060 status_maintenance (N3)', () => {
  const insert = (state: string, publishedBy: string | null, endsInMinutes = 60) =>
    app.query(
      `INSERT INTO status_maintenance (title, body, starts_at, ends_at, state, origin, published_by, published_at, cancelled_at)
       VALUES ('Database upgrade', 'Short break', now(), now() + make_interval(mins => $3::int), $1, 'ai', $2::uuid,
               CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END, CASE WHEN $1 = 'cancelled' THEN now() END)`,
      [state, publishedBy, endsInMinutes],
    );

  it('a published window has a person; a window cannot end before it starts', async () => {
    await rejects(insert('published', null), PG.checkViolation);
    await insert('published', personId);
    await insert('draft', null);
    await insert('cancelled', null);
    await rejects(insert('draft', null, -5), PG.checkViolation);
  });
});

describe('0060 status_subscription', () => {
  const nonce = '0123456789abcdef';
  const insert = (email: string, state = 'pending') =>
    app.query(
      `INSERT INTO status_subscription (email, state, confirm_nonce, unsubscribe_nonce, confirmed_at, unsubscribed_at)
       VALUES ($1, $2, $3, $3, CASE WHEN $2 = 'confirmed' THEN now() END, CASE WHEN $2 = 'unsubscribed' THEN now() END)`,
      [email, state, nonce],
    );

  it('keeps one lower-case address once, and a confirmed one has its time', async () => {
    await insert('reader@example.test');
    await rejects(insert('reader@example.test'), PG.uniqueViolation);
    await rejects(insert('Upper@example.test'), PG.checkViolation);
    await rejects(insert('not-an-address'), PG.checkViolation);
    await insert('second@example.test', 'confirmed');
    await rejects(
      app.query(
        `INSERT INTO status_subscription (email, state, confirm_nonce, unsubscribe_nonce) VALUES ('third@example.test', 'confirmed', $1, $1)`,
        [nonce],
      ),
      PG.checkViolation,
    );
  });
});

describe('0061 usage_metric_def', () => {
  const define = (key: string, dims: string[], extra = '') =>
    app.query(
      `INSERT INTO usage_metric_def (key, name, sql_template, dims${extra === '' ? '' : ', ' + extra.split('=')[0]}) VALUES ($1, 'm', 'SELECT 1', $2${extra === '' ? '' : ', ' + extra.split('=')[1]})`,
      [key, dims],
    );

  it('accepts declared dimensions only: lower snake case, distinct, at most six, never ts or value', async () => {
    await define('ok_one', ['org', 'flow', 'step']);
    for (const dims of [
      ['value'],
      ['ts'],
      ['Flow'],
      ['a', 'a'],
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      ['1abc'],
    ]) {
      await rejects(define(`bad_${dims.join('_').toLowerCase()}`, dims), PG.checkViolation);
    }
  });

  it('keeps the refresh interval, the rule and the key within bounds', async () => {
    await rejects(define('Bad Key', []), PG.checkViolation);
    await rejects(define('fast_one', [], 'refresh_interval_seconds=10'), PG.checkViolation);
    await rejects(define('flat_ratio', [], 'anomaly_ratio=1'), PG.checkViolation);
    await rejects(define('wrong_way', [], `direction='sideways'`), PG.checkViolation);
    await rejects(define('ok_one', []), PG.uniqueViolation);
  });
});

describe('0061 usage_metric_point', () => {
  const point = (ts: string, dims: string, value: number | string = 5) =>
    app.query(
      `INSERT INTO usage_metric_point (metric_id, ts, dims_hash, org_id, value) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (metric_id, ts, dims_hash) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp()`,
      [metricId, ts, hash(dims), orgId, value],
    );

  it('is partitioned by month, with the current month and a year ahead ready', async () => {
    const parts = await owner().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'usage_metric_point'::regclass`,
    );
    expect(parts.rows[0]?.n).toBeGreaterThanOrEqual(13);
  });

  it('holds one row per metric, hour and dimension set, and a repeated write replaces the value', async () => {
    await point('2030-05-01T10:00:00Z', 'a', 5);
    await point('2030-05-01T10:00:00Z', 'a', 9);
    await point('2030-05-01T10:00:00Z', 'b', 1);
    const rows = await app.query<{ value: number }>(
      `SELECT value FROM usage_metric_point WHERE metric_id = $1 AND ts = '2030-05-01T10:00:00Z' ORDER BY value`,
      [metricId],
    );
    expect(rows.rows.map((row) => row.value)).toEqual([1, 9]);
  });

  it('refuses a point that is not on the hour, not finite, or has a malformed hash', async () => {
    await rejects(point('2030-05-01T10:30:00Z', 'c'), PG.checkViolation);
    await rejects(point('2030-05-01T11:00:00Z', 'c', 'NaN'), PG.checkViolation);
    await rejects(
      app.query(
        `INSERT INTO usage_metric_point (metric_id, ts, dims_hash, value) VALUES ($1, '2030-05-01T11:00:00Z', 'short', 1)`,
        [metricId],
      ),
      PG.checkViolation,
    );
  });

  it('can be written by the application role and its rows are removed with the metric', async () => {
    const extra = await app.query<{ id: string }>(
      `INSERT INTO usage_metric_def (key, name, sql_template) VALUES ('short_lived', 'x', 'SELECT 1') RETURNING id`,
    );
    const id = extra.rows[0]?.id;
    await app.query(
      `INSERT INTO usage_metric_point (metric_id, ts, dims_hash, value) VALUES ($1, '2030-05-01T12:00:00Z', $2, 1)`,
      [id, hash('x')],
    );
    await app.query(`DELETE FROM usage_metric_def WHERE id = $1`, [id]);
    const left = await owner().query(`SELECT 1 FROM usage_metric_point WHERE metric_id = $1`, [id]);
    expect(left.rowCount).toBe(0);
  });
});

describe('0062 usage_anomaly', () => {
  const insert = (key: string, samples = 5) =>
    app.query(
      `INSERT INTO usage_anomaly (metric_id, dims_hash, bucket_ts, observed, baseline, baseline_samples, dedupe_key)
       VALUES ($1, $2, '2030-05-01T10:00:00Z', 100, 10, $3, $4)`,
      [metricId, hash('series'), samples, key],
    );

  it('names one anomaly per dedupe key, and the alert sources know usage_anomaly', async () => {
    await insert('k1');
    await rejects(insert('k1'), PG.uniqueViolation);
    await rejects(insert('k2', 0), PG.checkViolation);
    await app.query(
      `INSERT INTO alert (fingerprint, source, title) VALUES ($1, 'usage_anomaly', 'Usage anomaly')`,
      [hash('alert')],
    );
    await rejects(
      app.query(`INSERT INTO alert (fingerprint, source, title) VALUES ($1, 'carrier_pigeon', 'x')`, [
        hash('other'),
      ]),
      PG.checkViolation,
    );
  });
});

describe('0063 org_health_snapshot', () => {
  const insert = (status: string, score: number | null, day = '2030-05-01') =>
    app.query(
      `INSERT INTO org_health_snapshot (org_id, day, formula_version, status, score, components) VALUES ($1, $2, 1, $3, $4, '{}')`,
      [orgId, day, status, score],
    );

  it('has a score exactly when it was scored, within 0 to 100, once per day and formula version', async () => {
    await rejects(insert('scored', null), PG.checkViolation);
    await rejects(insert('insufficient_data', 50), PG.checkViolation);
    await rejects(insert('scored', 101), PG.checkViolation);
    await insert('insufficient_data', null);
    await insert('scored', 72, '2030-05-02');
    await rejects(insert('scored', 72, '2030-05-02'), PG.uniqueViolation);
    await app.query(
      `INSERT INTO org_health_snapshot (org_id, day, formula_version, status, score, components) VALUES ($1, '2030-05-02', 2, 'scored', 60, '{}')`,
      [orgId],
    );
  });
});

describe('0060 to 0063 are reversible', () => {
  it('go down and up again', async () => {
    const later = await migrationsAfter('0063_org_health_snapshot');
    if (later.length > 0) await migrateDown(owner(), { steps: later.length });
    expect(await migrateDown(owner(), { steps: 4 })).toEqual([
      '0063_org_health_snapshot',
      '0062_usage_anomaly',
      '0061_usage_metrics',
      '0060_status_page',
    ]);
    const gone = await owner().query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_name IN ('status_post', 'status_subscription', 'usage_metric_def', 'usage_metric_point', 'usage_anomaly', 'org_health_snapshot')`,
    );
    expect(gone.rowCount).toBe(0);
    // The alert source CHECK is back to the narrower list.
    await rejects(
      owner().query(`INSERT INTO alert (fingerprint, source, title) VALUES ($1, 'usage_anomaly', 'x')`, [
        hash('after-down'),
      ]),
      PG.checkViolation,
    );
    expect(await migrateUp(owner())).toEqual([
      '0060_status_page',
      '0061_usage_metrics',
      '0062_usage_anomaly',
      '0063_org_health_snapshot',
      ...later,
    ]);
  });
});
