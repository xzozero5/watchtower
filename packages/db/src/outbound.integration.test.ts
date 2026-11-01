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

const INTEGRITY = '23000'; // the guard triggers of migration 0010
const PERSON = '00000000-0000-4000-8000-000000000001';
const OTHER_PERSON = '00000000-0000-4000-8000-000000000002';

interface DeliveryExtra {
  readonly origin?: string;
  readonly createdBy?: string | null;
  readonly template?: string | null;
  readonly renderInputs?: string | null;
  readonly draft?: string | null;
  readonly approvedBy?: string | null;
  readonly state?: string;
  readonly hash?: string;
}

// Everything below runs as the application role: the guards must hold for the one that can be wrong.
const insertDelivery = (pool: Pool, f: Fixture, extra: DeliveryExtra = {}) =>
  pool.query<{ id: string }>(
    `INSERT INTO outbound_delivery
       (ticket_id, message_id, channel_account_id, channel, origin, template_key, render_inputs, ai_draft_id,
        approved_by, content_hash, hold_seconds, next_attempt_at, created_by, state)
     VALUES ($1, $2, $3, 'gmail', $4, $5, $6::jsonb, $7, $8, $9, 5, now(), $10, $11)
     RETURNING id`,
    [
      f.ticketId,
      f.messageId,
      f.accountId,
      extra.origin ?? 'human',
      extra.template ?? null,
      extra.renderInputs ?? null,
      extra.draft ?? null,
      extra.approvedBy ?? null,
      extra.hash ?? HASH,
      extra.createdBy === undefined ? PERSON : extra.createdBy,
      extra.state ?? 'scheduled',
    ],
  );

const claim = (id: string) =>
  app.query(
    `UPDATE outbound_delivery
        SET state = 'sending', attempts = attempts + 1, claim_token = gen_random_uuid(),
            lease_until = now() + interval '2 minutes', updated_at = now()
      WHERE id = $1`,
    [id],
  );

