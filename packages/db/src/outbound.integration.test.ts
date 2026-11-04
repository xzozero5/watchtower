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
const PERSON = '00000000-0000-4000-8000-000000000001';
const OTHER_PERSON = '00000000-0000-4000-8000-000000000002';

let testDb: TestDatabase;
let app: Pool;
const owner = (): Pool => testDb.owner.pool;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
  // The people the fixtures write messages as (message.sender_user_id is a real foreign key).
  await owner().query(
    `INSERT INTO users (id, email, name, role) VALUES
       ($1, 'sender@example.com', 'Sender', 'agent'), ($2, 'other@example.com', 'Other', 'agent')`,
    [PERSON, OTHER_PERSON],
  );
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

interface FixtureOptions {
  /** The message text; default 'hello'. */
  readonly body?: string;
  /** Who wrote the message; default PERSON, null for none (an automatic or AI-authored one). */
  readonly sender?: string | null;
  readonly accountType?: 'gmail' | 'line';
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const accountType = options.accountType ?? 'gmail';
  const account = await owner().query<{ id: string }>(
    `INSERT INTO channel_account (type, name) VALUES ($1, 'Support') RETURNING id`,
    [accountType],
  );
  const org = await owner().query<{ id: string }>(
    `INSERT INTO organization (name) VALUES ('Org ' || gen_random_uuid()) RETURNING id`,
  );
  const ticket = await owner().query<{ id: string }>(
    `INSERT INTO ticket (subject, org_id, channel, channel_account_id)
     VALUES ('s', $1, $3, $2) RETURNING id`,
    [org.rows[0]?.id, account.rows[0]?.id, accountType],
  );
  const message = await owner().query<{ id: string }>(
    `INSERT INTO message (ticket_id, channel_account_id, direction, body_text, visibility, delivery_status, sender_user_id)
     VALUES ($1, $2, 'outbound', $3, 'public', 'scheduled', $4) RETURNING id`,
    [
      ticket.rows[0]?.id,
      account.rows[0]?.id,
      options.body ?? 'hello',
      options.sender === undefined ? PERSON : options.sender,
    ],
  );
  return {
    ticketId: ticket.rows[0]?.id ?? '',
    messageId: message.rows[0]?.id ?? '',
    accountId: account.rows[0]?.id ?? '',
  };
}

const INTEGRITY = '23000'; // the guard triggers of migrations 0013 and 0014

interface DeliveryExtra {
  readonly origin?: string;
  readonly createdBy?: string | null;
  readonly template?: string | null;
  readonly renderInputs?: string | null;
  readonly draft?: string | null;
  readonly approvedBy?: string | null;
  readonly state?: string;
  readonly hash?: string;
  readonly channel?: string;
}

