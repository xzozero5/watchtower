import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PG, isPgError } from './errors.js';
import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0010 (T-122d, ADR-010): ai_draft, outbound_delivery, channel_quota_usage,
// instance_setting, two more message delivery states and the sealed reply token. Checks the
// constraints that make at-most-once and the origin rules hold in the database itself, the
// column-level privileges of the application role, and the revert.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const INSUFFICIENT_PRIVILEGE = '42501';
const HASH = 'a'.repeat(64);

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

async function rejects(work: Promise<unknown>, code: string): Promise<void> {
  try {
    await work;
  } catch (error) {
    expect(isPgError(error, code), String(error)).toBe(true);
    return;
  }
  throw new Error(`expected Postgres error ${code}`);
}

interface Fixture {
  readonly ticketId: string;
  readonly messageId: string;
  readonly accountId: string;
}

async function fixture(): Promise<Fixture> {
  const account = await owner().query<{ id: string }>(
    `INSERT INTO channel_account (type, name) VALUES ('gmail', 'Support') RETURNING id`,
  );
  const org = await owner().query<{ id: string }>(
    `INSERT INTO organization (name) VALUES ('Org ' || gen_random_uuid()) RETURNING id`,
  );
  const ticket = await owner().query<{ id: string }>(
    `INSERT INTO ticket (subject, org_id, channel, channel_account_id)
     VALUES ('s', $1, 'gmail', $2) RETURNING id`,
    [org.rows[0]?.id, account.rows[0]?.id],
  );
  const message = await owner().query<{ id: string }>(
    `INSERT INTO message (ticket_id, channel_account_id, direction, body_text, visibility, delivery_status)
     VALUES ($1, $2, 'outbound', 'hello', 'public', 'scheduled') RETURNING id`,
    [ticket.rows[0]?.id, account.rows[0]?.id],
  );
  return {
    ticketId: ticket.rows[0]?.id ?? '',
    messageId: message.rows[0]?.id ?? '',
    accountId: account.rows[0]?.id ?? '',
  };
}

const insertDelivery = (
  pool: Pool,
  f: Fixture,
  extra: {
    origin?: string;
    createdBy?: string | null;
    template?: string | null;
    draft?: string | null;
    approvedBy?: string | null;
    state?: string;
    messageId?: string;
  } = {},
) =>
  pool.query<{ id: string }>(
    `INSERT INTO outbound_delivery
       (ticket_id, message_id, channel_account_id, channel, origin, template_key, ai_draft_id, approved_by,
        content_hash, hold_seconds, next_attempt_at, created_by, state, lease_until, sent_at, error_code, cancelled_at)
     VALUES ($1, $2, $3, 'gmail', $4, $5, $6, $7, $8, 5, now(), $9, $10,
             CASE WHEN $10 = 'sending' THEN now() END, CASE WHEN $10 = 'sent' THEN now() END,
             CASE WHEN $10 = 'failed' THEN 'x' END, CASE WHEN $10 = 'cancelled' THEN now() END)
     RETURNING id`,
    [
      f.ticketId,
      extra.messageId ?? f.messageId,
      f.accountId,
      extra.origin ?? 'human',
      extra.template ?? null,
      extra.draft ?? null,
      extra.approvedBy ?? null,
      HASH,
      extra.createdBy === undefined ? '00000000-0000-4000-8000-000000000001' : extra.createdBy,
      extra.state ?? 'scheduled',
    ],
  );

