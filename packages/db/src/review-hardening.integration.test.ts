import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PG, isPgError } from './errors.js';
import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0047 (T-202 security review): a Discord account names one user, and a mass update that is
// sending carries the audience that was confirmed, as a list that agrees with the count.
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

async function user(discordUserId: string | null): Promise<string> {
  counter += 1;
  const result = await owner().query<{ id: string }>(
    `INSERT INTO users (email, name, role, discord_user_id) VALUES ($1, 'Person', 'lead', $2) RETURNING id`,
    [`person-${String(counter)}@example.test`, discordUserId],
  );
  return result.rows[0]?.id ?? '';
}

describe('0047 users.discord_user_id is unique', () => {
  it('two users cannot share a Discord account; any number have none', async () => {
    await user('777000000000000001');
    await rejects(user('777000000000000001'), PG.uniqueViolation);
    await user(null);
    await user(null);
    await user('777000000000000002');
  });
});

describe('0047 incident_comm keeps the confirmed audience', () => {
  async function draft(): Promise<string> {
    const incident = await owner().query<{ id: string }>(
      `INSERT INTO incident (title, severity) VALUES ('Checkout errors', 'SEV2') RETURNING id`,
    );
    const comm = await app.query<{ id: string }>(
      `INSERT INTO incident_comm (incident_id, body, origin) VALUES ($1, 'We are on it', 'ai') RETURNING id`,
      [incident.rows[0]?.id],
    );
    return comm.rows[0]?.id ?? '';
  }

  it('sending needs a list of tickets that is as long as the count confirmed', async () => {
    const id = await draft();
    const person = await user(null);
    const ticketOrg = await owner().query<{ id: string }>(
      `INSERT INTO organization (name) VALUES ('Audience org') RETURNING id`,
    );
    const ticket = await owner().query<{ id: string }>(
      `INSERT INTO ticket (subject, org_id) VALUES ('s', $1) RETURNING id`,
      [ticketOrg.rows[0]?.id],
    );
    const ticketId = ticket.rows[0]?.id;
    const start = (confirmed: number, ids: string) =>
      app.query(
        `UPDATE incident_comm SET status = 'sending', sent_by = $2, confirmed_recipients = $3, recipient_ticket_ids = ${ids} WHERE id = $1`,
        [id, person, confirmed],
      );
    // No list, a list of another length, and a list on a draft are all refused.
    await rejects(
      app.query(
        `UPDATE incident_comm SET status = 'sending', sent_by = $2, confirmed_recipients = 1 WHERE id = $1`,
        [id, person],
      ),
      PG.checkViolation,
    );
    await rejects(start(2, `ARRAY['${ticketId ?? ''}']::uuid[]`), PG.checkViolation);
    await rejects(
      app.query(`UPDATE incident_comm SET recipient_ticket_ids = '{}' WHERE id = $1`, [id]),
      PG.checkViolation,
    );
    await start(1, `ARRAY['${ticketId ?? ''}']::uuid[]`);
  });
});

describe('0047 is reversible', () => {
  it('goes down and up again', async () => {
    const later = await migrationsAfter('0047_review_hardening');
    if (later.length > 0) await migrateDown(owner(), { steps: later.length });
    expect(await migrateDown(owner(), { steps: 1 })).toEqual(['0047_review_hardening']);
    const column = await owner().query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'incident_comm' AND column_name = 'recipient_ticket_ids'`,
    );
    expect(column.rowCount).toBe(0);
    expect(await migrateUp(owner())).toEqual(['0047_review_hardening', ...later]);
  });
});
