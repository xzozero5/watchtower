import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PG, isPgError } from './errors.js';
import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0015 (T-104): the Discord notify ledger. The constraints below are what keep a mock
// recording from ever being read as a delivery, and what stop a second post for the same event.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const INSUFFICIENT_PRIVILEGE = '42501';

let testDb: TestDatabase;
let app: Pool;
let ticketId: string;
const owner = (): Pool => testDb.owner.pool;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
  // The migrations seed the one portal account.
  const account = await owner().query<{ id: string }>(
    `SELECT id FROM channel_account WHERE type = 'portal'`,
  );
  const org = await owner().query<{ id: string }>(
    `INSERT INTO organization (name) VALUES ('Org') RETURNING id`,
  );
  const ticket = await owner().query<{ id: string }>(
    `INSERT INTO ticket (subject, org_id, channel, channel_account_id)
     VALUES ('s', $1, 'portal', $2) RETURNING id`,
    [org.rows[0]?.id, account.rows[0]?.id],
  );
  ticketId = ticket.rows[0]?.id ?? '';
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
const insert = (pool: Pool, columns: string, values: unknown[]) => {
  counter += 1;
  return pool.query<{ id: string }>(
    `INSERT INTO discord_notification (dedupe_key, event, ticket_id, slot, ${columns})
     VALUES ($1, 'ticket.created', $2, 'default', ${values.map((_, i) => `$${String(i + 3)}`).join(', ')})
     RETURNING id`,
    [`k${String(counter)}`, ticketId, ...values],
  );
};

describe('0015 discord_notification', () => {
  it('starts pending and records a post once per dedupe key', async () => {
    const first = await app.query<{ state: string }>(
      `INSERT INTO discord_notification (dedupe_key, event, ticket_id, slot)
       VALUES ('same', 'ticket.created', $1, 'default') RETURNING state`,
      [ticketId],
    );
    expect(first.rows[0]?.state).toBe('pending');
    const again = await app.query(
      `INSERT INTO discord_notification (dedupe_key, event, ticket_id, slot)
       VALUES ('same', 'ticket.created', $1, 'default') ON CONFLICT (dedupe_key) DO NOTHING`,
      [ticketId],
    );
    expect(again.rowCount).toBe(0);
    await rejects(
      app.query(
        `INSERT INTO discord_notification (dedupe_key, event, ticket_id, slot)
         VALUES ('same', 'ticket.created', $1, 'default')`,
        [ticketId],
      ),
      PG.uniqueViolation,
    );
  });

  it('a mock row can never carry a delivery time or a Discord message id', async () => {
    await rejects(insert(app, 'state, sent_at', ['mock', new Date()]), PG.checkViolation);
    await rejects(insert(app, 'state, provider_message_id', ['mock', '123']), PG.checkViolation);
    await insert(app, 'state', ['mock']);
  });

  it('a sent row needs a delivery time, and only a sent row has one', async () => {
    await rejects(insert(app, 'state', ['sent']), PG.checkViolation);
    await rejects(insert(app, 'state, sent_at', ['pending', new Date()]), PG.checkViolation);
    await insert(app, 'state, sent_at, provider_message_id', ['sent', new Date(), '1234']);
  });

  it('a failed or skipped row says why', async () => {
    await rejects(insert(app, 'state', ['failed']), PG.checkViolation);
    await rejects(insert(app, 'state', ['skipped']), PG.checkViolation);
    await insert(app, 'state, error_code', ['failed', 'webhook_gone']);
    await insert(app, 'state, error_code', ['skipped', 'slot_not_configured']);
  });

  it('refuses an unknown state, event, slot and a negative attempt count', async () => {
    await rejects(insert(app, 'state', ['delivered']), PG.checkViolation);
    await rejects(insert(app, 'attempts', [-1]), PG.checkViolation);
    await rejects(
      app.query(
        `INSERT INTO discord_notification (dedupe_key, event, ticket_id, slot)
         VALUES ('e', 'incident.opened', $1, 'default')`,
        [ticketId],
      ),
      PG.checkViolation,
    );
    await rejects(
      app.query(
        `INSERT INTO discord_notification (dedupe_key, event, ticket_id, slot)
         VALUES ('s', 'ticket.created', $1, 'https://discord.com/api/webhooks/1/x')`,
        [ticketId],
      ),
      PG.checkViolation,
    );
  });

  it('the application may record an outcome but not rewrite who/what, and cannot delete', async () => {
    const row = await insert(app, 'state', ['pending']);
    const id = row.rows[0]?.id ?? '';
    await app.query(
      `UPDATE discord_notification SET state = 'sent', sent_at = now(), attempts = 1, updated_at = now() WHERE id = $1`,
      [id],
    );
    await rejects(
      app.query(`UPDATE discord_notification SET slot = 'urgent' WHERE id = $1`, [id]),
      INSUFFICIENT_PRIVILEGE,
    );
    await rejects(
      app.query(`UPDATE discord_notification SET ticket_id = ticket_id WHERE id = $1`, [id]),
      INSUFFICIENT_PRIVILEGE,
    );
    await rejects(
      app.query(`DELETE FROM discord_notification WHERE id = $1`, [id]),
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('goes down and up again', async () => {
    const later = await migrationsAfter('0015_discord_notify');
    const reverted = await migrateDown(owner(), { steps: 1 + later.length });
    expect(reverted).toEqual([...later.toReversed(), '0015_discord_notify']);
    const gone = await owner().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class WHERE relname = 'discord_notification'`,
    );
    expect(gone.rows[0]?.n).toBe(0);
    expect(await migrateUp(owner())).toEqual(['0015_discord_notify', ...later]);
  });
});
