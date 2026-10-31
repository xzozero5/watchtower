import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, type TestDatabase } from './testing.js';

// Migration 0003 (T-013): tiers as data, RESTRICT on contact/queue references, the message
// privileges, the foreign-key-side indexes and the outbox table. `app` is the restricted login
// role the api runs as.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const PRIVILEGE_ERROR = '42501';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

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

async function newOrg(pool: Pool, name: string, tier = 'standard'): Promise<string> {
  return scalar<string>(
    pool,
    'INSERT INTO organization (name, tier) VALUES ($1, $2) RETURNING id AS value',
    [name, tier],
  );
}

async function newContact(pool: Pool, orgId: string, email: string): Promise<string> {
  return scalar<string>(
    pool,
    `INSERT INTO contact (org_id, name, emails) VALUES ($1, 'Somchai', ARRAY[$2]::text[]) RETURNING id AS value`,
    [orgId, email],
  );
}

async function newQueue(pool: Pool, name: string): Promise<string> {
  return scalar<string>(pool, 'INSERT INTO team_queue (name) VALUES ($1) RETURNING id AS value', [
    name,
  ]);
}

async function newMessage(pool: Pool, ticketId: string, contactId: string | null): Promise<string> {
  return scalar<string>(
    pool,
    `INSERT INTO message (ticket_id, direction, visibility, body_text, sender_contact_id, delivery_status)
     VALUES ($1, 'inbound', 'public', 'original text', $2, 'pending') RETURNING id AS value`,
    [ticketId, contactId],
  );
}

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 4 });
});

afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

describe('org_tier', () => {
  it('starts with gold, silver and standard', async () => {
    const rows = await owner().query<{ slug: string }>(
      'SELECT slug FROM org_tier ORDER BY sort_order',
    );
    expect(rows.rows.map((row) => row.slug)).toEqual(['gold', 'silver', 'standard']);
  });

  it('accepts a tier an admin adds and refuses one that does not exist', async () => {
    await expectSqlState(newOrg(owner(), 'Nope', 'platinum'), FOREIGN_KEY_VIOLATION);
    await expectSqlState(
      owner().query(`INSERT INTO sla_policy (name, tier) VALUES ('Nope', 'platinum')`),
      FOREIGN_KEY_VIOLATION,
    );
    await app.query(
      `INSERT INTO org_tier (slug, name, sort_order) VALUES ('platinum', 'Platinum', 5)`,
    );
    const org = await newOrg(app, 'Now fine', 'platinum');
    expect(
      await scalar<string>(owner(), 'SELECT tier AS value FROM organization WHERE id = $1', [org]),
    ).toBe('platinum');
    // A tier in use cannot be removed; an unused one can.
    await expectSqlState(
      owner().query(`DELETE FROM org_tier WHERE slug = 'platinum'`),
      FOREIGN_KEY_VIOLATION,
    );
    await owner().query(`DELETE FROM org_tier WHERE slug = 'silver'`);
    await owner().query(
      `INSERT INTO org_tier (slug, name, sort_order) VALUES ('silver', 'Silver', 20)`,
    );
  });

  it('keeps the slug shape', async () => {
    await expectSqlState(
      owner().query(`INSERT INTO org_tier (slug, name) VALUES ('Has Space', 'Bad')`),
      CHECK_VIOLATION,
    );
  });

  it('renames a slug through to the organizations that use it', async () => {
    await owner().query(`INSERT INTO org_tier (slug, name) VALUES ('bronze', 'Bronze')`);
    const org = await newOrg(owner(), 'Bronze org', 'bronze');
    await owner().query(`UPDATE org_tier SET slug = 'copper' WHERE slug = 'bronze'`);
    expect(
      await scalar<string>(owner(), 'SELECT tier AS value FROM organization WHERE id = $1', [org]),
    ).toBe('copper');
  });
});

