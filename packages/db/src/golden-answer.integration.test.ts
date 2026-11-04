import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0098 (T-302a): golden answers. Append and soft delete: the application role can add a row and
// retire it, and change nothing else; one live row per message.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const INSUFFICIENT_PRIVILEGE = '42501';
const UNDEFINED_TABLE = '42P01';

let testDb: TestDatabase;
let app: Pool;
let ticketId: string;
let messageId: string;
let intentId: string;
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

const golden = (over: Record<string, unknown> = {}) => {
  const row = {
    message_id: messageId,
    body: 'Hello [NAME_1], it is fixed.',
    language: 'en',
    ...over,
  };
  return app.query<{ id: string }>(
    `INSERT INTO golden_answer (ticket_id, message_id, intent_id, body_redacted, language, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [ticketId, row.message_id, intentId, row.body, row.language, userId],
  );
};

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 3 });
  const org = await owner().query<{ id: string }>(
    `INSERT INTO organization (name) VALUES ('Example Org') RETURNING id`,
  );
  ticketId =
    (
      await owner().query<{ id: string }>(
        `INSERT INTO ticket (org_id, subject) VALUES ($1, 'Cannot sign in') RETURNING id`,
        [org.rows[0]?.id],
      )
    ).rows[0]?.id ?? '';
  messageId =
    (
      await owner().query<{ id: string }>(
        `INSERT INTO message (ticket_id, direction, visibility, body_text) VALUES ($1, 'outbound', 'public', 'Hi') RETURNING id`,
        [ticketId],
      )
    ).rows[0]?.id ?? '';
  intentId =
    (
      await owner().query<{ id: string }>(
        `INSERT INTO intent (key, name) VALUES ('golden_db', 'Golden db') RETURNING id`,
      )
    ).rows[0]?.id ?? '';
  userId =
    (
      await owner().query<{ id: string }>(
        `INSERT INTO users (email, name, role) VALUES ('lead@example.test', 'Lead', 'lead') RETURNING id`,
      )
    ).rows[0]?.id ?? '';
});
afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

describe('golden_answer', () => {
  it('lets the application role add a row, one live row per message', async () => {
    const first = await golden();
    expect(first.rows[0]?.id).toBeTruthy();
    expect(await code(golden())).toBe(UNIQUE_VIOLATION);
  });

  it('refuses an empty text, an unknown language, and a half-written delete', async () => {
    const other = (
      await owner().query<{ id: string }>(
        `INSERT INTO message (ticket_id, direction, visibility, body_text) VALUES ($1, 'outbound', 'public', 'Hi again') RETURNING id`,
        [ticketId],
      )
    ).rows[0]?.id;
    expect(await code(golden({ message_id: other, body: '   ' }))).toBe(CHECK_VIOLATION);
    expect(await code(golden({ message_id: other, language: 'fr' }))).toBe(CHECK_VIOLATION);
    expect(
      await code(
        owner().query(`UPDATE golden_answer SET deleted_at = now() WHERE message_id = $1`, [
          messageId,
        ]),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('lets the application role retire a row and nothing else; a retired message can be marked again', async () => {
    expect(await code(app.query(`UPDATE golden_answer SET body_redacted = 'changed'`))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await code(app.query(`DELETE FROM golden_answer`))).toBe(INSUFFICIENT_PRIVILEGE);
    await app.query(`UPDATE golden_answer SET deleted_at = now(), deleted_by = $1`, [userId]);
    const again = await golden();
    expect(again.rows[0]?.id).toBeTruthy();
  });

  it('seeds the permission for lead and head only', async () => {
    const rows = await owner().query<{ role: string }>(
      `SELECT role FROM role_permissions WHERE permission = 'ai.golden.manage' ORDER BY role`,
    );
    expect(rows.rows.map((row) => row.role)).toEqual(['head', 'lead']);
  });
});

describe('0098 goes down and up again', () => {
  it('drops the table and the permission, and brings them back', async () => {
    const later = await migrationsAfter('0098_golden_answer');
    const reverted = await migrateDown(owner(), { steps: later.length + 1 });
    expect(reverted[reverted.length - 1]).toBe('0098_golden_answer');
    expect(await code(owner().query(`SELECT 1 FROM golden_answer`))).toBe(UNDEFINED_TABLE);
    expect(
      (await owner().query(`SELECT 1 FROM permissions WHERE key = 'ai.golden.manage'`)).rowCount,
    ).toBe(0);

    expect(await migrateUp(owner())).toEqual(['0098_golden_answer', ...later]);
    expect((await owner().query(`SELECT 1 FROM golden_answer`)).rowCount).toBe(0);
  });
});
