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
       ON CONFLICT (kind, user_id, locale) DO UPDATE SET fingerprint = excluded.fingerprint`,
      [userId],
    );
    await app.query(
      `INSERT INTO ai_summary (kind, user_id, fingerprint, claims, data_as_of) VALUES ('brief', $1, 'b', '[]', now())
       ON CONFLICT (kind, user_id, locale) DO UPDATE SET fingerprint = excluded.fingerprint`,
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

describe('0112 assistant stage 1 (T-401, ADR-029)', () => {
  const memory = (body: string, refs: unknown[] = [], sourceMessageId: string | null = null) =>
    app.query(
      `INSERT INTO assistant_memory (user_id, body, refs, source_message_id, expires_at)
       VALUES ($1, $2, $3::jsonb, $4, now() + interval '90 days') RETURNING id`,
      [userId, body, JSON.stringify(refs), sourceMessageId],
    );

  it('lets the application role keep a memory with at most 300 characters and five refs', async () => {
    const refs = [{ kind: 'ticket', id: 'x' }];
    expect((await memory('Prefers short answers', refs)).rowCount).toBe(1);
    expect(await code(memory('x'.repeat(301)))).toBe(CHECK_VIOLATION);
    expect(await code(memory(''))).toBe(CHECK_VIOLATION);
    expect(
      await code(
        memory(
          'ok',
          Array.from({ length: 6 }, () => ({ kind: 'ticket', id: 'x' })),
        ),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await code(
        app.query(
          `INSERT INTO assistant_memory (user_id, body, refs, expires_at) VALUES ($1, 'ok', '{}'::jsonb, now())`,
          [userId],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('keeps the memory when its source message goes, and removes it with its person', async () => {
    const conversationId = await conversation();
    const message = await app.query<{ id: string }>(
      `INSERT INTO assistant_message (conversation_id, user_id, role, body, evidence, path)
       VALUES ($1, $2, 'assistant', 'ok', '[{"kind":"ticket","id":"t"}]', 'llm1') RETURNING id`,
      [conversationId, userId],
    );
    const messageId = message.rows[0]?.id ?? '';
    await memory('from an answer', [], messageId);
    await app.query(`DELETE FROM assistant_message WHERE id = $1`, [messageId]);
    const kept = await owner().query<{ source_message_id: string | null }>(
      `SELECT source_message_id FROM assistant_memory WHERE body = 'from an answer'`,
    );
    expect(kept.rows).toEqual([{ source_message_id: null }]);

    const other = await owner().query<{ id: string }>(
      `INSERT INTO users (email, name, role) VALUES ('memory-owner@example.com', 'M', 'agent') RETURNING id`,
    );
    await app.query(
      `INSERT INTO assistant_memory (user_id, body, expires_at) VALUES ($1, 'mine', now())`,
      [other.rows[0]?.id],
    );
    await owner().query(`DELETE FROM users WHERE id = $1`, [other.rows[0]?.id]);
    expect(
      (await owner().query(`SELECT 1 FROM assistant_memory WHERE body = 'mine'`)).rowCount,
    ).toBe(0);
  });

  it('gives a message an empty evidence list by default and only the three paths', async () => {
    const conversationId = await conversation();
    const made = await app.query<{ evidence: unknown; path: string | null }>(
      `INSERT INTO assistant_message (conversation_id, user_id, role, body) VALUES ($1, $2, 'user', 'hi') RETURNING evidence, path`,
      [conversationId, userId],
    );
    expect(made.rows[0]).toEqual({ evidence: [], path: null });
    for (const path of ['facts_only', 'llm1', 'llm2']) {
      expect(
        (
          await app.query(
            `INSERT INTO assistant_message (conversation_id, user_id, role, body, path) VALUES ($1, $2, 'user', 'p', $3)`,
            [conversationId, userId, path],
          )
        ).rowCount,
      ).toBe(1);
    }
    expect(
      await code(
        app.query(
          `INSERT INTO assistant_message (conversation_id, user_id, role, body, path) VALUES ($1, $2, 'user', 'p', 'llm3')`,
          [conversationId, userId],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('grants assistant.use to agent, lead, head and dev and to nobody else', async () => {
    const rows = await owner().query<{ role: string }>(
      `SELECT role FROM role_permissions WHERE permission = 'assistant.use' ORDER BY role`,
    );
    expect(rows.rows.map((row) => row.role)).toEqual(['agent', 'dev', 'head', 'lead']);
  });

  it('goes down (taking the table, the columns and the permission) and up again', async () => {
    const db = await createTestDatabase(adminUrl);
    try {
      const pool = db.owner.pool;
      const later = await migrationsAfter('0112_assistant_stage1');
      const reverted = await migrateDown(pool, { steps: later.length + 1 });
      expect(reverted[reverted.length - 1]).toBe('0112_assistant_stage1');
      expect(await code(pool.query(`SELECT 1 FROM assistant_memory`))).toBe(UNDEFINED_TABLE);
      expect(await code(pool.query(`SELECT evidence FROM assistant_message`))).toBe('42703');
      expect(await code(pool.query(`SELECT path FROM assistant_message`))).toBe('42703');
      expect(
        (await pool.query(`SELECT 1 FROM permissions WHERE key = 'assistant.use'`)).rowCount,
      ).toBe(0);
      expect(
        (await pool.query(`SELECT 1 FROM role_permissions WHERE permission = 'assistant.use'`))
          .rowCount,
      ).toBe(0);

      expect(await migrateUp(pool)).toEqual(['0112_assistant_stage1', ...later]);
      expect((await pool.query(`SELECT 1 FROM assistant_memory`)).rowCount).toBe(0);
      expect(
        (await pool.query(`SELECT 1 FROM role_permissions WHERE permission = 'assistant.use'`))
          .rowCount,
      ).toBe(4);
    } finally {
      await db.cleanup();
    }
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

describe('0114 assistant feedback (T-408)', () => {
  const rate = (fields: { rating: string; reason?: string | null; kind?: string; id?: string }) =>
    app.query(
      `INSERT INTO assistant_feedback (user_id, target_kind, target_id, rating, reason)
       VALUES ($1, $2, COALESCE($3::uuid, gen_random_uuid()), $4, $5)`,
      [userId, fields.kind ?? 'message', fields.id ?? null, fields.rating, fields.reason ?? null],
    );

  it('lets the application role rate, once per person and target, with a reason only on a thumbs-down', async () => {
    const target = '6b0a4f0e-6d1a-4c50-8f5a-2f4f0f0e0a01';
    await rate({ rating: 'up', id: target });
    expect(await code(rate({ rating: 'down', id: target }))).toBe('23505');
    expect(await code(rate({ rating: 'up', reason: 'other' }))).toBe(CHECK_VIOLATION);
    expect(await code(rate({ rating: 'down', reason: 'rude' }))).toBe(CHECK_VIOLATION);
    expect(await code(rate({ rating: 'maybe' }))).toBe(CHECK_VIOLATION);
    expect(await code(rate({ rating: 'down', kind: 'ticket' }))).toBe(CHECK_VIOLATION);
    await rate({ rating: 'down', reason: 'judges_person', kind: 'insight' });
  });

  it('goes down (dropping the table) and up again', async () => {
    const db = await createTestDatabase(adminUrl);
    try {
      const pool = db.owner.pool;
      const later = await migrationsAfter('0114_assistant_feedback');
      const reverted = await migrateDown(pool, { steps: later.length + 1 });
      expect(reverted[reverted.length - 1]).toBe('0114_assistant_feedback');
      expect(await code(pool.query(`SELECT 1 FROM assistant_feedback`))).toBe(UNDEFINED_TABLE);
      // The memory table of 0112 is not touched by it.
      expect((await pool.query(`SELECT 1 FROM assistant_memory`)).rowCount).toBe(0);
      expect(await migrateUp(pool)).toEqual(['0114_assistant_feedback', ...later]);
      expect((await pool.query(`SELECT 1 FROM assistant_feedback`)).rowCount).toBe(0);
    } finally {
      await db.cleanup();
    }
  });
});