describe('0010 outbound_delivery', () => {
  it('allows one active delivery per message; a failed or cancelled one makes room for another', async () => {
    const f = await fixture();
    await insertDelivery(owner(), f);
    await rejects(insertDelivery(owner(), f), PG.uniqueViolation);
    await owner().query(
      `UPDATE outbound_delivery SET state = 'cancelled', cancelled_at = now() WHERE message_id = $1`,
      [f.messageId],
    );
    await insertDelivery(owner(), f);
    await owner().query(
      `UPDATE outbound_delivery SET state = 'failed', error_code = 'x' WHERE message_id = $1 AND state = 'scheduled'`,
      [f.messageId],
    );
    await insertDelivery(owner(), f, { state: 'sent' });
  });

  it('has no ai_auto origin: the database refuses what Phase 1 must never send', async () => {
    const f = await fixture();
    await rejects(insertDelivery(owner(), f, { origin: 'ai_auto' }), PG.checkViolation);
  });

  it('ties each origin to its proof: a draft and an approver, or a template and no person', async () => {
    const f = await fixture();
    const person = '00000000-0000-4000-8000-000000000002';
    // ai_approved needs both the draft and the approver.
    await rejects(
      insertDelivery(owner(), f, { origin: 'ai_approved', approvedBy: person }),
      PG.checkViolation,
    );
    const draft = await owner().query<{ id: string }>(
      `INSERT INTO ai_draft (ticket_id, body_text) VALUES ($1, 'hello') RETURNING id`,
      [f.ticketId],
    );
    await rejects(
      insertDelivery(owner(), f, { origin: 'ai_approved', draft: draft.rows[0]?.id }),
      PG.checkViolation,
    );
    await insertDelivery(owner(), f, {
      origin: 'ai_approved',
      draft: draft.rows[0]?.id,
      approvedBy: person,
    });
    // A human delivery has no draft and no template.
    const g = await fixture();
    await rejects(insertDelivery(owner(), g, { template: 'auto_ack.received' }), PG.checkViolation);
    await rejects(insertDelivery(owner(), g, { draft: draft.rows[0]?.id }), PG.checkViolation);
    // A template delivery has a key and no sender.
    await rejects(insertDelivery(owner(), g, { origin: 'system_template' }), PG.checkViolation);
    await rejects(
      insertDelivery(owner(), g, { origin: 'system_template', template: 'auto_ack.received' }),
      PG.checkViolation,
    );
    await insertDelivery(owner(), g, {
      origin: 'system_template',
      template: 'auto_ack.received',
      createdBy: null,
    });
  });

  it('sends a draft once: a second active delivery for the same draft is a conflict', async () => {
    const f = await fixture();
    const second = await fixture();
    const person = '00000000-0000-4000-8000-000000000002';
    const draft = await owner().query<{ id: string }>(
      `INSERT INTO ai_draft (ticket_id, body_text) VALUES ($1, 'hello') RETURNING id`,
      [f.ticketId],
    );
    await insertDelivery(owner(), f, {
      origin: 'ai_approved',
      draft: draft.rows[0]?.id,
      approvedBy: person,
    });
    await rejects(
      insertDelivery(owner(), second, {
        origin: 'ai_approved',
        draft: draft.rows[0]?.id,
        approvedBy: person,
      }),
      PG.uniqueViolation,
    );
  });

  it('keeps the state and its evidence together', async () => {
    const f = await fixture();
    await rejects(
      owner().query(
        `INSERT INTO outbound_delivery (ticket_id, message_id, channel_account_id, channel, origin, content_hash, hold_seconds, next_attempt_at, created_by, state)
         VALUES ($1, $2, $3, 'gmail', 'human', $4, 5, now(), gen_random_uuid(), 'sending')`,
        [f.ticketId, f.messageId, f.accountId, HASH],
      ),
      PG.checkViolation,
    );
    const g = await fixture();
    for (const bad of [
      `hold_seconds = 31`,
      `hold_seconds = -1`,
      `content_hash = 'nope'`,
      `route = 'line_push'`,
      `channel = 'portal'`,
      `attempts = -1`,
    ]) {
      const id = (await insertDelivery(owner(), g)).rows[0]?.id;
      await rejects(
        owner().query(`UPDATE outbound_delivery SET ${bad} WHERE id = $1`, [id]),
        PG.checkViolation,
      );
      await owner().query(`DELETE FROM outbound_delivery WHERE id = $1`, [id]);
    }
  });

  it('lets the application move the state but never change who, what or where', async () => {
    const f = await fixture();
    const id = (await insertDelivery(app, f)).rows[0]?.id;
    await app.query(
      `UPDATE outbound_delivery SET state = 'sending', attempts = attempts + 1, lease_until = now(), updated_at = now() WHERE id = $1`,
      [id],
    );
    for (const sql of [
      `UPDATE outbound_delivery SET content_hash = '${'b'.repeat(64)}' WHERE id = $1`,
      `UPDATE outbound_delivery SET origin = 'human' WHERE id = $1`,
      `UPDATE outbound_delivery SET message_id = gen_random_uuid() WHERE id = $1`,
      `UPDATE outbound_delivery SET approved_by = gen_random_uuid() WHERE id = $1`,
      `UPDATE outbound_delivery SET ai_draft_id = NULL WHERE id = $1`,
      `UPDATE outbound_delivery SET hold_seconds = 0 WHERE id = $1`,
      `DELETE FROM outbound_delivery WHERE id = $1`,
    ]) {
      await rejects(app.query(sql, [id]), INSUFFICIENT_PRIVILEGE);
    }
  });
});

