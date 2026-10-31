import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PG, isPgError } from './errors.js';
import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0007 (T-122c): inbound_event and inbound_message. Checks the keys that make ingestion
// idempotent, the CHECK constraints, the column-level privileges of the application role, and the
// revert.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const INSUFFICIENT_PRIVILEGE = '42501';

let testDb: TestDatabase;
let app: Pool;
const owner = (): Pool => testDb.owner.pool;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
});

afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

async function account(): Promise<string> {
  const { rows } = await owner().query<{ id: string }>(
    `INSERT INTO channel_account (type, name) VALUES ('gmail', 'Support') RETURNING id`,
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('no channel account');
  return id;
}

async function rejects(work: Promise<unknown>, code: string): Promise<void> {
  try {
    await work;
  } catch (error) {
    expect(isPgError(error, code)).toBe(true);
    return;
  }
  throw new Error(`expected Postgres error ${code}`);
}

describe('0007 inbound tables', () => {
  it('makes a second event with the same provider id a conflict, per account', async () => {
    const first = await account();
    const second = await account();
    const insert = (accountId: string, providerEventId: string) =>
      app.query(
        `INSERT INTO inbound_event (channel_account_id, provider_event_id) VALUES ($1, $2)`,
        [accountId, providerEventId],
      );
    await insert(first, 'evt-1');
    await rejects(insert(first, 'evt-1'), PG.uniqueViolation);
    await insert(second, 'evt-1');
    const { rows } = await app.query<{ status: string; payload: unknown }>(
      `SELECT status, payload FROM inbound_event WHERE provider_event_id = 'evt-1' LIMIT 1`,
    );
    expect(rows[0]).toEqual({ status: 'pending', payload: {} });
  });

  it('rejects an unknown event status and a payload that is not an object', async () => {
    const accountId = await account();
    await rejects(
      app.query(
        `INSERT INTO inbound_event (channel_account_id, provider_event_id, status) VALUES ($1, 'x', 'done')`,
        [accountId],
      ),
      PG.checkViolation,
    );
    await rejects(
      app.query(
        `INSERT INTO inbound_event (channel_account_id, provider_event_id, payload) VALUES ($1, 'y', '[]')`,
        [accountId],
      ),
      PG.checkViolation,
    );
  });

  it('dedupes messages on (account, provider message id) and checks disposition and ticket link', async () => {
    const accountId = await account();
    const insert = (providerMessageId: string, disposition = 'pending') =>
      app.query(
        `INSERT INTO inbound_message (channel_account_id, provider_message_id, received_at, disposition)
         VALUES ($1, $2, now(), $3)`,
        [accountId, providerMessageId, disposition],
      );
    await insert('m-1');
    await rejects(insert('m-1'), PG.uniqueViolation);
    await rejects(insert('m-2', 'spam'), PG.checkViolation);
    // `ticket` and `appended` need a ticket id; the others must not have one.
    await rejects(insert('m-3', 'ticket'), PG.checkViolation);
    await insert('m-4', 'noise');
    await insert('m-5', 'auto_reply');
    await insert('m-6', 'internal');
  });

  it('lets the application record an outcome but not rewrite what was received', async () => {
    const accountId = await account();
    await app.query(
      `INSERT INTO inbound_message (channel_account_id, provider_message_id, received_at, subject)
       VALUES ($1, 'priv-1', now(), 'Original')`,
      [accountId],
    );
    await app.query(
      `UPDATE inbound_message SET disposition = 'noise', disposition_by = 'system', disposition_at = now()
        WHERE provider_message_id = 'priv-1'`,
    );
    await rejects(
      app.query(
        `UPDATE inbound_message SET subject = 'Changed' WHERE provider_message_id = 'priv-1'`,
      ),
      INSUFFICIENT_PRIVILEGE,
    );
    await rejects(
      app.query(
        `UPDATE inbound_message SET from_address = 'x@example.test' WHERE provider_message_id = 'priv-1'`,
      ),
      INSUFFICIENT_PRIVILEGE,
    );
    await rejects(
      app.query(`DELETE FROM inbound_message WHERE provider_message_id = 'priv-1'`),
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('lets the application finish and delete events but not change their identity', async () => {
    const accountId = await account();
    await app.query(
      `INSERT INTO inbound_event (channel_account_id, provider_event_id, payload) VALUES ($1, 'priv-evt', '{"a":1}')`,
      [accountId],
    );
    await app.query(
      `UPDATE inbound_event SET status = 'processed', payload = '{}', processed_at = now()
        WHERE provider_event_id = 'priv-evt'`,
    );
    await rejects(
      app.query(
        `UPDATE inbound_event SET provider_event_id = 'other' WHERE provider_event_id = 'priv-evt'`,
      ),
      INSUFFICIENT_PRIVILEGE,
    );
    await rejects(
      app.query(
        `UPDATE inbound_event SET channel_account_id = $1 WHERE provider_event_id = 'priv-evt'`,
        [accountId],
      ),
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('keeps the message when its event is deleted by retention', async () => {
    const accountId = await account();
    const event = await app.query<{ id: string }>(
      `INSERT INTO inbound_event (channel_account_id, provider_event_id) VALUES ($1, 'ret-evt') RETURNING id`,
      [accountId],
    );
    await app.query(
      `INSERT INTO inbound_message (channel_account_id, inbound_event_id, provider_message_id, received_at)
       VALUES ($1, $2, 'ret-msg', now())`,
      [accountId, event.rows[0]?.id],
    );
    await app.query(`DELETE FROM inbound_event WHERE provider_event_id = 'ret-evt'`);
    const { rows } = await app.query<{ inbound_event_id: string | null }>(
      `SELECT inbound_event_id FROM inbound_message WHERE provider_message_id = 'ret-msg'`,
    );
    expect(rows).toEqual([{ inbound_event_id: null }]);
  });

  it('goes down (dropping both tables and the thread index) and up again', async () => {
    const later = await migrationsAfter('0007_inbound');
    const reverted = await migrateDown(owner(), { steps: 1 + later.length });
    expect(reverted).toEqual([...later.toReversed(), '0007_inbound']);
    const gone = await owner().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class
        WHERE relname IN ('inbound_event', 'inbound_message', 'message_thread_key_idx')`,
    );
    expect(gone.rows[0]?.n).toBe(0);

    expect(await migrateUp(owner())).toEqual(['0007_inbound', ...later]);
    const back = await owner().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('inbound_event', 'inbound_message')`,
    );
    expect(back.rows[0]?.n).toBe(2);
  });
});