// Everything below runs as the application role: the guards must hold for the one that can be wrong.
const insertDelivery = (pool: Pool, f: Fixture, extra: DeliveryExtra = {}) =>
  pool.query<{ id: string }>(
    `INSERT INTO outbound_delivery
       (ticket_id, message_id, channel_account_id, channel, origin, template_key, render_inputs, ai_draft_id,
        approved_by, content_hash, hold_seconds, next_attempt_at, created_by, state)
     VALUES ($1, $2, $3, $12, $4, $5, $6::jsonb, $7, $8, $9, 5, now(), $10, $11)
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
      extra.channel ?? 'gmail',
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
// What the domain renders for auto_ack.received with no portal link (templates.ts); the migration's
// body_pattern must accept it (the domain test renders every key against the stored pattern).
const ACK_BODY =
  'We have received your request and filed it as OPS-1. Our team will review it and reply here.' +
  '\n\n' +
  'เราได้รับเรื่องของคุณแล้ว และบันทึกเป็นหมายเลข OPS-1 ทีมงานจะตรวจสอบและตอบกลับที่นี่';

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

  it('refuses ai_auto without an auto-approved draft and a grade (stage 3 rules: stage3-autosend.integration.test.ts)', async () => {
    const f = await fixture();
    await rejects(insertDelivery(app, f, { origin: 'ai_auto' }), INTEGRITY);
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
    const f = await fixture({ body: ACK_BODY, sender: null });
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
    const person = await fixture();
    await rejects(
      insertDelivery(app, person, { template: 'auto_ack.received' }),
      PG.checkViolation,
    );
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

describe('0014 who wrote the message (N-1)', () => {
  it('refuses a human or ai_approved delivery whose message has no author or another author', async () => {
    // An AI-authored message has no sender_user_id; pairing it with a person's origin must fail.
    const aiWritten = await fixture({ sender: null });
    await rejects(insertDelivery(app, aiWritten), INTEGRITY);
    await rejects(insertDelivery(app, aiWritten, { createdBy: OTHER_PERSON }), INTEGRITY);
    const draft = await approvedDraft(aiWritten);
    await rejects(
      insertDelivery(app, aiWritten, { origin: 'ai_approved', draft, approvedBy: PERSON }),
      INTEGRITY,
    );
    // Written by one person, sent as another.
    const theirs = await fixture({ sender: OTHER_PERSON });
    await rejects(insertDelivery(app, theirs), INTEGRITY);
    // Written and sent by the same person.
    const mine = await fixture();
    await insertDelivery(app, mine);
  });

  it('refuses an automatic delivery whose message has an author, a contact or HTML', async () => {
    const inputs = {
      origin: 'system_template',
      template: 'auto_ack.received',
      createdBy: null,
      renderInputs: SAFE_INPUTS,
    } as const;
    const authored = await fixture({ body: ACK_BODY, sender: PERSON });
    await rejects(insertDelivery(app, authored, inputs), INTEGRITY);
    const html = await fixture({ body: ACK_BODY, sender: null });
    await owner().query(`UPDATE message SET body_html = '<b>x</b>' WHERE id = $1`, [
      html.messageId,
    ]);
    await rejects(insertDelivery(app, html, inputs), INTEGRITY);
    const clean = await fixture({ body: ACK_BODY, sender: null });
    await insertDelivery(app, clean, inputs);
  });
});

describe('0014 template deliveries carry no free text (N-3)', () => {
  const inputs = (renderInputs: string) =>
    ({
      origin: 'system_template',
      template: 'auto_ack.received',
      createdBy: null,
      renderInputs,
    }) as const;
  const SLA_TAIL =
    '\n\nWe aim to reply by 2026-11-02 09:30 (UTC+7).\n\nเราตั้งเป้าตอบกลับภายใน 2026-11-02 09:30 (UTC+7)';

  it('refuses a body that is not the text of the key, even with a valid-looking key', async () => {
    const pitch = await fixture({
      body: `${ACK_BODY}\n\nBuy our premium plan today: https://example.com/offer`,
      sender: null,
    });
    await rejects(insertDelivery(app, pitch, inputs(SAFE_INPUTS)), INTEGRITY);
    const other = await fixture({ body: 'We have received your request. Pay us.', sender: null });
    await rejects(insertDelivery(app, other, inputs(SAFE_INPUTS)), INTEGRITY);
    // The plain key refuses the SLA text; the SLA key accepts it.
    const sla = await fixture({ body: ACK_BODY + SLA_TAIL, sender: null });
    await rejects(insertDelivery(app, sla, inputs(SAFE_INPUTS)), INTEGRITY);
    await insertDelivery(app, sla, {
      ...inputs(
        JSON.stringify({
          ticketKey: 'OPS-1',
          portalUrl: null,
          firstResponseDueAt: '2026-11-02T02:30:00.000Z',
        }),
      ),
      template: 'auto_ack.received_with_sla',
    });
  });

  it('refuses stored inputs that are not plain facts shown in the text', async () => {
    const url = 'https://portal.example/portal';
    const body = ACK_BODY.replace('reply here.', `reply here. You can follow it at ${url}`).replace(
      'ตอบกลับที่นี่',
      `ตอบกลับที่นี่ ติดตามสถานะได้ที่ ${url}`,
    );
    const f = await fixture({ body, sender: null });
    for (const bad of [
      { ticketKey: 'OPS-1', portalUrl: url, firstResponseDueAt: null, note: 'Wire money to X' },
      { ticketKey: 'ops-1', portalUrl: null, firstResponseDueAt: null },
      { ticketKey: 'OPS-1', portalUrl: 'javascript:alert(1)', firstResponseDueAt: null },
      { ticketKey: 'OPS-1', portalUrl: 'https://elsewhere.example/', firstResponseDueAt: null },
      { ticketKey: 'OPS-1', portalUrl: null, firstResponseDueAt: 'tomorrow' },
      { ticketKey: 'OPS-2', portalUrl: null, firstResponseDueAt: null },
    ]) {
      await rejects(insertDelivery(app, f, inputs(JSON.stringify(bad))), INTEGRITY);
    }
    await insertDelivery(
      app,
      f,
      inputs(JSON.stringify({ ticketKey: 'OPS-1', portalUrl: url, firstResponseDueAt: null })),
    );
  });
});

