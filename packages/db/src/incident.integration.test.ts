import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PG, isPgError } from './errors.js';
import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0044 (T-202a): incidents, the append-only timeline, the deploy feed, and the foreign keys
// that tie tickets and alerts to an incident.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
/** SQLSTATE 23001, restrict_violation: what the append-only trigger raises (reject_mutation, migration 0001). */
const APPEND_ONLY = '23001';
/** SQLSTATE 42501: the application role has no UPDATE or DELETE right on the table. */
const NO_PRIVILEGE = '42501';

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

async function insertIncident(extra = ''): Promise<{ id: string; number: number }> {
  const result = await app.query<{ id: string; number: number }>(
    `INSERT INTO incident (title, severity) VALUES ('Checkout errors', 'SEV2') ${extra} RETURNING id, number`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('no incident');
  return row;
}

describe('0044 incident', () => {
  it('numbers incidents by itself and never repeats a number', async () => {
    const first = await insertIncident();
    const second = await insertIncident();
    expect(second.number).toBeGreaterThan(first.number);
    await rejects(
      app.query(`INSERT INTO incident (number, title, severity) VALUES (1, 'x', 'SEV1')`),
      '428C9',
    );
  });

  it('knows four severities and four statuses, and `resolved` and `resolved_at` go together', async () => {
    const { id } = await insertIncident();
    await rejects(
      app.query(`UPDATE incident SET severity = 'SEV5' WHERE id = $1`, [id]),
      PG.checkViolation,
    );
    await rejects(
      app.query(`UPDATE incident SET status = 'closed' WHERE id = $1`, [id]),
      PG.checkViolation,
    );
    await rejects(
      app.query(`UPDATE incident SET status = 'resolved' WHERE id = $1`, [id]),
      PG.checkViolation,
    );
    await rejects(
      app.query(`UPDATE incident SET resolved_at = now() WHERE id = $1`, [id]),
      PG.checkViolation,
    );
    await app.query(`UPDATE incident SET status = 'resolved', resolved_at = now() WHERE id = $1`, [
      id,
    ]);
  });

  it('a mock thread never carries ids; only a created one does', async () => {
    const { id } = await insertIncident();
    await rejects(
      app.query(
        `UPDATE incident SET discord_thread_state = 'mock', discord_thread_id = '1', discord_channel_id = '2' WHERE id = $1`,
        [id],
      ),
      PG.checkViolation,
    );
    await app.query(`UPDATE incident SET discord_thread_state = 'mock' WHERE id = $1`, [id]);
    await app.query(
      `UPDATE incident SET discord_thread_state = 'created', discord_thread_id = '1', discord_channel_id = '2' WHERE id = $1`,
      [id],
    );
  });
});

describe('0044 incident_timeline', () => {
  it('is partitioned by month with the partitions ready, and keeps its entries for ever', async () => {
    const { id } = await insertIncident();
    await app.query(
      `INSERT INTO incident_timeline (incident_id, type, actor_type) VALUES ($1, 'created', 'user')`,
      [id],
    );
    const partitions = await owner().query<{ relname: string }>(
      `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'incident_timeline'::regclass`,
    );
    expect(partitions.rowCount).toBeGreaterThan(3);
    await rejects(
      app.query(`UPDATE incident_timeline SET type = 'note' WHERE incident_id = $1`, [id]),
      NO_PRIVILEGE,
    );
    await rejects(
      app.query(`DELETE FROM incident_timeline WHERE incident_id = $1`, [id]),
      NO_PRIVILEGE,
    );
    // Not even the owner can rewrite it: the trigger refuses.
    await rejects(
      owner().query(`UPDATE incident_timeline SET type = 'note' WHERE incident_id = $1`, [id]),
      APPEND_ONLY,
    );
  });

  it('only knows the declared types and actor types, with an object payload', async () => {
    const { id } = await insertIncident();
    const insert = (type: string, actor: string, payload = '{}') =>
      app.query(
        `INSERT INTO incident_timeline (incident_id, type, actor_type, payload) VALUES ($1, $2, $3, $4::jsonb)`,
        [id, type, actor, payload],
      );
    await rejects(insert('exploded', 'user'), PG.checkViolation);
    await rejects(insert('note', 'robot'), PG.checkViolation);
    await rejects(insert('note', 'user', '[]'), PG.checkViolation);
    await insert('note', 'ai');
  });

  it('an incident with a timeline cannot be deleted', async () => {
    const { id } = await insertIncident();
    await app.query(
      `INSERT INTO incident_timeline (incident_id, type, actor_type) VALUES ($1, 'created', 'system')`,
      [id],
    );
    await rejects(app.query(`DELETE FROM incident WHERE id = $1`, [id]), PG.foreignKeyViolation);
  });
});

describe('0044 deploy', () => {
  const insert = (externalId: string, extra: [string, unknown][] = []) => {
    const overridden = new Set(extra.map(([column]) => column));
    const base: [string, unknown][] = [
      ['service_slug', 'checkout'],
      ['version', '1.2.3'],
      ['env', 'production'],
      ['source', 'ci'],
      ['external_id', externalId],
    ];
    const all = [...base.filter(([column]) => !overridden.has(column)), ...extra];
    const columns = all.map(([column]) => column);
    const values = all.map(([, value]) => value);
    return app.query(
      `INSERT INTO deploy (${columns.join(', ')}) VALUES (${values.map((_, i) => `$${String(i + 1)}`).join(', ')})`,
      values,
    );
  };

  it('one row per source and external id; sources and times are checked', async () => {
    counter += 1;
    const id = `run-${String(counter)}`;
    await insert(id);
    await rejects(insert(id), PG.uniqueViolation);
    await rejects(insert(`${id}-b`, [['source', 'svn']]), PG.checkViolation);
    await rejects(
      insert(`${id}-c`, [
        ['started_at', '2026-11-02T04:00:00Z'],
        ['finished_at', '2026-11-02T03:00:00Z'],
      ]),
      PG.checkViolation,
    );
    await rejects(insert(`${id}-d`, [['url', 'ftp://example.invalid']]), PG.checkViolation);
  });

  it('`occurred_at` is when it finished, else started, else when we heard', async () => {
    counter += 1;
    await insert(`run-${String(counter)}-a`, [['finished_at', '2026-11-02T03:00:00Z']]);
    await insert(`run-${String(counter)}-b`, [['started_at', '2026-11-02T02:00:00Z']]);
    await insert(`run-${String(counter)}-c`);
    const rows = await owner().query<{ external_id: string; occurred_at: Date; received_at: Date }>(
      `SELECT external_id, occurred_at, received_at FROM deploy WHERE external_id LIKE $1 ORDER BY external_id`,
      [`run-${String(counter)}-%`],
    );
    expect(rows.rows[0]?.occurred_at.toISOString()).toBe('2026-11-02T03:00:00.000Z');
    expect(rows.rows[1]?.occurred_at.toISOString()).toBe('2026-11-02T02:00:00.000Z');
    expect(rows.rows[2]?.occurred_at.getTime()).toBe(rows.rows[2]?.received_at.getTime());
  });
});

describe('0044 links from tickets and alerts', () => {
  it('a ticket and an alert can point at an incident, and lose the link when it goes', async () => {
    const { id } = await insertIncident();
    const org = await owner().query<{ id: string }>(
      `INSERT INTO organization (name) VALUES ('Linked org') RETURNING id`,
    );
    const ticket = await owner().query<{ id: string }>(
      `INSERT INTO ticket (subject, org_id, incident_id) VALUES ('s', $1, $2) RETURNING id`,
      [org.rows[0]?.id, id],
    );
    counter += 1;
    const alert = await owner().query<{ id: string }>(
      `INSERT INTO alert (fingerprint, source, title, incident_id) VALUES ($1, 'alertmanager', 'a', $2) RETURNING id`,
      [counter.toString(16).padStart(64, '0'), id],
    );
    await rejects(
      owner().query(
        `INSERT INTO ticket (subject, org_id, incident_id) VALUES ('s', $1, gen_random_uuid())`,
        [org.rows[0]?.id],
      ),
      PG.foreignKeyViolation,
    );
    await owner().query(`DELETE FROM incident WHERE id = $1`, [id]);
    const after = await owner().query<{ incident_id: string | null }>(
      `SELECT incident_id FROM ticket WHERE id = $1 UNION ALL SELECT incident_id FROM alert WHERE id = $2`,
      [ticket.rows[0]?.id, alert.rows[0]?.id],
    );
    expect(after.rows.map((row) => row.incident_id)).toEqual([null, null]);
  });
});

describe('0044 is reversible', () => {
  it('goes down (unlinking tickets and alerts) and up again', async () => {
    const later = await migrationsAfter('0044_incident');
    if (later.length > 0) await migrateDown(owner(), { steps: later.length });
    const reverted = await migrateDown(owner(), { steps: 1 });
    expect(reverted).toEqual(['0044_incident']);
    const gone = await owner().query(
      `SELECT 1 FROM information_schema.tables WHERE table_name IN ('incident', 'incident_timeline', 'deploy')`,
    );
    expect(gone.rowCount).toBe(0);
    expect(await migrateUp(owner())).toEqual(['0044_incident', ...later]);
  });
});