describe('0010 ai_draft', () => {
  it('computes the content hash itself, whatever the insert says, and the text never changes', async () => {
    const f = await fixture();
    const { rows } = await app.query<{ id: string; content_hash: string }>(
      `INSERT INTO ai_draft (ticket_id, body_text, content_hash) VALUES ($1, 'Thai สวัสดี', $2) RETURNING id, content_hash`,
      [f.ticketId, HASH],
    );
    const expected = await owner().query<{ h: string }>(
      `SELECT encode(sha256(convert_to('Thai สวัสดี', 'UTF8')), 'hex') AS h`,
    );
    expect(rows[0]?.content_hash).toBe(expected.rows[0]?.h);
    expect(rows[0]?.content_hash).not.toBe(HASH);
    await rejects(
      app.query(`UPDATE ai_draft SET body_text = 'other' WHERE id = $1`, [rows[0]?.id]),
      INSUFFICIENT_PRIVILEGE,
    );
    await rejects(
      app.query(`UPDATE ai_draft SET content_hash = $2 WHERE id = $1`, [rows[0]?.id, HASH]),
      INSUFFICIENT_PRIVILEGE,
    );
    await rejects(
      app.query(`DELETE FROM ai_draft WHERE id = $1`, [rows[0]?.id]),
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('is approved only with a person and a time, and an empty text is refused', async () => {
    const f = await fixture();
    const { rows } = await app.query<{ id: string }>(
      `INSERT INTO ai_draft (ticket_id, body_text) VALUES ($1, 'x') RETURNING id`,
      [f.ticketId],
    );
    await rejects(
      app.query(`UPDATE ai_draft SET status = 'approved' WHERE id = $1`, [rows[0]?.id]),
      PG.checkViolation,
    );
    await rejects(
      app.query(`UPDATE ai_draft SET approved_by = gen_random_uuid() WHERE id = $1`, [rows[0]?.id]),
      PG.checkViolation,
    );
    await app.query(
      `UPDATE ai_draft SET status = 'approved', approved_by = gen_random_uuid(), approved_at = now() WHERE id = $1`,
      [rows[0]?.id],
    );
    await rejects(
      app.query(`INSERT INTO ai_draft (ticket_id, body_text) VALUES ($1, '')`, [f.ticketId]),
      PG.checkViolation,
    );
  });
});

describe('0010 settings, quota and message changes', () => {
  it('seeds the undo-send setting at 5 seconds and keeps it between 0 and 30', async () => {
    const { rows } = await owner().query<{ value: number }>(
      `SELECT value FROM instance_setting WHERE key = 'outbound.undo_send_seconds'`,
    );
    expect(rows[0]?.value).toBe(5);
    for (const good of ['0', '30', '12']) {
      await app.query(
        `UPDATE instance_setting SET value = $1::jsonb WHERE key = 'outbound.undo_send_seconds'`,
        [good],
      );
    }
    for (const bad of ['31', '-1', '2.5', '"5"', 'null', '100', 'true']) {
      await rejects(
        app.query(
          `UPDATE instance_setting SET value = $1::jsonb WHERE key = 'outbound.undo_send_seconds'`,
          [bad],
        ),
        PG.checkViolation,
      );
    }
    await rejects(
      app.query(`INSERT INTO instance_setting (key, value) VALUES ('x', '1'::jsonb)`),
      INSUFFICIENT_PRIVILEGE,
    );
    await rejects(app.query(`DELETE FROM instance_setting`), INSUFFICIENT_PRIVILEGE);
    await rejects(app.query(`UPDATE instance_setting SET key = 'y'`), INSUFFICIENT_PRIVILEGE);
  });

  it('counts LINE pushes per account and month and refuses nonsense', async () => {
    const f = await fixture();
    await app.query(
      `INSERT INTO channel_quota_usage (channel_account_id, period, quota_limit) VALUES ($1, '2030-01', 300)`,
      [f.accountId],
    );
    await rejects(
      app.query(
        `INSERT INTO channel_quota_usage (channel_account_id, period) VALUES ($1, '2030-01')`,
        [f.accountId],
      ),
      PG.uniqueViolation,
    );
    await rejects(
      app.query(
        `INSERT INTO channel_quota_usage (channel_account_id, period) VALUES ($1, '2030-13')`,
        [f.accountId],
      ),
      PG.checkViolation,
    );
    await rejects(app.query(`UPDATE channel_quota_usage SET used = -1`), PG.checkViolation);
    await app.query(
      `UPDATE channel_quota_usage SET used = used + 1 WHERE channel_account_id = $1`,
      [f.accountId],
    );
    await rejects(app.query(`DELETE FROM channel_quota_usage`), INSUFFICIENT_PRIVILEGE);
  });

  it('adds the scheduled and cancelled delivery states to message, and lets the application set the provider ids only', async () => {
    const f = await fixture();
    for (const status of [
      'scheduled',
      'delivered',
      'cancelled',
      'failed',
      'pending',
      'not_applicable',
    ]) {
      await app.query(`UPDATE message SET delivery_status = $2 WHERE id = $1`, [
        f.messageId,
        status,
      ]);
    }
    await rejects(
      app.query(`UPDATE message SET delivery_status = 'sent' WHERE id = $1`, [f.messageId]),
      PG.checkViolation,
    );
    await app.query(
      `UPDATE message SET external_id = 'g-1', thread_key = 'gmail:t-1' WHERE id = $1`,
      [f.messageId],
    );
    await rejects(
      app.query(`UPDATE message SET body_text = 'x' WHERE id = $1`, [f.messageId]),
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('keeps the LINE reply token in a column the application can only clear or set', async () => {
    const f = await fixture();
    const { rows } = await owner().query<{ id: string }>(
      `INSERT INTO inbound_message (channel_account_id, provider_message_id, received_at, disposition, ticket_id)
       VALUES ($1, 'l-1', now(), 'appended', $2) RETURNING id`,
      [f.accountId, f.ticketId],
    );
    await app.query(`UPDATE inbound_message SET reply_token_sealed = 'sealed' WHERE id = $1`, [
      rows[0]?.id,
    ]);
    await app.query(`UPDATE inbound_message SET reply_token_sealed = NULL WHERE id = $1`, [
      rows[0]?.id,
    ]);
    await rejects(
      app.query(`UPDATE inbound_message SET body_text = 'x' WHERE id = $1`, [rows[0]?.id]),
      INSUFFICIENT_PRIVILEGE,
    );
  });
});

describe('0010 revert', () => {
  it('goes down and up again, mapping the new delivery states onto the old ones', async () => {
    const f = await fixture();
    await owner().query(`UPDATE message SET delivery_status = 'cancelled' WHERE id = $1`, [
      f.messageId,
    ]);
    const later = await migrationsAfter('0010_outbound_delivery');
    const reverted = await migrateDown(owner(), { steps: 1 + later.length });
    expect(reverted).toEqual([...later.toReversed(), '0010_outbound_delivery']);
    const gone = await owner().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class
        WHERE relname IN ('outbound_delivery', 'ai_draft', 'channel_quota_usage', 'instance_setting', 'ai_draft_set_hash')`,
    );
    expect(gone.rows[0]?.n).toBe(0);
    const fn = await owner().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'ai_draft_set_hash'`,
    );
    expect(fn.rows[0]?.n).toBe(0);
    const column = await owner().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'inbound_message' AND column_name = 'reply_token_sealed'`,
    );
    expect(column.rows[0]?.n).toBe(0);
    const message = await owner().query<{ delivery_status: string }>(
      `SELECT delivery_status FROM message WHERE id = $1`,
      [f.messageId],
    );
    expect(message.rows[0]?.delivery_status).toBe('failed');

    expect(await migrateUp(owner())).toEqual(['0010_outbound_delivery', ...later]);
    const back = await owner().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('outbound_delivery', 'ai_draft', 'channel_quota_usage', 'instance_setting')`,
    );
    expect(back.rows[0]?.n).toBe(4);
  });
});
