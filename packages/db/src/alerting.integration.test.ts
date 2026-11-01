import {
  DEFAULT_ESCALATION_STEPS,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  ROLES,
} from '@watchtower/shared';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PG, isPgError } from './errors.js';
import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migrations 0040 (Phase 2 permissions, the internal ticket channel) and 0041 (alerts, the service
// catalog, escalation policies; T-200/T-201b). The constraints below are what keep one open alert per
// fingerprint, one row per provider delivery, and a resolved alert consistent.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const PHASE_2 = [
  'alert.read',
  'alert.ack',
  'alert.manage',
  'service.manage',
  'investigate.adhoc',
  'metric.read',
  'metric.manage',
  'org.health.read',
  'dashboard.ops.read',
] as const;

let testDb: TestDatabase;
let app: Pool;
const owner = (): Pool => testDb.owner.pool;
const fingerprint = (n: number): string => n.toString(16).padStart(64, '0');

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

async function insertAlert(n: number, state = 'open'): Promise<string> {
  const result =
    state === 'resolved'
      ? await app.query<{ id: string }>(
          `INSERT INTO alert (fingerprint, source, title, state, resolved_at)
           VALUES ($1, 'alertmanager', 'High error rate', 'resolved', now()) RETURNING id`,
          [fingerprint(n)],
        )
      : await app.query<{ id: string }>(
          `INSERT INTO alert (fingerprint, source, title, state)
           VALUES ($1, 'alertmanager', 'High error rate', $2) RETURNING id`,
          [fingerprint(n), state],
        );
  return result.rows[0]?.id ?? '';
}

describe('0040 Phase 2 permissions', () => {
  it('seeds the permission strings with the descriptions of the shared vocabulary', async () => {
    const rows = await owner().query<{ key: string; description: string }>(
      'SELECT key, description FROM permissions WHERE key = ANY($1)',
      [PHASE_2],
    );
    expect(Object.fromEntries(rows.rows.map((row) => [row.key, row.description]))).toEqual(
      Object.fromEntries(PHASE_2.map((key) => [key, PERMISSIONS[key]])),
    );
  });

  it('grants exactly what the shared defaults say, to nobody else', async () => {
    const rows = await owner().query<{ role: string; permission: string }>(
      'SELECT role, permission FROM role_permissions WHERE permission = ANY($1)',
      [PHASE_2],
    );
    const expected = ROLES.flatMap((role) =>
      DEFAULT_ROLE_PERMISSIONS[role]
        .filter((permission) => (PHASE_2 as readonly string[]).includes(permission))
        .map((permission) => `${role}:${permission}`),
    ).toSorted();
    expect(rows.rows.map((row) => `${row.role}:${row.permission}`).toSorted()).toEqual(expected);
    expect(expected.some((grant) => grant.startsWith('client:'))).toBe(false);
    expect(expected.some((grant) => grant.startsWith('system:'))).toBe(false);
  });
});

describe('0040 internal ticket channel', () => {
  async function ticketWith(channel: string): Promise<void> {
    const org = await owner().query<{ id: string }>(
      `INSERT INTO organization (name) VALUES ($1) RETURNING id`,
      [`Org ${channel}`],
    );
    await owner().query(`INSERT INTO ticket (subject, org_id, channel) VALUES ('s', $1, $2)`, [
      org.rows[0]?.id,
      channel,
    ]);
  }

  it('accepts internal on a ticket, still refuses an unknown channel', async () => {
    await ticketWith('internal');
    await rejects(ticketWith('sms'), PG.checkViolation);
  });

  it('does not accept internal on a channel account: nothing is delivered on it', async () => {
    await rejects(
      owner().query(`INSERT INTO channel_account (type, name) VALUES ('internal', 'x')`),
      PG.checkViolation,
    );
  });
});