describe('contacts and queues that tickets still point at', () => {
  it('cannot be deleted while a ticket or a message references them', async () => {
    const org = await newOrg(owner(), 'References');
    const contact = await newContact(owner(), org, 'ref@example.com');
    const queue = await newQueue(owner(), 'Referenced queue');
    const ticket = await scalar<string>(
      owner(),
      `INSERT INTO ticket (org_id, subject, requester_contact_id, queue_id)
       VALUES ($1, 'Subject', $2, $3) RETURNING id AS value`,
      [org, contact, queue],
    );
    await expectSqlState(
      owner().query('DELETE FROM contact WHERE id = $1', [contact]),
      FOREIGN_KEY_VIOLATION,
    );
    await expectSqlState(
      owner().query('DELETE FROM team_queue WHERE id = $1', [queue]),
      FOREIGN_KEY_VIOLATION,
    );

    // Only a message points at this contact: still refused.
    const bare = await newTicket(org);
    const author = await newContact(owner(), org, 'author@example.com');
    await newMessage(owner(), bare, author);
    await expectSqlState(
      owner().query('DELETE FROM contact WHERE id = $1', [author]),
      FOREIGN_KEY_VIOLATION,
    );
    // The ticket kept both references.
    expect(
      await scalar<string>(
        owner(),
        'SELECT requester_contact_id AS value FROM ticket WHERE id = $1',
        [ticket],
      ),
    ).toBe(contact);
  });

  it('can be deleted when nothing points at them', async () => {
    const org = await newOrg(owner(), 'Unreferenced');
    const contact = await newContact(owner(), org, 'free@example.com');
    const queue = await newQueue(owner(), 'Free queue');
    await owner().query('DELETE FROM contact WHERE id = $1', [contact]);
    await owner().query('DELETE FROM team_queue WHERE id = $1', [queue]);
  });

  async function newTicket(org: string): Promise<string> {
    return scalar<string>(
      owner(),
      `INSERT INTO ticket (org_id, subject) VALUES ($1, 'Subject') RETURNING id AS value`,
      [org],
    );
  }
});

describe('what the application role may do with messages', () => {
  it('cannot delete a message (42501)', async () => {
    const org = await newOrg(owner(), 'Messages');
    const ticket = await scalar<string>(
      owner(),
      `INSERT INTO ticket (org_id, subject) VALUES ($1, 'S') RETURNING id AS value`,
      [org],
    );
    const message = await newMessage(owner(), ticket, null);
    await expectSqlState(
      app.query('DELETE FROM message WHERE id = $1', [message]),
      PRIVILEGE_ERROR,
    );
    await expectSqlState(app.query('TRUNCATE message'), PRIVILEGE_ERROR);
    expect(
      await scalar<string>(owner(), 'SELECT count(*)::text AS value FROM message WHERE id = $1', [
        message,
      ]),
    ).toBe('1');
  });

  it('can update the delivery state and the redacted copy and nothing else', async () => {
    const org = await newOrg(owner(), 'Message columns');
    const ticket = await scalar<string>(
      owner(),
      `INSERT INTO ticket (org_id, subject) VALUES ($1, 'S') RETURNING id AS value`,
      [org],
    );
    const message = await newMessage(owner(), ticket, null);
    await app.query(`UPDATE message SET delivery_status = 'delivered' WHERE id = $1`, [message]);
    await app.query(`UPDATE message SET body_redacted = 'redacted' WHERE id = $1`, [message]);
    for (const column of [
      'body_text',
      'body_html',
      'visibility',
      'direction',
      'ticket_id',
      'created_at',
    ]) {
      const value =
        column === 'ticket_id'
          ? `'${ticket}'`
          : column === 'created_at'
            ? 'now()'
            : column === 'visibility' || column === 'direction'
              ? `'internal'`
              : `'edited'`;
      await expectSqlState(
        app.query(`UPDATE message SET ${column} = ${value} WHERE id = $1`, [message]),
        PRIVILEGE_ERROR,
      );
    }
    const row = await owner().query<{
      body_text: string;
      delivery_status: string;
      body_redacted: string;
    }>('SELECT body_text, delivery_status, body_redacted FROM message WHERE id = $1', [message]);
    expect(row.rows[0]).toEqual({
      body_text: 'original text',
      delivery_status: 'delivered',
      body_redacted: 'redacted',
    });
  });

  it('still lets the application insert and read messages', async () => {
    const org = await newOrg(app, 'App writes');
    const ticket = await scalar<string>(
      app,
      `INSERT INTO ticket (org_id, subject) VALUES ($1, 'S') RETURNING id AS value`,
      [org],
    );
    const message = await newMessage(app, ticket, null);
    expect(
      await scalar<string>(app, 'SELECT body_text AS value FROM message WHERE id = $1', [message]),
    ).toBe('original text');
  });
});

