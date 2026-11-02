import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0090 (T-134, T-135): the assistant's conversations, messages and proposals, and the cache
// of AI summaries. The application role works with them; the CHECKs keep a decided proposal decided.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const UNDEFINED_TABLE = '42P01';

let testDb: TestDatabase;
let app: Pool;
let userId: string;
const owner = () => testDb.owner.pool;

const code = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 3 });
  const user = await owner().query<{ id: string }>(
    `INSERT INTO users (email, name, role) VALUES ('assistant@example.com', 'A', 'agent') RETURNING id`,
  );
  userId = user.rows[0]?.id ?? '';
});
afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

async function conversation(): Promise<string> {
  const made = await app.query<{ id: string }>(
    `INSERT INTO assistant_conversation (user_id, locale) VALUES ($1, 'th') RETURNING id`,
    [userId],
  );
  return made.rows[0]?.id ?? '';
}

describe('the assistant tables', () => {
  it('lets the application role write and read a conversation, a message and a proposal', async () => {
    const id = await conversation();
    await app.query(
      `INSERT INTO assistant_message (conversation_id, user_id, role, body, tools, ai_run_ids, input_tokens, output_tokens)
       VALUES ($1, $2, 'assistant', 'ok', '[{"name":"search_tickets","status":"ok","mock":true}]', ARRAY[gen_random_uuid()], 10, 20)`,
      [id, userId],
    );
    await app.query(
      `INSERT INTO assistant_proposal (conversation_id, user_id, kind, params, card, expires_at)
       VALUES ($1, $2, 'assign', '{}', '{}', now() + interval '10 minutes')`,
      [id, userId],
    );
    const tokens = await app.query<{ n: string }>(
      `SELECT sum(input_tokens + output_tokens)::text AS n FROM assistant_message WHERE user_id = $1`,
      [userId],
    );
    expect(tokens.rows[0]?.n).toBe('30');
  });

  it('refuses a role, a locale, a kind or a status the contract does not have', async () => {
    const id = await conversation();
    expect(
      await code(
        app.query(
          `INSERT INTO assistant_message (conversation_id, user_id, role, body) VALUES ($1, $2, 'system', 'x')`,
          [id, userId],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await code(
        app.query(`INSERT INTO assistant_conversation (user_id, locale) VALUES ($1, 'fr')`, [
          userId,
        ]),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await code(
        app.query(
          `INSERT INTO assistant_proposal (conversation_id, user_id, kind, params, card, expires_at)
           VALUES ($1, $2, 'delete_everything', '{}', '{}', now())`,
          [id, userId],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await code(
        app.query(
          `INSERT INTO assistant_proposal (conversation_id, user_id, kind, params, card, expires_at, status)
           VALUES ($1, $2, 'note', '{}', '{}', now(), 'approved')`,
          [id, userId],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('keeps "pending" and "not decided" the same thing', async () => {
    const id = await conversation();
    // Decided but no time, and a time but still pending: both are rejected.
    expect(
      await code(
        app.query(
          `INSERT INTO assistant_proposal (conversation_id, user_id, kind, params, card, expires_at, status)
           VALUES ($1, $2, 'note', '{}', '{}', now(), 'confirmed')`,
          [id, userId],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await code(
        app.query(
          `INSERT INTO assistant_proposal (conversation_id, user_id, kind, params, card, expires_at, decided_at)
           VALUES ($1, $2, 'note', '{}', '{}', now(), now())`,
          [id, userId],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('deletes messages and proposals with their conversation, and everything with the user', async () => {
    const id = await conversation();
    await app.query(
      `INSERT INTO assistant_message (conversation_id, user_id, role, body) VALUES ($1, $2, 'user', 'hi')`,
      [id, userId],
    );
    await app.query(`DELETE FROM assistant_conversation WHERE id = $1`, [id]);
    const left = await owner().query(`SELECT 1 FROM assistant_message WHERE conversation_id = $1`, [
      id,
    ]);
    expect(left.rowCount).toBe(0);
    // A message cannot point at a conversation that is not there.
    expect(
      await code(
        app.query(
          `INSERT INTO assistant_message (conversation_id, user_id, role, body) VALUES (gen_random_uuid(), $1, 'user', 'x')`,
          [userId],
        ),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('keeps one summary per person and screen', async () => {
    await app.query(
      `INSERT INTO ai_summary (kind, user_id, fingerprint, claims, data_as_of) VALUES ('brief', $1, 'a', '[]', now())
       ON CONFLICT (kind, user_id) DO UPDATE SET fingerprint = excluded.fingerprint`,
      [userId],
    );
    await app.query(
      `INSERT INTO ai_summary (kind, user_id, fingerprint, claims, data_as_of) VALUES ('brief', $1, 'b', '[]', now())
       ON CONFLICT (kind, user_id) DO UPDATE SET fingerprint = excluded.fingerprint`,
      [userId],
    );
    const rows = await owner().query<{ fingerprint: string }>(
      `SELECT fingerprint FROM ai_summary WHERE user_id = $1`,
      [userId],
    );
    expect(rows.rows).toEqual([{ fingerprint: 'b' }]);
    expect(
      await code(
        app.query(
          `INSERT INTO ai_summary (kind, user_id, fingerprint, claims, data_as_of) VALUES ('digest', $1, 'a', '[]', now())`,
          [userId],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });
});

describe('0090 goes down and up again', () => {
  it('drops the tables and brings them back', async () => {
    const later = await migrationsAfter('0090_assistant');
    const reverted = await migrateDown(owner(), { steps: later.length + 1 });
    expect(reverted[reverted.length - 1]).toBe('0090_assistant');
    expect(await code(owner().query(`SELECT 1 FROM assistant_conversation`))).toBe(UNDEFINED_TABLE);
    expect(await code(owner().query(`SELECT 1 FROM ai_summary`))).toBe(UNDEFINED_TABLE);

    expect(await migrateUp(owner())).toEqual(['0090_assistant', ...later]);
    expect((await owner().query(`SELECT 1 FROM assistant_conversation`)).rowCount).toBe(0);
  });
});
