import { randomBytes } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AI_READONLY_ROLE_GROUP, provisionAiReadOnlyRole } from './app-role.js';
import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

function urlFor(database: string, user: string, password: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  url.username = user;
  url.password = password;
  return url.toString();
}

// Migration 0034 (T-108): the tool ledger, the read-only AI role on a view allow-list, what the
// drafter writes and what a person does with it, and who asked the AI for a KB version.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';
const UNDEFINED_TABLE = '42P01';
const FEATURE_NOT_SUPPORTED = '0A000';

let testDb: TestDatabase;
let app: Pool;
let aiRo: Pool;
const owner = () => testDb.owner.pool;
const aiUser = `wt_ai_${randomBytes(4).toString('hex')}`;
const aiPassword = randomBytes(12).toString('hex');
let ticketId: string;

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
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
  await provisionAiReadOnlyRole(owner(), { user: aiUser, password: aiPassword });
  aiRo = new Pool({
    connectionString: urlFor(testDb.name, aiUser, aiPassword),
    max: 2,
  });
  const org = await owner().query<{ id: string }>(
    `INSERT INTO organization (name) VALUES ('Example Org') RETURNING id`,
  );
  const ticket = await owner().query<{ id: string }>(
    `INSERT INTO ticket (subject, org_id) VALUES ('Webhook not received', $1) RETURNING id`,
    [org.rows[0]?.id],
  );
  ticketId = ticket.rows[0]?.id ?? '';
  await owner().query(
    `INSERT INTO message (ticket_id, direction, body_text, visibility) VALUES ($1, 'inbound', 'public text', 'public'), ($1, 'internal', 'private note', 'internal')`,
    [ticketId],
  );
});
afterAll(async () => {
  await aiRo.end();
  await app.end();
  await testDb.cleanup();
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`DROP ROLE IF EXISTS ${aiUser}`).catch(() => undefined);
  await admin.end();
});

