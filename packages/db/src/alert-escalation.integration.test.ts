import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PG, isPgError } from './errors.js';
import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0042 (T-201d): the escalation log of alerts, who acknowledged and through what, and the
// two alert notification kinds. The constraints are what keep a step recorded once, a fake chat post
// from passing for a real one, and the application from rewriting who was told.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

/** SQLSTATE 42501: the application role has no UPDATE right on that column. */
const INSUFFICIENT_PRIVILEGE = '42501';

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

let counter = 0;
async function insertAlert(): Promise<string> {
  counter += 1;
  const result = await app.query<{ id: string }>(
    `INSERT INTO alert (fingerprint, source, title) VALUES ($1, 'alertmanager', 'High error rate') RETURNING id`,
    [fingerprint(counter)],
  );
  return result.rows[0]?.id ?? '';
}

async function insertUser(): Promise<string> {
  counter += 1;
  const result = await owner().query<{ id: string }>(
    `INSERT INTO users (email, name, role) VALUES ($1, 'Person', 'lead') RETURNING id`,
    [`person-${String(counter)}@example.test`],
  );
  return result.rows[0]?.id ?? '';
}

async function insertStep(alertId: string, level: number, extra = ''): Promise<void> {
  await app.query(
    `INSERT INTO alert_escalation (alert_id, level, target) VALUES ($1, $2, 'lead') ${extra}`,
    [alertId, level],
  );
}

describe('0042 alert_escalation', () => {
  it('records a step once per alert and level', async () => {
    const alertId = await insertAlert();
    await insertStep(alertId, 0);
    await insertStep(alertId, 1);
    await rejects(insertStep(alertId, 0), PG.uniqueViolation);
  });

  it('keeps the recipient count equal to the recipient list', async () => {
    const alertId = await insertAlert();
    const person = await insertUser();
    await app.query(
      `INSERT INTO alert_escalation (alert_id, level, target, recipient_ids, recipient_count)
       VALUES ($1, 0, 'on_shift', ARRAY[$2]::uuid[], 1)`,
      [alertId, person],
    );
    await rejects(
      app.query(
        `INSERT INTO alert_escalation (alert_id, level, target, recipient_ids, recipient_count)
         VALUES ($1, 1, 'lead', ARRAY[$2]::uuid[], 2)`,
        [alertId, person],
      ),
      PG.checkViolation,
    );
  });

  it('refuses an unknown target, an unknown fallback and a level out of range', async () => {
    const alertId = await insertAlert();
    await rejects(
      app.query(`INSERT INTO alert_escalation (alert_id, level, target) VALUES ($1, 0, 'ceo')`, [
        alertId,
      ]),
      PG.checkViolation,
    );
    await rejects(
      app.query(
        `INSERT INTO alert_escalation (alert_id, level, target, fallback) VALUES ($1, 0, 'lead', 'head')`,
        [alertId],
      ),
      PG.checkViolation,
    );
    await rejects(insertStep(alertId, 11), PG.checkViolation);
  });

  it('a chat post is claimed before it is made, and only a real post is `sent`', async () => {
    const alertId = await insertAlert();
    await insertStep(alertId, 0);
    // `sending` without a claim time, and a claim time without `sending`, are both refused.
    await rejects(
      app.query(`UPDATE alert_escalation SET chat_state = 'sending' WHERE alert_id = $1`, [
        alertId,
      ]),
      PG.checkViolation,
    );
    await rejects(
      app.query(`UPDATE alert_escalation SET chat_claimed_at = now() WHERE alert_id = $1`, [
        alertId,
      ]),
      PG.checkViolation,
    );
    await app.query(
      `UPDATE alert_escalation SET chat_state = 'sending', chat_claimed_at = now() WHERE alert_id = $1`,
      [alertId],
    );
    // `sent` needs a delivery time; a mock post can have neither a delivery time nor a message id.
    await rejects(
      app.query(
        `UPDATE alert_escalation SET chat_state = 'sent', chat_claimed_at = NULL WHERE alert_id = $1`,
        [alertId],
      ),
      PG.checkViolation,
    );
    await rejects(
      app.query(
        `UPDATE alert_escalation
            SET chat_state = 'mock', chat_claimed_at = NULL, chat_message_id = '123', chat_sent_at = now()
          WHERE alert_id = $1`,
        [alertId],
      ),
      PG.checkViolation,
    );
    await app.query(
      `UPDATE alert_escalation
          SET chat_state = 'sent', chat_claimed_at = NULL, chat_message_id = '123', chat_sent_at = now()
        WHERE alert_id = $1`,
      [alertId],
    );
  });

  it('a failed or skipped post says why', async () => {
    const alertId = await insertAlert();
    await insertStep(alertId, 0);
    await rejects(
      app.query(`UPDATE alert_escalation SET chat_state = 'failed' WHERE alert_id = $1`, [alertId]),
      PG.checkViolation,
    );
    await app.query(
      `UPDATE alert_escalation SET chat_state = 'skipped', chat_error_code = 'no_channel' WHERE alert_id = $1`,
      [alertId],
    );
  });

  it('the application can record the outcome of the chat post but not rewrite who was told', async () => {
    const alertId = await insertAlert();
    await insertStep(alertId, 0);
    await rejects(
      app.query(`UPDATE alert_escalation SET target = 'head' WHERE alert_id = $1`, [alertId]),
      INSUFFICIENT_PRIVILEGE,
    );
    await rejects(
      app.query(`UPDATE alert_escalation SET recipient_ids = '{}' WHERE alert_id = $1`, [alertId]),
      INSUFFICIENT_PRIVILEGE,
    );
    await app.query(`UPDATE alert_escalation SET chat_attempts = 1 WHERE alert_id = $1`, [alertId]);
  });

  it('goes with its alert', async () => {
    const alertId = await insertAlert();
    await insertStep(alertId, 0);
    await app.query(`DELETE FROM alert WHERE id = $1`, [alertId]);
    const left = await owner().query(`SELECT 1 FROM alert_escalation WHERE alert_id = $1`, [
      alertId,
    ]);
    expect(left.rowCount).toBe(0);
  });
});