describe('0041 escalation policy and service catalog', () => {
  it('seeds one default policy with the documented steps', async () => {
    const rows = await owner().query<{ steps: unknown; is_default: boolean }>(
      'SELECT steps, is_default FROM escalation_policy',
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.is_default).toBe(true);
    expect(rows.rows[0]?.steps).toEqual(DEFAULT_ESCALATION_STEPS);
  });

  it('allows one default policy only and one policy per name (case-insensitive)', async () => {
    await rejects(
      app.query(
        `INSERT INTO escalation_policy (name, steps, is_default) VALUES ('Other', '[{}]', true)`,
      ),
      PG.uniqueViolation,
    );
    await rejects(
      app.query(`INSERT INTO escalation_policy (name, steps) VALUES ('default', '[{}]')`),
      PG.uniqueViolation,
    );
    await rejects(
      app.query(`INSERT INTO escalation_policy (name, steps) VALUES ('Empty', '[]')`),
      PG.checkViolation,
    );
  });

  it('keeps slugs unique and well formed, and urls to http(s)', async () => {
    await app.query(`INSERT INTO service (slug, name) VALUES ('checkout', 'Checkout')`);
    await rejects(
      app.query(`INSERT INTO service (slug, name) VALUES ('checkout', 'Again')`),
      PG.uniqueViolation,
    );
    await rejects(
      app.query(`INSERT INTO service (slug, name) VALUES ('Bad Slug', 'x')`),
      PG.checkViolation,
    );
    await rejects(
      app.query(
        `INSERT INTO service (slug, name, runbook_url) VALUES ('rb', 'x', 'javascript:alert(1)')`,
      ),
      PG.checkViolation,
    );
    await rejects(
      app.query(`INSERT INTO service (slug, name, match_rules) VALUES ('mr', 'x', '{}')`),
      PG.checkViolation,
    );
  });

  it('deleting a policy or a service un-maps instead of deleting alerts', async () => {
    const policy = await owner().query<{ id: string }>(
      `INSERT INTO escalation_policy (name, steps) VALUES ('Night', '[{"target":"on_shift","afterSeconds":0}]') RETURNING id`,
    );
    const service = await owner().query<{ id: string }>(
      `INSERT INTO service (slug, name, escalation_policy_id) VALUES ('billing', 'Billing', $1) RETURNING id`,
      [policy.rows[0]?.id],
    );
    await owner().query('DELETE FROM escalation_policy WHERE id = $1', [policy.rows[0]?.id]);
    const after = await owner().query<{ escalation_policy_id: string | null }>(
      'SELECT escalation_policy_id FROM service WHERE id = $1',
      [service.rows[0]?.id],
    );
    expect(after.rows[0]?.escalation_policy_id).toBeNull();

    const alert = await owner().query<{ id: string }>(
      `INSERT INTO alert (fingerprint, source, title, service_id)
       VALUES ($1, 'alertmanager', 'x', $2) RETURNING id`,
      [fingerprint(900), service.rows[0]?.id],
    );
    await owner().query('DELETE FROM service WHERE id = $1', [service.rows[0]?.id]);
    const kept = await owner().query<{ service_id: string | null }>(
      'SELECT service_id FROM alert WHERE id = $1',
      [alert.rows[0]?.id],
    );
    expect(kept.rows[0]?.service_id).toBeNull();
  });
});

