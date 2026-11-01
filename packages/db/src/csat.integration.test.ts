import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PG, isPgError } from './errors.js';
import { loadMigrations, migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// The csat_survey migration (T-110): the constraints that keep a survey honest. A link works once,
// a skipped survey says why, and the application can record surveys but never delete one.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const INSUFFICIENT_PRIVILEGE = '42501';

let testDb: TestDatabase;
let app: Pool;
let orgId: string;
let contactId: string;
const owner = (): Pool => testDb.owner.pool;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
  const org = await owner().query<{ id: string }>(
    `INSERT INTO organization (name) VALUES ('Org') RETURNING id`,
  );
  orgId = org.rows[0]?.id ?? '';
  const contact = await owner().query<{ id: string }>(
    `INSERT INTO contact (org_id, name, emails) VALUES ($1, 'C', ARRAY['c@example.test']) RETURNING id`,
    [orgId],
  );
  contactId = contact.rows[0]?.id ?? '';
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

async function newTicket(): Promise<string> {
  const account = await owner().query<{ id: string }>(
    `SELECT id FROM channel_account WHERE type = 'portal'`,
  );
  const ticket = await owner().query<{ id: string }>(
    `INSERT INTO ticket (subject, org_id, channel, channel_account_id)
     VALUES ('s', $1, 'portal', $2) RETURNING id`,
    [orgId, account.rows[0]?.id],
  );
  return ticket.rows[0]?.id ?? '';
}

/** Inserts a survey on a fresh ticket; `columns` and `values` add to the required ones. */
async function insert(pool: Pool, columns = '', values: unknown[] = [], ticket?: string) {
  const ticketId = ticket ?? (await newTicket());
  const extra = columns === '' ? '' : `, ${columns}`;
  const marks = values.map((_, i) => `, $${String(i + 4)}`).join('');
  return pool.query<{ id: string }>(
    `INSERT INTO csat_survey (ticket_id, contact_id, org_id${extra}, send_after)
     VALUES ($1, $2, $3${marks}, now()) RETURNING id`,
    [ticketId, contactId, orgId, ...values],
  );
}

describe('csat_survey', () => {
  it('starts scheduled, by email, unanswered and not reopened', async () => {
    const { rows } = await owner().query<Record<string, unknown>>(
      `SELECT s.* FROM csat_survey s WHERE s.id = $1`,
      [(await insert(app)).rows[0]?.id],
    );
    expect(rows[0]).toMatchObject({
      status: 'scheduled',
      channel: 'email',
      score: null,
      sent_at: null,
      reopened: false,
    });
  });

  it('a ticket has one survey in flight, but an answered or voided one does not block the next', async () => {
    const ticket = await newTicket();
    const first = await insert(app, '', [], ticket);
    await rejects(insert(app, '', [], ticket), PG.uniqueViolation);
    await owner().query(
      `UPDATE csat_survey SET status = 'voided', reason = 'ticket_reopened' WHERE id = $1`,
      [first.rows[0]?.id],
    );
    const second = await insert(app, '', [], ticket);
    await owner().query(
      `UPDATE csat_survey SET status = 'answered', sent_at = now(), token_expires_at = now() + interval '1 day',
         answered_at = now(), score = 4 WHERE id = $1`,
      [second.rows[0]?.id],
    );
    await insert(app, '', [], ticket);
  });

  it('a survey that went out has a delivery time and a link lifetime', async () => {
    await rejects(insert(app, 'status', ['sent']), PG.checkViolation);
    await rejects(insert(app, 'status, sent_at', ['sent', new Date()]), PG.checkViolation);
    await insert(app, 'status, sent_at, token_expires_at', [
      'sent',
      new Date(),
      new Date(Date.now() + 86_400_000),
    ]);
  });

  it('a survey that did not go out has no delivery time', async () => {
    await rejects(insert(app, 'status, sent_at', ['scheduled', new Date()]), PG.checkViolation);
    await rejects(
      insert(app, 'status, reason, sent_at', ['skipped', 'org_opt_out', new Date()]),
      PG.checkViolation,
    );
  });

  it('an answer has a time and a score 1-5, and only an answer does', async () => {
    const sent = [new Date(), new Date(Date.now() + 86_400_000)];
    await rejects(
      insert(app, 'status, sent_at, token_expires_at', ['answered', ...sent]),
      PG.checkViolation,
    );
    await rejects(
      insert(app, 'status, sent_at, token_expires_at, answered_at, score', [
        'answered',
        ...sent,
        new Date(),
        6,
      ]),
      PG.checkViolation,
    );
    await rejects(
      insert(app, 'status, sent_at, token_expires_at, answered_at, score', [
        'answered',
        ...sent,
        new Date(),
        0,
      ]),
      PG.checkViolation,
    );
    await rejects(insert(app, 'score', [5]), PG.checkViolation);
    await rejects(insert(app, 'comment', ['text']), PG.checkViolation);
    await rejects(insert(app, 'reopened', [true]), PG.checkViolation);
    await insert(app, 'status, sent_at, token_expires_at, answered_at, score, resolved, comment', [
      'answered',
      ...sent,
      new Date(),
      5,
      true,
      'thanks',
    ]);
  });

  it('refuses a comment over 2000 characters', async () => {
    const sent = [new Date(), new Date(Date.now() + 86_400_000)];
    const columns = 'status, sent_at, token_expires_at, answered_at, score, comment';
    await rejects(
      insert(app, columns, ['answered', ...sent, new Date(), 3, 'x'.repeat(2001)]),
      PG.checkViolation,
    );
    await insert(app, columns, ['answered', ...sent, new Date(), 3, 'x'.repeat(2000)]);
  });

  it('a skipped or voided survey says why', async () => {
    await rejects(insert(app, 'status', ['skipped']), PG.checkViolation);
    await rejects(insert(app, 'status', ['voided']), PG.checkViolation);
    await insert(app, 'status, reason', ['skipped', 'contact_cooldown']);
    await insert(app, 'status, reason', ['voided', 'ticket_reopened']);
  });

  it('refuses an unknown status or channel', async () => {
    await rejects(insert(app, 'status', ['delivered']), PG.checkViolation);
    await rejects(insert(app, 'channel', ['sms']), PG.checkViolation);
    await insert(app, 'channel', ['line']);
  });

  it('the application records surveys and outcomes but cannot delete one', async () => {
    const row = await insert(app);
    const id = row.rows[0]?.id ?? '';
    await rejects(app.query(`DELETE FROM csat_survey WHERE id = $1`, [id]), INSUFFICIENT_PRIVILEGE);
  });
});

describe('csat_org_opt_out and the delay setting', () => {
  it('an opt-out is one row per organization, removed to opt back in', async () => {
    await app.query(`INSERT INTO csat_org_opt_out (org_id) VALUES ($1)`, [orgId]);
    await rejects(
      app.query(`INSERT INTO csat_org_opt_out (org_id) VALUES ($1)`, [orgId]),
      PG.uniqueViolation,
    );
    await rejects(
      app.query(`UPDATE csat_org_opt_out SET created_by = NULL WHERE org_id = $1`, [orgId]),
      INSUFFICIENT_PRIVILEGE,
    );
    await app.query(`DELETE FROM csat_org_opt_out WHERE org_id = $1`, [orgId]);
  });

  it('the delay setting defaults to 60 minutes and accepts 0 to 10080', async () => {
    const read = () =>
      owner().query<{ value: unknown }>(
        `SELECT value FROM instance_setting WHERE key = 'csat.delay_minutes'`,
      );
    expect((await read()).rows[0]?.value).toBe(60);
    await app.query(
      `UPDATE instance_setting SET value = '0'::jsonb WHERE key = 'csat.delay_minutes'`,
    );
    await app.query(
      `UPDATE instance_setting SET value = '10080'::jsonb WHERE key = 'csat.delay_minutes'`,
    );
    for (const bad of ['10081', '-1', '"60"', '1.5', 'null']) {
      await rejects(
        app.query(
          `UPDATE instance_setting SET value = $1::jsonb WHERE key = 'csat.delay_minutes'`,
          [bad],
        ),
        PG.checkViolation,
      );
    }
    await app.query(
      `UPDATE instance_setting SET value = '60'::jsonb WHERE key = 'csat.delay_minutes'`,
    );
  });
});

describe('migration', () => {
  it('goes down and up again', async () => {
    // Found by name, so renumbering the migration (or a later one) does not break this test.
    const own = (await loadMigrations()).find((m) => m.id.endsWith('_csat_survey'))?.id ?? '';
    expect(own).not.toBe('');
    const later = await migrationsAfter(own);
    const reverted = await migrateDown(owner(), { steps: 1 + later.length });
    expect(reverted).toEqual([...later.toReversed(), own]);
    const gone = await owner().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('csat_survey', 'csat_org_opt_out')`,
    );
    expect(gone.rows[0]?.n).toBe(0);
    const setting = await owner().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM instance_setting WHERE key = 'csat.delay_minutes'`,
    );
    expect(setting.rows[0]?.n).toBe(0);
    expect(await migrateUp(owner())).toEqual([own, ...later]);
  });
});