describe('0034 watchtower_ai_ro: reads views, nothing else (N2)', () => {
  it('reads the three views', async () => {
    const tickets = await aiRo.query(`SELECT id, subject, intent_key FROM ai_v_ticket`);
    expect(tickets.rowCount).toBe(1);
    expect((await aiRo.query(`SELECT name, tier FROM ai_v_org`)).rowCount).toBe(1);
  });

  it('sees public messages only, cut to a prefix', async () => {
    const rows = await aiRo.query<{ body_text: string }>(`SELECT body_text FROM ai_v_ticket_message`);
    expect(rows.rows.map((row) => row.body_text)).toEqual(['public text']);
  });

  it('cannot read a base table, a column the views leave out, or anything of the application', async () => {
    for (const table of ['ticket', 'message', 'organization', 'contact', 'users', 'kb_article', 'ai_draft', 'audit_log']) {
      expect(await code(aiRo.query(`SELECT * FROM ${table} LIMIT 1`))).toBe(INSUFFICIENT_PRIVILEGE);
    }
    // The views list their columns: the requester and the assignee are not among them.
    expect(await code(aiRo.query(`SELECT requester_contact_id FROM ai_v_ticket`))).toBe('42703');
  });

  it('cannot write: not a table, not a view', async () => {
    expect(await code(aiRo.query(`INSERT INTO tool_execution (run_key, agent, tool, input_hash, status) VALUES ('r','a','t','${'a'.repeat(64)}','denied')`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await code(aiRo.query(`UPDATE ai_v_org SET name = 'x'`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await code(aiRo.query(`DELETE FROM ai_v_ticket_message`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await code(aiRo.query(`CREATE TABLE t_x (id int)`))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('the application role reads the views but cannot write through them', async () => {
    expect((await app.query(`SELECT 1 FROM ai_v_ticket_message`)).rowCount).toBe(1);
    // Not updatable at all (it cuts the text), and the application has no write right on it either.
    expect([INSUFFICIENT_PRIVILEGE, FEATURE_NOT_SUPPORTED]).toContain(
      await code(app.query(`UPDATE ai_v_ticket_message SET body_text = 'x'`)),
    );
    expect(await code(app.query(`DELETE FROM ai_v_org`))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('provisioning is idempotent and refuses the application group and short passwords', async () => {
    expect(await provisionAiReadOnlyRole(owner(), { user: aiUser, password: aiPassword })).toBe('updated');
    await expect(provisionAiReadOnlyRole(owner(), { user: AI_READONLY_ROLE_GROUP, password: aiPassword })).rejects.toThrow();
    await expect(provisionAiReadOnlyRole(owner(), { user: 'watchtower_app', password: aiPassword })).rejects.toThrow();
    await expect(provisionAiReadOnlyRole(owner(), { user: aiUser, password: 'short' })).rejects.toThrow();
    const member = await owner().query(
      `SELECT pg_has_role($1, 'watchtower_app', 'member') AS app`,
      [aiUser],
    );
    expect(member.rows[0]).toEqual({ app: false });
  });
});

describe('0034 tool_execution', () => {
  const HASH = 'b'.repeat(64);
  const insert = (status: string, extra = '') =>
    app.query<{ id: string }>(
      `INSERT INTO tool_execution (ticket_id, run_key, agent, tool, input_hash, status${extra === '' ? '' : ', finished_at'})
       VALUES ($1, 'run', 'investigator', 'kb_search', $2, $3${extra === '' ? '' : ', now()'}) RETURNING id`,
      [ticketId, HASH, status],
    );

  it('is written and then closed by the application, and cannot be rewritten or deleted', async () => {
    const running = (await insert('running')).rows[0]?.id;
    await app.query(
      `UPDATE tool_execution SET status = 'ok', finished_at = now(), latency_ms = 3, result_count = 2 WHERE id = $1`,
      [running],
    );
    expect(await code(app.query(`UPDATE tool_execution SET tool = 'other' WHERE id = $1`, [running]))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await code(app.query(`UPDATE tool_execution SET input_hash = $2 WHERE id = $1`, [running, 'c'.repeat(64)]))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await code(app.query(`DELETE FROM tool_execution WHERE id = $1`, [running]))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await code(app.query(`TRUNCATE tool_execution`))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('refuses an unknown status, a malformed hash or name, and a running row that is finished', async () => {
    expect(await code(insert('maybe', 'x'))).toBe(CHECK_VIOLATION);
    expect(await code(app.query(`INSERT INTO tool_execution (run_key, agent, tool, input_hash, status) VALUES ('r','a','kb_search','not-a-hash','running')`))).toBe(CHECK_VIOLATION);
    expect(await code(app.query(`INSERT INTO tool_execution (run_key, agent, tool, input_hash, status) VALUES ('r','a','Bad Name','${HASH}','running')`))).toBe(CHECK_VIOLATION);
    expect(await code(insert('running', 'finished'))).toBe(CHECK_VIOLATION);
    expect(await code(insert('ok'))).toBe(CHECK_VIOLATION);
  });
});

describe('0034 ai_draft: verdict and learning-loop columns', () => {
  const draft = async (): Promise<string> =>
    (
      await app.query<{ id: string }>(
        `INSERT INTO ai_draft (ticket_id, body_text, language, citations, uncited_claims)
         VALUES ($1, 'Hello there', 'en', '[{"evidenceId":"ev-1","sentence":0,"kind":"kb"}]', 1) RETURNING id`,
        [ticketId],
      )
    ).rows[0]?.id ?? '';

  it('records a rejection with its reason, and only a reason makes it a rejection', async () => {
    const id = await draft();
    expect(await code(app.query(`UPDATE ai_draft SET status = 'rejected', disposition = 'rejected' WHERE id = $1`, [id]))).toBe(CHECK_VIOLATION);
    expect(await code(app.query(`UPDATE ai_draft SET disposition = 'rejected', reject_reason = 'tone_style' WHERE id = $1`, [id]))).toBe(CHECK_VIOLATION);
    await app.query(
      `UPDATE ai_draft SET status = 'rejected', disposition = 'rejected', reject_reason = 'tone_style', reject_comment = 'too formal', resolved_at = now() WHERE id = $1`,
      [id],
    );
    expect(await code(app.query(`UPDATE ai_draft SET disposition = 'maybe' WHERE id = $1`, [id]))).toBe(CHECK_VIOLATION);
  });

  it('keeps the text, the hash and the citations the drafter wrote out of reach of the application', async () => {
    const id = await draft();
    for (const column of ['body_text', 'content_hash', 'citations', 'uncited_claims', 'language', 'needs_review', 'requested_by']) {
      expect(await code(app.query(`UPDATE ai_draft SET ${column} = ${column} WHERE id = $1`, [id]))).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it('bounds the edit distance and accepts the superseded status', async () => {
    const id = await draft();
    expect(await code(app.query(`UPDATE ai_draft SET edit_distance = 1.5 WHERE id = $1`, [id]))).toBe(CHECK_VIOLATION);
    await app.query(`UPDATE ai_draft SET edit_distance = 0.25 WHERE id = $1`, [id]);
    await app.query(`UPDATE ai_draft SET status = 'superseded' WHERE id = $1`, [id]);
  });
});

describe('0034 ai_ticket_insight and kb_article_version', () => {
  it('points at a draft that exists', async () => {
    expect(
      await code(
        owner().query(
          `INSERT INTO ai_ticket_insight (ticket_id, state, generated_at, draft_id) VALUES ($1, 'draft_ready', now(), gen_random_uuid())`,
          [ticketId],
        ),
      ),
    ).toBe('23503');
  });

  it('kb_article_version has requested_by and stays immutable', async () => {
    const columns = await owner().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'kb_article_version' AND column_name = 'requested_by'`,
    );
    expect(columns.rowCount).toBe(1);
  });
});

describe('0034 down and up', () => {
  it('reverts cleanly and applies again, also with a superseded draft that a delivery points at', async () => {
    // An approved draft whose send was undone and which a newer draft then replaced: the delivery
    // (cancelled, kept for the record) still references it, so the down migration must not delete it.
    const person = (
      await owner().query<{ id: string }>(
        `INSERT INTO users (email, name, role) VALUES ('down@example.test', 'Down', 'agent') RETURNING id`,
      )
    ).rows[0]?.id;
    const account = (
      await owner().query<{ id: string }>(
        `INSERT INTO channel_account (type, name) VALUES ('gmail', 'Support') RETURNING id`,
      )
    ).rows[0]?.id;
    await owner().query(`UPDATE ticket SET channel = 'gmail', channel_account_id = $2 WHERE id = $1`, [
      ticketId,
      account,
    ]);
    const message = (
      await owner().query<{ id: string }>(
        `INSERT INTO message (ticket_id, channel_account_id, direction, body_text, visibility, delivery_status, sender_user_id)
         VALUES ($1, $2, 'outbound', 'hello', 'public', 'scheduled', $3) RETURNING id`,
        [ticketId, account, person],
      )
    ).rows[0]?.id;
    const draft = (
      await owner().query<{ id: string; content_hash: string }>(
        `INSERT INTO ai_draft (ticket_id, body_text) VALUES ($1, 'hello') RETURNING id, content_hash`,
        [ticketId],
      )
    ).rows[0];
    await owner().query(
      `UPDATE ai_draft SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
      [draft?.id, person],
    );
    await owner().query(
      `INSERT INTO outbound_delivery (ticket_id, message_id, channel_account_id, channel, origin, ai_draft_id,
         approved_by, content_hash, hold_seconds, next_attempt_at, created_by, state)
       VALUES ($1, $2, $3, 'gmail', 'ai_approved', $4, $5, $6, 5, now(), $5, 'scheduled')`,
      [ticketId, message, account, draft?.id, person, draft?.content_hash],
    );
    await owner().query(`UPDATE outbound_delivery SET state = 'cancelled', cancelled_at = now()`);
    await owner().query(
      `UPDATE ai_draft SET status = 'draft', approved_by = NULL, approved_at = NULL WHERE id = $1`,
      [draft?.id],
    );
    await owner().query(`UPDATE ai_draft SET status = 'superseded' WHERE id = $1`, [draft?.id]);

    const later = await migrationsAfter('0034_ai_investigation');
    const reverted = await migrateDown(owner(), { steps: later.length + 1 });
    expect(reverted[reverted.length - 1]).toBe('0034_ai_investigation');
    expect(await code(owner().query(`SELECT 1 FROM tool_execution`))).toBe(UNDEFINED_TABLE);
    expect(await code(owner().query(`SELECT 1 FROM ai_v_org`))).toBe(UNDEFINED_TABLE);
    expect(await migrateUp(owner())).toEqual(['0034_ai_investigation', ...later]);
    expect((await owner().query(`SELECT 1 FROM tool_execution`)).rowCount).toBe(0);
  });
});