async function approvedDraft(f: Fixture, by: string = PERSON): Promise<string> {
  const draft = await app.query<{ id: string }>(
    `INSERT INTO ai_draft (ticket_id, body_text) VALUES ($1, 'hello') RETURNING id`,
    [f.ticketId],
  );
  const id = draft.rows[0]?.id ?? '';
  await app.query(
    `UPDATE ai_draft SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
    [id, by],
  );
  return id;
}

const SAFE_INPUTS = JSON.stringify({
  ticketKey: 'OPS-1',
  portalUrl: null,
  firstResponseDueAt: null,
});

describe('0010 outbound_delivery', () => {
  it('allows one active delivery per message; a failed or cancelled one makes room for another', async () => {
    const f = await fixture();
    const first = (await insertDelivery(app, f)).rows[0]?.id;
    await rejects(insertDelivery(app, f), PG.uniqueViolation);
    await app.query(
      `UPDATE outbound_delivery SET state = 'cancelled', cancelled_at = now() WHERE id = $1`,
      [first],
    );
    const second = (await insertDelivery(app, f)).rows[0]?.id;
    await claim(second ?? '');
    await app.query(
      `UPDATE outbound_delivery SET state = 'failed', error_code = 'x' WHERE id = $1`,
      [second],
    );
    await insertDelivery(app, f);
  });

  it('computes the content hash from the message itself, whatever the insert says', async () => {
    const f = await fixture();
    const id = (await insertDelivery(app, f, { hash: 'f'.repeat(64) })).rows[0]?.id;
    const { rows } = await owner().query<{ content_hash: string; expected: string }>(
      `SELECT d.content_hash, encode(sha256(convert_to(m.body_text, 'UTF8')), 'hex') AS expected
         FROM outbound_delivery d JOIN message m ON m.id = d.message_id WHERE d.id = $1`,
      [id],
    );
    expect(rows[0]?.content_hash).toBe(rows[0]?.expected);
    expect(rows[0]?.content_hash).not.toBe('f'.repeat(64));
  });

  it('has no ai_auto origin: the database refuses what Phase 1 must never send', async () => {
    const f = await fixture();
    await rejects(insertDelivery(app, f, { origin: 'ai_auto' }), PG.checkViolation);
  });

  it('starts a delivery scheduled and empty', async () => {
    const f = await fixture();
    await rejects(insertDelivery(app, f, { state: 'sent' }), INTEGRITY);
    await rejects(insertDelivery(app, f, { state: 'sending' }), INTEGRITY);
    await rejects(
      app.query(
        `INSERT INTO outbound_delivery (ticket_id, message_id, channel_account_id, channel, origin, content_hash,
           hold_seconds, next_attempt_at, created_by, attempts)
         VALUES ($1, $2, $3, 'gmail', 'human', $4, 5, now(), $5, 3)`,
        [f.ticketId, f.messageId, f.accountId, HASH, PERSON],
      ),
      INTEGRITY,
    );
  });

  it('refuses a message that is not a public outbound message of that ticket and account', async () => {
    const f = await fixture();
    const g = await fixture();
    await rejects(insertDelivery(app, { ...f, messageId: g.messageId }), INTEGRITY);
    await rejects(insertDelivery(app, { ...f, accountId: g.accountId }), INTEGRITY);
  });

  it('ties ai_approved to a draft approved for exactly this text by the sender', async () => {
    const f = await fixture();
    // Not approved yet.
    const waiting = await app.query<{ id: string }>(
      `INSERT INTO ai_draft (ticket_id, body_text) VALUES ($1, 'hello') RETURNING id`,
      [f.ticketId],
    );
    await rejects(
      insertDelivery(app, f, {
        origin: 'ai_approved',
        draft: waiting.rows[0]?.id,
        approvedBy: PERSON,
      }),
      INTEGRITY,
    );
    // Approved by somebody else than the sender.
    const theirs = await approvedDraft(f, OTHER_PERSON);
    await rejects(
      insertDelivery(app, f, { origin: 'ai_approved', draft: theirs, approvedBy: PERSON }),
      INTEGRITY,
    );
    await rejects(
      insertDelivery(app, f, {
        origin: 'ai_approved',
        draft: theirs,
        approvedBy: OTHER_PERSON,
        createdBy: PERSON,
      }),
      INTEGRITY,
    );
    // Approved for a different text than the message.
    const other = await owner().query<{ id: string }>(
      `INSERT INTO ai_draft (ticket_id, body_text, status, approved_by, approved_at)
       VALUES ($1, 'something else', 'approved', $2, now()) RETURNING id`,
      [f.ticketId, PERSON],
    );
    await rejects(
      insertDelivery(app, f, {
        origin: 'ai_approved',
        draft: other.rows[0]?.id,
        approvedBy: PERSON,
      }),
      INTEGRITY,
    );
    // A draft of another ticket.
    const g = await fixture();
    const foreign = await approvedDraft(g);
    await rejects(
      insertDelivery(app, f, { origin: 'ai_approved', draft: foreign, approvedBy: PERSON }),
      INTEGRITY,
    );
    // The real thing.
    const mine = await approvedDraft(f);
    await insertDelivery(app, f, { origin: 'ai_approved', draft: mine, approvedBy: PERSON });
  });

  it('lets only keys on the safe list through as a template, and ties the origins to their fields', async () => {
    const f = await fixture();
    await rejects(
      insertDelivery(app, f, {
        origin: 'system_template',
        template: 'custom.sales_pitch',
        createdBy: null,
        renderInputs: SAFE_INPUTS,
      }),
      INTEGRITY,
    );
    await rejects(
      insertDelivery(app, f, {
        origin: 'system_template',
        template: 'auto_ack.received',
        createdBy: null,
      }),
      PG.checkViolation,
    );
    await rejects(
      insertDelivery(app, f, {
        origin: 'system_template',
        template: 'auto_ack.received',
        renderInputs: SAFE_INPUTS,
      }),
      PG.checkViolation,
    );
    await rejects(insertDelivery(app, f, { template: 'auto_ack.received' }), PG.checkViolation);
    await insertDelivery(app, f, {
      origin: 'system_template',
      template: 'auto_ack.received',
      createdBy: null,
      renderInputs: SAFE_INPUTS,
    });
    const rows = await owner().query<{ key: string }>(
      `SELECT key FROM outbound_template_allowlist ORDER BY key`,
    );
    expect(rows.rows.map((row) => row.key)).toEqual([
      'auto_ack.received',
      'auto_ack.received_with_sla',
    ]);
    await rejects(
      app.query(`INSERT INTO outbound_template_allowlist (key) VALUES ('custom.sales_pitch')`),
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('sends a draft once: a second active delivery for the same draft is a conflict', async () => {
    const f = await fixture();
    const second = await fixture();
    const draft = await approvedDraft(f);
    await insertDelivery(app, f, { origin: 'ai_approved', draft, approvedBy: PERSON });
    await rejects(
      insertDelivery(app, second, { origin: 'ai_approved', draft, approvedBy: PERSON }),
      INTEGRITY,
    );
  });

  it('keeps the state and its evidence together', async () => {
    const g = await fixture();
    for (const bad of [
      `hold_seconds = 31`,
      `hold_seconds = -1`,
      `content_hash = 'nope'`,
      `route = 'line_push'`,
      `channel = 'portal'`,
      `attempts = -1`,
    ]) {
      const id = (await insertDelivery(app, g)).rows[0]?.id;
      await rejects(
        owner().query(`UPDATE outbound_delivery SET ${bad} WHERE id = $1`, [id]),
        PG.checkViolation,
      );
      await owner().query(`DELETE FROM outbound_delivery WHERE id = $1`, [id]);
    }
  });

  it('enforces the state machine for the application too: no sent -> scheduled, no skipping the claim', async () => {
    const f = await fixture();
    const id = (await insertDelivery(app, f)).rows[0]?.id ?? '';
    // scheduled -> sent skips the claim; a claim must count an attempt and carry a token.
    await rejects(
      app.query(`UPDATE outbound_delivery SET state = 'sent', sent_at = now() WHERE id = $1`, [id]),
      INTEGRITY,
    );
    await rejects(
      app.query(
        `UPDATE outbound_delivery SET state = 'sending', attempts = attempts + 1, lease_until = now() WHERE id = $1`,
        [id],
      ),
      INTEGRITY,
    );
    await rejects(
      app.query(
        `UPDATE outbound_delivery SET state = 'sending', claim_token = gen_random_uuid(), lease_until = now() WHERE id = $1`,
        [id],
      ),
      INTEGRITY,
    );
    await claim(id);
    // A release clears the token.
    await rejects(
      app.query(
        `UPDATE outbound_delivery SET state = 'scheduled', lease_until = NULL WHERE id = $1`,
        [id],
      ),
      INTEGRITY,
    );
    await app.query(
      `UPDATE outbound_delivery SET state = 'sent', sent_at = now(), lease_until = NULL WHERE id = $1`,
      [id],
    );
    for (const to of ['scheduled', 'sending', 'failed', 'cancelled']) {
      await rejects(
        app.query(
          `UPDATE outbound_delivery SET state = $2, error_code = 'x', cancelled_at = now(), lease_until = now() WHERE id = $1`,
          [id, to],
        ),
        INTEGRITY,
      );
    }
    // Not even a field of a sent delivery changes.
    await rejects(
      app.query(`UPDATE outbound_delivery SET attempts = 9 WHERE id = $1`, [id]),
      INTEGRITY,
    );
  });

  it('lets a failed delivery change only to sent, and only after an unknown outcome', async () => {
    const f = await fixture();
    const certain = (await insertDelivery(app, f)).rows[0]?.id ?? '';
    await claim(certain);
    await app.query(
      `UPDATE outbound_delivery SET state = 'failed', error_code = 'x' WHERE id = $1`,
      [certain],
    );
    await rejects(
      app.query(`UPDATE outbound_delivery SET state = 'sent', sent_at = now() WHERE id = $1`, [
        certain,
      ]),
      INTEGRITY,
    );
    const g = await fixture();
    const unknown = (await insertDelivery(app, g)).rows[0]?.id ?? '';
    await claim(unknown);
    await app.query(
      `UPDATE outbound_delivery SET state = 'failed', error_code = 'x', outcome_unknown = true WHERE id = $1`,
      [unknown],
    );
    await rejects(
      app.query(
        `UPDATE outbound_delivery SET state = 'scheduled', claim_token = NULL WHERE id = $1`,
        [unknown],
      ),
      INTEGRITY,
    );
    await app.query(`UPDATE outbound_delivery SET state = 'sent', sent_at = now() WHERE id = $1`, [
      unknown,
    ]);
  });

  it('lets the application move the state but never change who, what or where', async () => {
    const f = await fixture();
    const id = (await insertDelivery(app, f)).rows[0]?.id;
    await claim(id ?? '');
    for (const sql of [
      `UPDATE outbound_delivery SET content_hash = '${'b'.repeat(64)}' WHERE id = $1`,
      `UPDATE outbound_delivery SET origin = 'human' WHERE id = $1`,
      `UPDATE outbound_delivery SET message_id = gen_random_uuid() WHERE id = $1`,
      `UPDATE outbound_delivery SET approved_by = gen_random_uuid() WHERE id = $1`,
      `UPDATE outbound_delivery SET ai_draft_id = NULL WHERE id = $1`,
      `UPDATE outbound_delivery SET render_inputs = '{}'::jsonb WHERE id = $1`,
      `UPDATE outbound_delivery SET hold_seconds = 0 WHERE id = $1`,
      `DELETE FROM outbound_delivery WHERE id = $1`,
    ]) {
      await rejects(app.query(sql, [id]), INSUFFICIENT_PRIVILEGE);
    }
  });
});

describe('0010 ai_draft status rules', () => {
  it('moves draft -> approved -> draft | sent, and nothing leaves sent or rejected', async () => {
    const f = await fixture();
    const id = (
      await app.query<{ id: string }>(
        `INSERT INTO ai_draft (ticket_id, body_text) VALUES ($1, 'x') RETURNING id`,
        [f.ticketId],
      )
    ).rows[0]?.id;
    await app.query(
      `UPDATE ai_draft SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
      [id, PERSON],
    );
    // The approval of an approved draft cannot be swapped.
    await rejects(
      app.query(`UPDATE ai_draft SET approved_by = $2 WHERE id = $1`, [id, OTHER_PERSON]),
      INTEGRITY,
    );
    await app.query(
      `UPDATE ai_draft SET status = 'draft', approved_by = NULL, approved_at = NULL WHERE id = $1`,
      [id],
    );
    await app.query(
      `UPDATE ai_draft SET status = 'sent', approved_by = $2, approved_at = now() WHERE id = $1`,
      [id, PERSON],
    );
    for (const status of ['draft', 'approved', 'rejected']) {
      await rejects(
        app.query(
          `UPDATE ai_draft SET status = $2, approved_by = $3, approved_at = now() WHERE id = $1`,
          [id, status, PERSON],
        ),
        INTEGRITY,
      );
    }
    const rejected = (
      await app.query<{ id: string }>(
        `INSERT INTO ai_draft (ticket_id, body_text) VALUES ($1, 'y') RETURNING id`,
        [f.ticketId],
      )
    ).rows[0]?.id;
    await app.query(`UPDATE ai_draft SET status = 'rejected' WHERE id = $1`, [rejected]);
    await rejects(
      app.query(`UPDATE ai_draft SET status = 'draft' WHERE id = $1`, [rejected]),
      INTEGRITY,
    );
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
