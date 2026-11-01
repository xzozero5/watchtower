import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PG, isPgError } from './errors.js';
import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0046 (T-202c): mass communication. The constraints are the database's half of N3: whoever
// drafted an update, it cannot be sending or sent without a person and the recipient count they confirmed.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
let app: Pool;
const owner = (): Pool => testDb.owner.pool;
let personId = '';
let incidentId = '';

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
  const person = await owner().query<{ id: string }>(
    `INSERT INTO users (email, name, role) VALUES ('lead@example.test', 'Lead', 'lead') RETURNING id`,
  );
  personId = person.rows[0]?.id ?? '';
  const incident = await owner().query<{ id: string }>(
    `INSERT INTO incident (title, severity) VALUES ('Checkout errors', 'SEV2') RETURNING id`,
  );
  incidentId = incident.rows[0]?.id ?? '';
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

async function draft(origin = 'ai'): Promise<string> {
  const result = await app.query<{ id: string }>(
    `INSERT INTO incident_comm (incident_id, body, origin) VALUES ($1, 'We are on it', $2) RETURNING id`,
    [incidentId, origin],
  );
  return result.rows[0]?.id ?? '';
}

describe('0046 incident_comm (N3)', () => {
  it('an AI draft cannot be sending or sent without a person and a confirmed count', async () => {
    const id = await draft('ai');
    for (const sql of [
      `UPDATE incident_comm SET status = 'sending' WHERE id = $1`,
      `UPDATE incident_comm SET status = 'sending', confirmed_recipients = 3 WHERE id = $1`,
      `UPDATE incident_comm SET status = 'sending', sent_by = '${personId}' WHERE id = $1`,
      `UPDATE incident_comm SET status = 'sent', sent_at = now() WHERE id = $1`,
    ]) {
      await rejects(app.query(sql, [id]), PG.checkViolation);
    }
    await app.query(
      `UPDATE incident_comm SET status = 'sending', sent_by = $2, confirmed_recipients = 0, recipient_ticket_ids = '{}' WHERE id = $1`,
      [id, personId],
    );
    await app.query(`UPDATE incident_comm SET status = 'sent', sent_at = now() WHERE id = $1`, [
      id,
    ]);
  });

  it('a draft carries neither a sender nor a count, and only knows its statuses and origins', async () => {
    const id = await draft('human');
    await rejects(
      app.query(`UPDATE incident_comm SET sent_by = $2 WHERE id = $1`, [id, personId]),
      PG.checkViolation,
    );
    await rejects(
      app.query(`UPDATE incident_comm SET status = 'posted' WHERE id = $1`, [id]),
      PG.checkViolation,
    );
    await rejects(draft('robot'), PG.checkViolation);
    await rejects(
      app.query(
        `INSERT INTO incident_comm (incident_id, body, origin) VALUES ($1, '  ', 'human')`,
        [incidentId],
      ),
      PG.checkViolation,
    );
  });

  it('`sent_at` goes with `sent` and nothing else', async () => {
    const id = await draft('human');
    await rejects(
      app.query(`UPDATE incident_comm SET sent_at = now() WHERE id = $1`, [id]),
      PG.checkViolation,
    );
  });
});

describe('0046 incident_comm_delivery', () => {
  it('records a ticket once per update, and a failure says why', async () => {
    const org = await owner().query<{ id: string }>(
      `INSERT INTO organization (name) VALUES ('Comm org') RETURNING id`,
    );
    const ticket = await owner().query<{ id: string }>(
      `INSERT INTO ticket (subject, org_id) VALUES ('s', $1) RETURNING id`,
      [org.rows[0]?.id],
    );
    const ticketId = ticket.rows[0]?.id;
    const commId = await draft('human');
    const insert = (state: string, reason: string | null) =>
      app.query(
        `INSERT INTO incident_comm_delivery (comm_id, ticket_id, state, reason) VALUES ($1, $2, $3, $4)`,
        [commId, ticketId, state, reason],
      );
    await rejects(insert('failed', null), PG.checkViolation);
    await rejects(insert('sent', 'oops'), PG.checkViolation);
    await rejects(insert('maybe', null), PG.checkViolation);
    await insert('sent', null);
    await rejects(insert('sent', null), PG.uniqueViolation);
  });
});

describe('0046 is reversible', () => {
  it('goes down and up again', async () => {
    const later = await migrationsAfter('0046_incident_comm');
    if (later.length > 0) await migrateDown(owner(), { steps: later.length });
    expect(await migrateDown(owner(), { steps: 1 })).toEqual(['0046_incident_comm']);
    const gone = await owner().query(
      `SELECT 1 FROM information_schema.tables WHERE table_name IN ('incident_comm', 'incident_comm_delivery')`,
    );
    expect(gone.rowCount).toBe(0);
    expect(await migrateUp(owner())).toEqual(['0046_incident_comm', ...later]);
  });
});