describe('0041 alert', () => {
  it('allows one open alert per fingerprint, and a new one after the first is resolved', async () => {
    const first = await insertAlert(1);
    await rejects(insertAlert(1), PG.uniqueViolation);
    // An acknowledged alert is still open.
    await owner().query(`UPDATE alert SET state = 'acknowledged', acked_at = now() WHERE id = $1`, [
      first,
    ]);
    await rejects(insertAlert(1), PG.uniqueViolation);
    await owner().query(`UPDATE alert SET state = 'resolved', resolved_at = now() WHERE id = $1`, [
      first,
    ]);
    await insertAlert(1);
    // Resolved rows pile up as history.
    await insertAlert(2, 'resolved');
    await insertAlert(2, 'resolved');
  });

  it('keeps state, resolved_at and acked_at consistent', async () => {
    await rejects(
      app.query(
        `INSERT INTO alert (fingerprint, source, title, state) VALUES ($1, 'alertmanager', 'x', 'resolved')`,
        [fingerprint(10)],
      ),
      PG.checkViolation,
    );
    await rejects(
      app.query(
        `INSERT INTO alert (fingerprint, source, title, resolved_at) VALUES ($1, 'alertmanager', 'x', now())`,
        [fingerprint(11)],
      ),
      PG.checkViolation,
    );
    await rejects(
      app.query(
        `INSERT INTO alert (fingerprint, source, title, state) VALUES ($1, 'alertmanager', 'x', 'acknowledged')`,
        [fingerprint(12)],
      ),
      PG.checkViolation,
    );
  });

  it('refuses a bad fingerprint, source, severity, state, count and a snooze without a reason', async () => {
    const insert = (columns: string, values: string) =>
      app.query(`INSERT INTO alert (${columns}) VALUES (${values})`);
    await rejects(
      insert('fingerprint, source, title', `'short', 'alertmanager', 'x'`),
      PG.checkViolation,
    );
    await rejects(
      insert('fingerprint, source, title', `'${fingerprint(20)}', 'sms', 'x'`),
      PG.checkViolation,
    );
    await rejects(
      insert(
        'fingerprint, source, title, severity',
        `'${fingerprint(21)}', 'alertmanager', 'x', 'p0'`,
      ),
      PG.checkViolation,
    );
    await rejects(
      insert(
        'fingerprint, source, title, state',
        `'${fingerprint(22)}', 'alertmanager', 'x', 'closed'`,
      ),
      PG.checkViolation,
    );
    await rejects(
      insert('fingerprint, source, title, count', `'${fingerprint(23)}', 'alertmanager', 'x', 0`),
      PG.checkViolation,
    );
    await rejects(
      insert(
        'fingerprint, source, title, snoozed_until',
        `'${fingerprint(24)}', 'alertmanager', 'x', now() + interval '1 hour'`,
      ),
      PG.checkViolation,
    );
    await rejects(
      insert(
        'fingerprint, source, title, payload',
        `'${fingerprint(25)}', 'alertmanager', 'x', '[]'`,
      ),
      PG.checkViolation,
    );
  });

  it('refuses a payload over 16 KB: the application keeps 8 KB, the database is the backstop', async () => {
    await rejects(
      app.query(
        `INSERT INTO alert (fingerprint, source, title, payload)
         VALUES ($1, 'alertmanager', 'x', jsonb_build_object('summary', repeat('x', 20000)))`,
        [fingerprint(30)],
      ),
      PG.checkViolation,
    );
  });
});

describe('0041 alert_event', () => {
  it('is unique per source and provider event id, and goes with its alert', async () => {
    const alertId = await insertAlert(40);
    const insertEvent = (source: string, id: string) =>
      app.query(
        `INSERT INTO alert_event (alert_id, source, provider_event_id, type) VALUES ($1, $2, $3, 'fired')`,
        [alertId, source, id],
      );
    await insertEvent('alertmanager', 'evt-1');
    await rejects(insertEvent('alertmanager', 'evt-1'), PG.uniqueViolation);
    // The same id from another source is another delivery.
    await insertEvent('gcp_monitoring', 'evt-1');
    await rejects(
      app.query(
        `INSERT INTO alert_event (alert_id, source, provider_event_id, type) VALUES ($1, 'alertmanager', 'e2', 'ack')`,
        [alertId],
      ),
      PG.checkViolation,
    );
    await owner().query('DELETE FROM alert WHERE id = $1', [alertId]);
    const left = await owner().query('SELECT 1 FROM alert_event WHERE alert_id = $1', [alertId]);
    expect(left.rowCount).toBe(0);
  });
});

describe('0040 and 0041 are reversible', () => {
  it('go down and up again; down of 0040 refuses while an internal ticket exists', async () => {
    const later = await migrationsAfter('0041_alerting');
    if (later.length > 0) await migrateDown(owner(), { steps: later.length });
    // 0040 cannot be reverted while an internal ticket exists.
    await migrateDown(owner(), { steps: 1 }); // 0041
    await rejects(migrateDown(owner(), { steps: 1 }), 'P0001');
    await owner().query(`DELETE FROM ticket WHERE channel = 'internal'`);
    const reverted = await migrateDown(owner(), { steps: 1 });
    expect(reverted).toEqual(['0040_phase2_permissions']);
    const tables = await owner().query(
      `SELECT 1 FROM information_schema.tables WHERE table_name IN ('alert', 'alert_event', 'service', 'escalation_policy')`,
    );
    expect(tables.rowCount).toBe(0);
    const permissions = await owner().query('SELECT 1 FROM permissions WHERE key = ANY($1)', [
      PHASE_2,
    ]);
    expect(permissions.rowCount).toBe(0);

    expect(await migrateUp(owner())).toEqual([
      '0040_phase2_permissions',
      '0041_alerting',
      ...later,
    ]);
    const again = await owner().query('SELECT 1 FROM permissions WHERE key = ANY($1)', [PHASE_2]);
    expect(again.rowCount).toBe(PHASE_2.length);
  });
});