describe('foreign-key-side indexes', () => {
  it('exist on message and ticket', async () => {
    const rows = await owner().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE indexname IN ('message_sender_contact_idx', 'message_sender_user_idx',
                           'ticket_queue_id_idx', 'ticket_intent_idx')`,
    );
    expect(rows.rows.map((row) => row.indexname).toSorted()).toEqual([
      'message_sender_contact_idx',
      'message_sender_user_idx',
      'ticket_intent_idx',
      'ticket_queue_id_idx',
    ]);
  });

  it('serve the lookups a RESTRICT check and a join make', async () => {
    await owner().query('SET enable_seqscan = off');
    try {
      for (const [table, column, index] of [
        ['message', 'sender_contact_id', 'message_sender_contact_idx'],
        ['message', 'sender_user_id', 'message_sender_user_idx'],
        ['ticket', 'queue_id', 'ticket_queue_id_idx'],
        ['ticket', 'intent_id', 'ticket_intent_idx'],
      ] as const) {
        const plan = await owner().query<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT 1 FROM ${table} WHERE ${column} = '00000000-0000-4000-8000-000000000000'`,
        );
        expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(index);
      }
    } finally {
      await owner().query('RESET enable_seqscan');
    }
  });
});

describe('outbox table', () => {
  it('stores a job once per queue and job id, and refuses a bad status', async () => {
    const insert = (jobId: string, status = 'pending') =>
      owner().query(
        `INSERT INTO outbox (queue, job_name, job_id, payload, status) VALUES ('email', 'send', $1, '{}'::jsonb, $2)`,
        [jobId, status],
      );
    await insert('job-1');
    await expect(insert('job-1')).rejects.toMatchObject({ code: '23505' });
    await expectSqlState(insert('job-2', 'weird'), CHECK_VIOLATION);
  });

  it('is writable by the application role, which also cleans it up', async () => {
    await app.query(
      `INSERT INTO outbox (queue, job_name, job_id, payload) VALUES ('email', 'send', 'app-job', '{"a":1}'::jsonb)`,
    );
    await app.query(`DELETE FROM outbox WHERE job_id = 'app-job'`);
  });
});

describe('reversibility of 0003', () => {
  it('goes down with data present (moving unknown tiers back) and up again', async () => {
    await owner().query(
      `INSERT INTO org_tier (slug, name) VALUES ('diamond', 'Diamond') ON CONFLICT DO NOTHING`,
    );
    const org = await newOrg(owner(), 'Diamond org', 'diamond');
    await owner().query(`INSERT INTO sla_policy (name, tier) VALUES ('Diamond policy', 'diamond')`);
    await owner().query(
      `INSERT INTO outbox (queue, job_name, job_id, payload) VALUES ('email', 'send', 'pending-at-down', '{}'::jsonb)`,
    );

    expect(await migrateDown(owner(), { steps: 2 })).toEqual([
      '0004_portal',
      '0003_followups_outbox',
    ]);
    expect(
      await scalar<string | null>(owner(), `SELECT to_regclass('outbox')::text AS value`),
    ).toBeNull();
    expect(
      await scalar<string | null>(owner(), `SELECT to_regclass('org_tier')::text AS value`),
    ).toBeNull();
    // The CHECK constraints are back, and the unknown tier was moved to standard.
    expect(
      await scalar<string>(owner(), 'SELECT tier AS value FROM organization WHERE id = $1', [org]),
    ).toBe('standard');
    await expectSqlState(newOrg(owner(), 'Bad tier again', 'platinum'), CHECK_VIOLATION);
    // The old privileges are back too: the application role may delete a message.
    const ticket = await scalar<string>(
      owner(),
      `INSERT INTO ticket (org_id, subject) VALUES ($1, 'S') RETURNING id AS value`,
      [org],
    );
    const message = await newMessage(owner(), ticket, null);
    await app.query('DELETE FROM message WHERE id = $1', [message]);
    // And SET NULL is back on contacts.
    const contact = await newContact(owner(), org, 'setnull@example.com');
    const withContact = await scalar<string>(
      owner(),
      `INSERT INTO ticket (org_id, subject, requester_contact_id) VALUES ($1, 'S', $2) RETURNING id AS value`,
      [org, contact],
    );
    await owner().query('DELETE FROM contact WHERE id = $1', [contact]);
    expect(
      await scalar<string | null>(
        owner(),
        'SELECT requester_contact_id AS value FROM ticket WHERE id = $1',
        [withContact],
      ),
    ).toBeNull();

    expect(await migrateUp(owner())).toEqual(['0003_followups_outbox', '0004_portal']);
    expect(await scalar<string>(owner(), 'SELECT count(*)::text AS value FROM org_tier')).toBe('3');
    const orgAgain = await newOrg(owner(), 'After revert', 'gold');
    expect(orgAgain).toBeTruthy();
  });
});