describe('0042 acknowledgment channel', () => {
  it('knows web and Discord, and has one only once acknowledged', async () => {
    const alertId = await insertAlert();
    await rejects(
      app.query(`UPDATE alert SET acked_via = 'web' WHERE id = $1`, [alertId]),
      PG.checkViolation,
    );
    await rejects(
      app.query(
        `UPDATE alert SET state = 'acknowledged', acked_at = now(), acked_via = 'carrier pigeon' WHERE id = $1`,
        [alertId],
      ),
      PG.checkViolation,
    );
    await app.query(
      `UPDATE alert SET state = 'acknowledged', acked_at = now(), acked_via = 'discord' WHERE id = $1`,
      [alertId],
    );
  });
});

describe('0042 notification kinds', () => {
  it('accepts the two alert kinds for notifications and preferences, still refuses others', async () => {
    const person = await insertUser();
    for (const kind of ['alert.fired', 'alert.escalated']) {
      await app.query(
        `INSERT INTO notification (user_id, kind, severity, dedupe_key) VALUES ($1, $2, 'high', $2)`,
        [person, kind],
      );
      await app.query(
        `INSERT INTO notification_preference (user_id, kind, in_app) VALUES ($1, $2, false)`,
        [person, kind],
      );
    }
    await rejects(
      app.query(
        `INSERT INTO notification (user_id, kind, severity, dedupe_key) VALUES ($1, 'alert.exploded', 'high', 'x')`,
        [person],
      ),
      PG.checkViolation,
    );
  });
});

describe('0042 is reversible', () => {
  it('goes down (dropping the log and the alert kinds) and up again', async () => {
    const later = await migrationsAfter('0042_alert_escalation');
    if (later.length > 0) await migrateDown(owner(), { steps: later.length });
    const reverted = await migrateDown(owner(), { steps: 1 });
    expect(reverted).toEqual(['0042_alert_escalation']);
    const gone = await owner().query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'alert_escalation'`,
    );
    expect(gone.rowCount).toBe(0);
    const kinds = await owner().query(`SELECT 1 FROM notification WHERE kind LIKE 'alert.%'`);
    expect(kinds.rowCount).toBe(0);
    expect(await migrateUp(owner())).toEqual(['0042_alert_escalation', ...later]);
  });
});
