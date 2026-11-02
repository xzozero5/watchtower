import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0066 (T-119a,c): saved views and ticket links. `app` is the restricted login role the
// api runs as.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const PRIVILEGE_ERROR = '42501';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';

let testDb: TestDatabase;
let app: Pool;
const owner = () => testDb.owner.pool;

async function expectSqlState(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

async function scalar<T>(pool: Pool, text: string, values: unknown[] = []): Promise<T> {
  const result = await pool.query<{ value: T }>(text, values);
  const row = result.rows[0];
  if (row === undefined) throw new Error('query returned no row');
  return row.value;
}

const newUser = (email: string) =>
  scalar<string>(
    owner(),
    `INSERT INTO users (email, name, role) VALUES ($1, 'Staff', 'agent') RETURNING id AS value`,
    [email],
  );

let ticketA: string;
let ticketB: string;
let userA: string;
let userB: string;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 4 });
  const org = await scalar<string>(
    owner(),
    `INSERT INTO organization (name) VALUES ('Links') RETURNING id AS value`,
  );
  const insertTicket = () =>
    scalar<string>(
      owner(),
      `INSERT INTO ticket (org_id, subject) VALUES ($1, 'Subject') RETURNING id AS value`,
      [org],
    );
  [ticketA, ticketB] = [await insertTicket(), await insertTicket()];
  userA = await newUser('a@example.com');
  userB = await newUser('b@example.com');
});

afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

describe('saved_view', () => {
  const insert = (owner_id: string, name: string, shared: boolean) =>
    app.query(
      `INSERT INTO saved_view (owner_id, name, shared, filters) VALUES ($1, $2, $3, '{"status":["open"]}')`,
      [owner_id, name, shared],
    );

  it('keeps a name unique per person among personal views, ignoring case', async () => {
    await insert(userA, 'Mine', false);
    await expectSqlState(insert(userA, 'mine', false), UNIQUE_VIOLATION);
    // Another person may use the same name.
    await insert(userB, 'Mine', false);
  });

  it("keeps a name unique among shared views, and a personal view may share a shared view's name", async () => {
    await insert(userA, 'Team view', true);
    await expectSqlState(insert(userB, 'TEAM VIEW', true), UNIQUE_VIOLATION);
    await insert(userB, 'Team view', false);
  });

  it('refuses an empty name, a filter that is not an object and an unknown sort', async () => {
    await expectSqlState(insert(userA, '', false), CHECK_VIOLATION);
    await expectSqlState(
      app.query(`INSERT INTO saved_view (owner_id, name, filters) VALUES ($1, 'x', '[]')`, [userA]),
      CHECK_VIOLATION,
    );
    await expectSqlState(
      app.query(`INSERT INTO saved_view (owner_id, name, sort) VALUES ($1, 'y', 'random')`, [
        userA,
      ]),
      CHECK_VIOLATION,
    );
  });
});

describe('ticket_link', () => {
  const link = (pool: Pool, kind: string, from: string, to: string) =>
    pool.query(`INSERT INTO ticket_link (kind, from_ticket_id, to_ticket_id) VALUES ($1, $2, $3)`, [
      kind,
      from,
      to,
    ]);

  it('refuses a ticket linked to itself and an unknown kind', async () => {
    await expectSqlState(link(app, 'duplicate', ticketA, ticketA), CHECK_VIOLATION);
    await expectSqlState(link(app, 'blocks', ticketA, ticketB), CHECK_VIOLATION);
  });

  it('stores a related pair one way only: smaller id first', async () => {
    const [small, large] = ticketA < ticketB ? [ticketA, ticketB] : [ticketB, ticketA];
    await expectSqlState(link(app, 'related', large, small), CHECK_VIOLATION);
    await link(app, 'related', small, large);
    await expectSqlState(link(app, 'related', small, large), UNIQUE_VIOLATION);
  });

  it('allows a duplicate in each direction only once per direction', async () => {
    await link(app, 'duplicate', ticketA, ticketB);
    await expectSqlState(link(app, 'duplicate', ticketA, ticketB), UNIQUE_VIOLATION);
  });

  it('is never edited by the application, but can be deleted', async () => {
    await expectSqlState(app.query(`UPDATE ticket_link SET kind = 'related'`), PRIVILEGE_ERROR);
    await app.query(`DELETE FROM ticket_link WHERE kind = 'duplicate'`);
    expect(await scalar<string>(owner(), `SELECT count(*)::text AS value FROM ticket_link`)).toBe(
      '1',
    );
  });

  it('keeps the tickets it points at: a ticket with a link cannot be deleted', async () => {
    await expectSqlState(
      owner().query(`DELETE FROM ticket WHERE id = $1`, [ticketA]),
      FOREIGN_KEY_VIOLATION,
    );
  });
});

describe('reversibility', () => {
  it('goes down and up again, dropping both tables', async () => {
    // Revert the migrations that come after 0066 first, then 0066 itself.
    const later = await migrationsAfter('0066_views_links');
    expect(await migrateDown(owner(), { steps: later.length + 1 })).toEqual([
      ...later.toReversed(),
      '0066_views_links',
    ]);
    const down = await scalar<string | null>(
      owner(),
      `SELECT to_regclass('saved_view')::text AS value`,
    );
    expect(down).toBeNull();
    expect(
      await scalar<string | null>(owner(), `SELECT to_regclass('ticket_link')::text AS value`),
    ).toBeNull();
    expect(await migrateUp(owner())).toContain('0066_views_links');
    expect(
      await scalar<string | null>(owner(), `SELECT to_regclass('ticket_link')::text AS value`),
    ).toBe('ticket_link');
  });
});
