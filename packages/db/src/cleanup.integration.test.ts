import { createHash, randomBytes } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { purgeExpired } from './cleanup.js';
import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// T-117 and migration 0011: deleting what has expired, as the restricted application role.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
let app: Pool;
let userId: string;
let ticketId: string;
let contactId: string;
const owner = () => testDb.owner.pool;

const token = () => randomBytes(24).toString('hex');
const sha = () => createHash('sha256').update(randomBytes(16)).digest('hex');

async function count(table: string, where = 'true'): Promise<number> {
  const result = await owner().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
  );
  return result.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 3 });
  const user = await owner().query<{ id: string }>(
    `INSERT INTO users (email, name, role) VALUES ('cleanup@example.com', 'Cleanup', 'agent') RETURNING id`,
  );
  userId = user.rows[0]?.id ?? '';
  const org = await owner().query<{ id: string }>(
    `INSERT INTO organization (name) VALUES ('Cleanup org') RETURNING id`,
  );
  const contact = await owner().query<{ id: string }>(
    `INSERT INTO contact (org_id, name, emails) VALUES ($1, 'C', ARRAY['c@example.com']) RETURNING id`,
    [org.rows[0]?.id],
  );
  contactId = contact.rows[0]?.id ?? '';
  const ticket = await owner().query<{ id: string }>(
    `INSERT INTO ticket (org_id, subject, requester_contact_id) VALUES ($1, 'S', $2) RETURNING id`,
    [org.rows[0]?.id, contactId],
  );
  ticketId = ticket.rows[0]?.id ?? '';
});
afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});
beforeEach(async () => {
  for (const table of [
    'refresh_tokens',
    'sessions',
    'magic_link_tokens',
    'portal_access_token',
    'break_glass_attempt',
  ]) {
    await owner().query(`DELETE FROM ${table}`);
  }
});

/** A session with the given expiry and revocation, relative to now. */
async function addSession(expires: string, revoked: string | null = null): Promise<string> {
  const result = await owner().query<{ id: string }>(
    `INSERT INTO sessions (user_id, auth_method, expires_at, revoked_at)
     VALUES ($1, 'dev', now() + $2::interval, CASE WHEN $3::text IS NULL THEN NULL ELSE now() + $3::interval END)
     RETURNING id`,
    [userId, expires, revoked],
  );
  return result.rows[0]?.id ?? '';
}

async function addRefresh(sessionId: string, expires: string): Promise<void> {
  await owner().query(
    `INSERT INTO refresh_tokens (session_id, token_hash, expires_at) VALUES ($1, $2, now() + $3::interval)`,
    [sessionId, token(), expires],
  );
}

