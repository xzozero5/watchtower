import { createHash, randomBytes } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, type TestDatabase } from './testing.js';

// Migration 0004 (T-007): the table behind the portal tracking links. `app` is the restricted
// login role the api runs as.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

let testDb: TestDatabase;
let app: Pool;
const owner = () => testDb.owner.pool;

async function scalar<T>(pool: Pool, text: string, values: unknown[] = []): Promise<T> {
  const result = await pool.query<{ value: T }>(text, values);
  const row = result.rows[0];
  if (row === undefined) throw new Error('query returned no row');
  return row.value;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function newTicketAndContact(): Promise<{ ticket: string; contact: string }> {
  const org = await scalar<string>(
    owner(),
    `INSERT INTO organization (name) VALUES ('Portal org ' || gen_random_uuid()) RETURNING id AS value`,
  );
  const contact = await scalar<string>(
    owner(),
    `INSERT INTO contact (org_id, name, emails) VALUES ($1, 'C', ARRAY['c-' || gen_random_uuid() || '@example.com']) RETURNING id AS value`,
    [org],
  );
  const ticket = await scalar<string>(
    owner(),
    `INSERT INTO ticket (org_id, subject, requester_contact_id) VALUES ($1, 'S', $2) RETURNING id AS value`,
    [org, contact],
  );
  return { ticket, contact };
}

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 4 });
});

afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

describe('portal_access_token', () => {
  it('lets the application role store, look up and revoke a token hash', async () => {
    const { ticket, contact } = await newTicketAndContact();
    const token = randomBytes(32).toString('base64url');
    await app.query(
      `INSERT INTO portal_access_token (ticket_id, contact_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '90 days')`,
      [ticket, contact, hash(token)],
    );
    expect(
      await scalar<string>(
        app,
        'SELECT ticket_id AS value FROM portal_access_token WHERE token_hash = $1',
        [hash(token)],
      ),
    ).toBe(ticket);
    await app.query('UPDATE portal_access_token SET revoked_at = now() WHERE ticket_id = $1', [
      ticket,
    ]);
    expect(
      await scalar<boolean>(
        app,
        'SELECT revoked_at IS NOT NULL AS value FROM portal_access_token WHERE ticket_id = $1',
        [ticket],
      ),
    ).toBe(true);
  });

  it('refuses a duplicate hash, a hash that is not SHA-256 hex and an expiry in the past', async () => {
    const { ticket, contact } = await newTicketAndContact();
    const insert = (value: string, expiry = `now() + interval '1 day'`) =>
      app.query(
        `INSERT INTO portal_access_token (ticket_id, contact_id, token_hash, expires_at)
         VALUES ($1, $2, $3, ${expiry})`,
        [ticket, contact, value],
      );
    await insert(hash('one'));
    await expect(insert(hash('one'))).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    await expect(insert('not-a-hash')).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert(hash('two'), `now() - interval '1 day'`)).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });
});

describe('reversibility of 0004', () => {
  it('goes down with tokens present and up again', async () => {
    const { ticket, contact } = await newTicketAndContact();
    await owner().query(
      `INSERT INTO portal_access_token (ticket_id, contact_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 day')`,
      [ticket, contact, hash('revert')],
    );
    expect(await migrateDown(owner(), { steps: 1 })).toEqual(['0004_portal']);
    expect(
      await scalar<string | null>(
        owner(),
        `SELECT to_regclass('portal_access_token')::text AS value`,
      ),
    ).toBeNull();
    // Tickets and contacts are untouched.
    expect(
      await scalar<string>(owner(), 'SELECT count(*)::text AS value FROM ticket WHERE id = $1', [
        ticket,
      ]),
    ).toBe('1');

    expect(await migrateUp(owner())).toEqual(['0004_portal']);
    expect(
      await scalar<string>(app, 'SELECT count(*)::text AS value FROM portal_access_token'),
    ).toBe('0');
    await app.query(
      `INSERT INTO portal_access_token (ticket_id, contact_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 day')`,
      [ticket, contact, hash('after')],
    );
  });
});