describe('0014 the channel is the type of the account (N-3)', () => {
  it('refuses a delivery whose channel is not the type of its channel account', async () => {
    const gmail = await fixture({ accountType: 'gmail' });
    await rejects(insertDelivery(app, gmail, { channel: 'line' }), INTEGRITY);
    const lineAccount = await fixture({ accountType: 'line' });
    await rejects(insertDelivery(app, lineAccount, { channel: 'gmail' }), INTEGRITY);
    await insertDelivery(app, lineAccount, { channel: 'line' });
  });
});

describe('0014 claim and release rules (N-3)', () => {
  const dispatch = (id: string, route: string) =>
    app.query(`UPDATE outbound_delivery SET route = $2, dispatched_at = now() WHERE id = $1`, [
      id,
      route,
    ]);
  const releaseSql = (extra: string) =>
    `UPDATE outbound_delivery
        SET state = 'scheduled', claim_token = NULL, lease_until = NULL, dispatched_at = NULL ${extra}
      WHERE id = $1`;

  it('forbids changing the claim token while sending, or setting one on a scheduled row', async () => {
    const f = await fixture();
    const id = (await insertDelivery(app, f)).rows[0]?.id ?? '';
    const retoken = `UPDATE outbound_delivery SET claim_token = gen_random_uuid() WHERE id = $1`;
    await rejects(app.query(retoken, [id]), INTEGRITY);
    await claim(id);
    await rejects(app.query(retoken, [id]), INTEGRITY);
    await rejects(
      app.query(`UPDATE outbound_delivery SET claim_token = NULL WHERE id = $1`, [id]),
      INTEGRITY,
    );
    // Swapping it while finishing is the same thing.
    await rejects(
      app.query(
        `UPDATE outbound_delivery SET state = 'sent', sent_at = now(), claim_token = gen_random_uuid() WHERE id = $1`,
        [id],
      ),
      INTEGRITY,
    );
    // The paths that exist leave it alone: dispatch, then finish.
    await dispatch(id, 'gmail_new');
    await app.query(
      `UPDATE outbound_delivery SET state = 'failed', error_code = 'x' WHERE id = $1`,
      [id],
    );
  });

  it('counts attempts at a claim and nowhere else', async () => {
    const f = await fixture();
    const id = (await insertDelivery(app, f)).rows[0]?.id ?? '';
    await rejects(
      app.query(`UPDATE outbound_delivery SET attempts = 3 WHERE id = $1`, [id]),
      INTEGRITY,
    );
    await claim(id);
    await rejects(
      app.query(`UPDATE outbound_delivery SET attempts = 0 WHERE id = $1`, [id]),
      INTEGRITY,
    );
  });

  it('does not send a Gmail row that reached the provider back to scheduled, unless the provider refused it', async () => {
    const f = await fixture();
    const id = (await insertDelivery(app, f)).rows[0]?.id ?? '';
    await claim(id);
    await dispatch(id, 'gmail_new');
    // What a sweeper bug would do: no refusal on record.
    await rejects(app.query(releaseSql(''), [id]), INTEGRITY);
    await rejects(
      app.query(releaseSql(`, error_code = 'channel_rate_limited', outcome_unknown = true`), [id]),
      INTEGRITY,
    );
    // dispatched_at must be cleared by a release whatever else is true.
    await rejects(
      app.query(
        `UPDATE outbound_delivery SET state = 'scheduled', claim_token = NULL, lease_until = NULL, error_code = 'x' WHERE id = $1`,
        [id],
      ),
      INTEGRITY,
    );
    // The retry path: a refusal the provider gave, outcome known.
    await app.query(releaseSql(`, error_code = 'channel_rate_limited'`), [id]);
  });

  it('lets a LINE push, and a row that never reached the provider, go back to scheduled', async () => {
    const f = await fixture({ accountType: 'line' });
    const id = (await insertDelivery(app, f, { channel: 'line' })).rows[0]?.id ?? '';
    await claim(id);
    await app.query(releaseSql(''), [id]);
    await claim(id);
    await dispatch(id, 'line_push');
    await app.query(releaseSql(''), [id]);
    // A LINE reply is not repeatable (a row of its own: the route of a delivery is written once, T-122f).
    const g = await fixture({ accountType: 'line' });
    const replyId = (await insertDelivery(app, g, { channel: 'line' })).rows[0]?.id ?? '';
    await claim(replyId);
    await dispatch(replyId, 'line_reply');
    await rejects(app.query(releaseSql(''), [replyId]), INTEGRITY);
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
    const later = await migrationsAfter('0013_outbound_delivery');
    const reverted = await migrateDown(owner(), { steps: 1 + later.length });
    expect(reverted).toEqual([...later.toReversed(), '0013_outbound_delivery']);
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

    expect(await migrateUp(owner())).toEqual(['0013_outbound_delivery', ...later]);
    const back = await owner().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('outbound_delivery', 'ai_draft', 'channel_quota_usage', 'instance_setting')`,
    );
    expect(back.rows[0]?.n).toBe(4);
  });
});

describe('0014 revert', () => {
  it('goes down to the 0013 guard and the 0013 permissions, and up again', async () => {
    const f = await fixture({ sender: null });
    // Under 0014 an AI-authored message cannot be sent as a person's.
    await rejects(insertDelivery(app, f), INTEGRITY);

    const later = await migrationsAfter('0014_outbound_hardening');
    const reverted = await migrateDown(owner(), { steps: later.length + 1 });
    expect(reverted).toEqual([...later.toReversed(), '0014_outbound_hardening']);
    const column = await owner().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'outbound_template_allowlist' AND column_name = 'body_pattern'`,
    );
    expect(column.rows[0]?.n).toBe(0);
    const permission = await owner().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM permissions WHERE key = 'ticket.cancel.any'`,
    );
    expect(permission.rows[0]?.n).toBe(0);
    // The 0013 guard lets through exactly what 0014 refuses (the hole N-1 describes).
    const id = (await insertDelivery(app, f)).rows[0]?.id ?? '';
    await owner().query(`DELETE FROM outbound_delivery WHERE id = $1`, [id]);

    expect(await migrateUp(owner())).toEqual(['0014_outbound_hardening', ...later]);
    await rejects(insertDelivery(app, f), INTEGRITY);
    const back = await owner().query<{ role: string }>(
      `SELECT role FROM role_permissions WHERE permission = 'ticket.cancel.any' ORDER BY role`,
    );
    expect(back.rows.map((row) => row.role)).toEqual(['head', 'lead']);
  });
});