describe('purgeExpired', () => {
  it('deletes sessions expired for longer than the retention, and keeps the rest', async () => {
    const expiredLong = await addSession('-10 days');
    const expiredRecently = await addSession('-2 days');
    const live = await addSession('3 days');
    const revokedLong = await addSession('3 days', '-9 days');
    const revokedRecently = await addSession('3 days', '-1 day');

    const result = await purgeExpired({ pool: app }, {});
    expect(result.sessions).toBe(2);
    expect(result.more).toBe(false);
    const left = await owner().query<{ id: string }>('SELECT id FROM sessions');
    expect(left.rows.map((row) => row.id).sort()).toEqual(
      [expiredRecently, live, revokedRecently].sort(),
    );
    expect(left.rows.map((row) => row.id)).not.toContain(expiredLong);
    expect(left.rows.map((row) => row.id)).not.toContain(revokedLong);
  });

  it('deletes refresh tokens past their expiry even when the session lives on, and with a deleted session', async () => {
    const live = await addSession('20 days');
    await addRefresh(live, '-8 days');
    await addRefresh(live, '2 days');
    const dead = await addSession('-9 days');
    await addRefresh(dead, '-9 days');
    await addRefresh(dead, '1 day');

    const result = await purgeExpired({ pool: app }, {});
    expect(result.refresh_tokens).toBe(2);
    expect(result.sessions).toBe(1);
    // The unexpired token of the dead session went with its session (ON DELETE CASCADE).
    expect(await count('refresh_tokens')).toBe(1);
    expect(await count('refresh_tokens', `session_id = '${live}'`)).toBe(1);
  });

  it('deletes magic links that expired or were used before the retention', async () => {
    const insert = (expires: string, consumed: string | null) =>
      owner().query(
        `INSERT INTO magic_link_tokens (user_id, token_hash, created_at, expires_at, consumed_at)
         VALUES ($1, $2, now() - interval '30 days', now() + $3::interval,
                 CASE WHEN $4::text IS NULL THEN NULL ELSE now() + $4::interval END)`,
        [userId, token(), expires, consumed],
      );
    await insert('-20 days', null); // expired long ago
    await insert('-1 day', null); // expired recently
    await insert('-20 days', '-21 days'); // used and expired long ago
    await insert('1 hour', '-9 days'); // used long ago
    await insert('1 hour', null); // open
    const result = await purgeExpired({ pool: app }, {});
    expect(result.magic_link_tokens).toBe(3);
    expect(await count('magic_link_tokens')).toBe(2);
    expect(await count('magic_link_tokens', 'consumed_at IS NULL')).toBe(2);
  });

  it('deletes tracking links that expired or were revoked before the retention', async () => {
    const insert = (expires: string, revoked: string | null) =>
      owner().query(
        `INSERT INTO portal_access_token (ticket_id, contact_id, token_hash, created_at, expires_at, revoked_at)
         VALUES ($1, $2, $3, now() - interval '60 days', now() + $4::interval,
                 CASE WHEN $5::text IS NULL THEN NULL ELSE now() + $5::interval END)`,
        [ticketId, contactId, sha(), expires, revoked],
      );
    await insert('-30 days', null);
    await insert('-3 days', null);
    await insert('10 days', '-8 days');
    await insert('10 days', '-1 day');
    await insert('10 days', null);
    const result = await purgeExpired({ pool: app }, {});
    expect(result.portal_access_token).toBe(2);
    expect(await count('portal_access_token')).toBe(3);
    // The ticket and the contact are untouched.
    expect(await count('ticket', `id = '${ticketId}'`)).toBe(1);
  });

  it('deletes old break-glass counters, but never one that still locks someone out', async () => {
    const other = await owner().query<{ id: string }>(
      `INSERT INTO users (email, name, role, is_break_glass, password_hash) VALUES ('bg@example.com', 'BG', 'head', true, 'not-a-real-hash') RETURNING id`,
    );
    const bg = other.rows[0]?.id ?? '';
    const insert = (ip: string, lastFailed: string, lockedUntil: string | null) =>
      owner().query(
        `INSERT INTO break_glass_attempt (user_id, ip, failed_count, last_failed_at, locked_until)
         VALUES ($1, $2, 3, now() + $3::interval, CASE WHEN $4::text IS NULL THEN NULL ELSE now() + $4::interval END)`,
        [bg, ip, lastFailed, lockedUntil],
      );
    await insert('10.0.0.1', '-40 days', null); // old
    await insert('10.0.0.2', '-40 days', '-39 days'); // old, lock over
    await insert('10.0.0.3', '-40 days', '1 hour'); // old but still locked
    await insert('10.0.0.4', '-2 days', null); // recent
    const result = await purgeExpired({ pool: app }, {});
    expect(result.break_glass_attempt).toBe(2);
    const left = await owner().query<{ ip: string }>(
      'SELECT ip FROM break_glass_attempt ORDER BY ip',
    );
    expect(left.rows.map((row) => row.ip)).toEqual(['10.0.0.3', '10.0.0.4']);
  });

  it('uses the retention it is given', async () => {
    await addSession('-2 days');
    expect((await purgeExpired({ pool: app }, { authRetentionDays: 7 })).sessions).toBe(0);
    expect((await purgeExpired({ pool: app }, { authRetentionDays: 1 })).sessions).toBe(1);
    await expect(purgeExpired({ pool: app }, { authRetentionDays: -1 })).rejects.toThrow(
      RangeError,
    );
    await expect(purgeExpired({ pool: app }, { batchSize: 0 })).rejects.toThrow(RangeError);
  });

  it('works through a backlog in batches, and says when it stopped early', async () => {
    await owner().query(
      `INSERT INTO sessions (user_id, auth_method, expires_at)
       SELECT $1, 'dev', now() - interval '30 days' FROM generate_series(1, 25)`,
      [userId],
    );
    const partial = await purgeExpired({ pool: app }, { batchSize: 10, maxBatches: 2 });
    expect(partial.sessions).toBe(20);
    expect(partial.more).toBe(true);
    expect(await count('sessions')).toBe(5);
    const rest = await purgeExpired({ pool: app }, { batchSize: 10, maxBatches: 2 });
    expect(rest.sessions).toBe(5);
    expect(rest.more).toBe(false);
    expect(await count('sessions')).toBe(0);
  });

  it('leaves live data, the outbox and the audit log alone, and is idempotent', async () => {
    await addSession('5 days');
    await owner().query(
      `INSERT INTO outbox (queue, job_name, job_id, payload, status, finished_at)
       VALUES ('email', 'send', 'cleanup-keep', '{}'::jsonb, 'sent', now() - interval '400 days')`,
    );
    const auditBefore = await count('audit_log');
    const result = await purgeExpired({ pool: app }, {});
    expect(result).toEqual({
      refresh_tokens: 0,
      sessions: 0,
      magic_link_tokens: 0,
      portal_access_token: 0,
      break_glass_attempt: 0,
      more: false,
    });
    expect(await count('sessions')).toBe(1);
    expect(await count('outbox', `job_id = 'cleanup-keep'`)).toBe(1);
    expect(await count('audit_log')).toBe(auditBefore);
    expect(await purgeExpired({ pool: app }, {})).toMatchObject({ sessions: 0, more: false });
  });
});

describe('0012_expiry_indexes', () => {
  const NAMES = [
    'sessions_expires_idx',
    'sessions_revoked_idx',
    'refresh_tokens_expires_idx',
    'magic_link_tokens_expires_idx',
    'magic_link_tokens_consumed_idx',
    'portal_access_token_revoked_idx',
    'break_glass_attempt_last_failed_idx',
  ];
  const present = async (): Promise<string[]> => {
    const result = await owner().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[]) ORDER BY indexname`,
      [NAMES],
    );
    return result.rows.map((row) => row.indexname);
  };

  it('indexes every column the cleanup filters on, and goes down and up again', async () => {
    expect(await present()).toEqual([...NAMES].sort());
    // portal_access_token already had its expiry index since 0004.
    expect(await count('pg_indexes', `indexname = 'portal_access_token_expiry_idx'`)).toBe(1);

    const later = await migrationsAfter('0012_expiry_indexes');
    expect(await migrateDown(owner(), { steps: 1 + later.length })).toEqual([
      ...later.toReversed(),
      '0012_expiry_indexes',
    ]);
    expect(await present()).toEqual([]);
    expect(await migrateUp(owner())).toEqual(['0012_expiry_indexes', ...later]);
    expect(await present()).toEqual([...NAMES].sort());
  });

  it('needs no extra grant: the application role may delete from every table it cleans', async () => {
    const role = new URL(testDb.appUrl).username;
    for (const table of [
      'sessions',
      'refresh_tokens',
      'magic_link_tokens',
      'portal_access_token',
      'break_glass_attempt',
    ]) {
      const privileges = await owner().query<{ del: boolean; trunc: boolean }>(
        `SELECT has_table_privilege($1, $2::regclass, 'DELETE') AS del,
                has_table_privilege($1, $2::regclass, 'TRUNCATE') AS trunc`,
        [role, table],
      );
      expect(privileges.rows[0], table).toEqual({ del: true, trunc: false });
    }
  });
});
