import {
  DEFAULT_ROLE_PERMISSIONS,
  DEFAULT_STATUS_TRANSITIONS,
  TICKET_STATUSES,
  defaultTransitionList,
} from '@watchtower/shared';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { seedIntents } from './seed/intents.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0002 (organizations, tickets, messages, events) against the real Postgres from docker
// compose, in a throwaway database. `app` is the restricted login role the api runs as.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const PRIVILEGE_ERROR = '42501';
const RESTRICT_VIOLATION = '23001';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
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

async function newOrg(pool: Pool, name: string, domains: string[] = []): Promise<string> {
  return scalar<string>(
    pool,
    'INSERT INTO organization (name, domains) VALUES ($1, $2) RETURNING id AS value',
    [name, domains],
  );
}

async function newTicket(pool: Pool, orgId: string, subject = 'Subject'): Promise<string> {
  return scalar<string>(
    pool,
    'INSERT INTO ticket (org_id, subject) VALUES ($1, $2) RETURNING id AS value',
    [orgId, subject],
  );
}

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 12 });
});

afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

describe('seed data', () => {
  it('seeds exactly the default status transitions of @watchtower/shared', async () => {
    const rows = await owner().query<{ from_status: string; to_status: string }>(
      'SELECT from_status, to_status FROM ticket_status_transition',
    );
    const fromDb = rows.rows
      .map((row) => `${row.from_status}>${row.to_status}`)
      .toSorted((a, b) => a.localeCompare(b));
    const expected = defaultTransitionList()
      .map((transition) => `${transition.from}>${transition.to}`)
      .toSorted((a, b) => a.localeCompare(b));
    expect(fromDb).toEqual(expected);
    expect(
      TICKET_STATUSES.filter((status) => DEFAULT_STATUS_TRANSITIONS[status].length === 0),
    ).toEqual(['closed', 'merged']);
  });

  it('gives the new permissions to the roles the shared defaults name', async () => {
    const rows = await owner().query<{ role: string; permission: string }>(
      `SELECT role, permission FROM role_permissions
        WHERE permission IN ('queue.manage', 'intent.manage', 'workflow.manage')`,
    );
    const fromDb = rows.rows.map((row) => `${row.role}:${row.permission}`).toSorted();
    const expected = (['lead', 'head', 'agent', 'client', 'system'] as const)
      .flatMap((role) =>
        DEFAULT_ROLE_PERMISSIONS[role]
          .filter((permission) =>
            ['queue.manage', 'intent.manage', 'workflow.manage'].includes(permission),
          )
          .map((permission) => `${role}:${permission}`),
      )
      .toSorted();
    expect(fromDb).toEqual(expected);
  });

  it('has exactly one portal channel account', async () => {
    expect(
      await scalar<string>(
        owner(),
        `SELECT count(*)::text AS value FROM channel_account WHERE type = 'portal'`,
      ),
    ).toBe('1');
    await expectSqlState(
      owner().query(`INSERT INTO channel_account (type, name) VALUES ('portal', 'Another')`),
      UNIQUE_VIOLATION,
    );
  });

  it('starts every intent at autonomy stage 2 and bounds it (N3)', async () => {
    await owner().query(`INSERT INTO intent (key, name) VALUES ('probe_default', 'Probe')`);
    expect(
      await scalar<number>(
        owner(),
        `SELECT autonomy_stage AS value FROM intent WHERE key = 'probe_default'`,
      ),
    ).toBe(2);
    await expectSqlState(
      owner().query(`INSERT INTO intent (key, name, autonomy_stage) VALUES ('probe_high', 'P', 5)`),
      CHECK_VIOLATION,
    );
    await expectSqlState(
      owner().query(`INSERT INTO intent (key, name) VALUES ('Bad Key', 'P')`),
      CHECK_VIOLATION,
    );
    await expectSqlState(
      owner().query(`INSERT INTO intent (key, name) VALUES ('probe_default', 'Duplicate')`),
      UNIQUE_VIOLATION,
    );
  });

  it('loads the starter intents from examples/intents without overwriting edits', async () => {
    const first = await seedIntents(testDb.owner.db);
    expect(first.inserted.length).toBeGreaterThanOrEqual(11);
    expect(first.existing).toEqual([]);

    await owner().query(
      `UPDATE intent SET name = 'Edited in the instance' WHERE key = 'api_error'`,
    );
    const second = await seedIntents(testDb.owner.db);
    expect(second.inserted).toEqual([]);
    expect(second.existing).toEqual(first.inserted);
    expect(
      await scalar<string>(owner(), `SELECT name AS value FROM intent WHERE key = 'api_error'`),
    ).toBe('Edited in the instance');
    expect(
      await scalar<string>(
        owner(),
        `SELECT count(*)::text AS value FROM intent WHERE autonomy_stage <> 2`,
      ),
    ).toBe('0');
  });
});

describe('organization domains and contact emails', () => {
  it('refuses a domain that is not lower-case and trimmed', async () => {
    await expectSqlState(
      owner().query(`INSERT INTO organization (name, domains) VALUES ('X', ARRAY['Acme.COM'])`),
      CHECK_VIOLATION,
    );
    await expectSqlState(
      owner().query(`INSERT INTO organization (name, domains) VALUES ('X', ARRAY[' acme.com'])`),
      CHECK_VIOLATION,
    );
  });

  it('gives a domain to one organization only', async () => {
    const first = await newOrg(owner(), 'Domain A', ['a-only.example.com']);
    await expectSqlState(newOrg(owner(), 'Domain B', ['a-only.example.com']), UNIQUE_VIOLATION);
    await expectSqlState(
      newOrg(owner(), 'Domain C', ['fresh.example.com', 'a-only.example.com']),
      UNIQUE_VIOLATION,
    );
    const other = await newOrg(owner(), 'Domain D', ['d.example.com']);
    await expectSqlState(
      owner().query(`UPDATE organization SET domains = ARRAY['a-only.example.com'] WHERE id = $1`, [
        other,
      ]),
      UNIQUE_VIOLATION,
    );
    // Saving the organization's own domain again is not a clash.
    await owner().query(
      `UPDATE organization SET domains = ARRAY['a-only.example.com'], notes = 'x' WHERE id = $1`,
      [first],
    );
  });

  it('holds when two transactions claim the same domain at once', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_unused, index) =>
        newOrg(app, `Race ${String(index)}`, ['race.example.com']),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: UNIQUE_VIOLATION });
      }
    }
  });

  it('gives an email address to one contact only, whatever the organization', async () => {
    const orgA = await newOrg(owner(), 'Contact org A');
    const orgB = await newOrg(owner(), 'Contact org B');
    await owner().query(
      `INSERT INTO contact (org_id, name, emails) VALUES ($1, 'Ana', ARRAY['ana@example.com'])`,
      [orgA],
    );
    await expectSqlState(
      owner().query(
        `INSERT INTO contact (org_id, name, emails) VALUES ($1, 'Ana 2', ARRAY['ana@example.com'])`,
        [orgB],
      ),
      UNIQUE_VIOLATION,
    );
    await expectSqlState(
      owner().query(
        `INSERT INTO contact (org_id, name, emails) VALUES ($1, 'Twin', ARRAY['t@example.com', 't@example.com'])`,
        [orgA],
      ),
      UNIQUE_VIOLATION,
    );
    await expectSqlState(
      owner().query(
        `INSERT INTO contact (org_id, name, emails) VALUES ($1, 'Upper', ARRAY['UP@example.com'])`,
        [orgA],
      ),
      CHECK_VIOLATION,
    );
    await expectSqlState(
      owner().query(`INSERT INTO contact (org_id, name, emails) VALUES ($1, 'Nobody', '{}')`, [
        orgA,
      ]),
      CHECK_VIOLATION,
    );
  });

  it('will not delete an organization that still has contacts or tickets', async () => {
    const org = await newOrg(owner(), 'Has data');
    await newTicket(owner(), org);
    await expectSqlState(
      owner().query('DELETE FROM organization WHERE id = $1', [org]),
      FOREIGN_KEY_VIOLATION,
    );
  });
});

describe('tickets', () => {
  it('numbers tickets from a sequence that never repeats under concurrent inserts', async () => {
    const org = await newOrg(owner(), 'Numbering');
    const ids = await Promise.all(
      Array.from({ length: 40 }, (_unused, index) =>
        newTicket(app, org, `Concurrent ${String(index)}`),
      ),
    );
    expect(new Set(ids).size).toBe(40);
    const numbers = await owner().query<{ number: string }>(
      'SELECT number FROM ticket WHERE org_id = $1',
      [org],
    );
    const distinct = new Set(numbers.rows.map((row) => row.number));
    expect(distinct.size).toBe(40);
    expect(Math.min(...numbers.rows.map((row) => Number(row.number)))).toBeGreaterThanOrEqual(1001);
  });

  it('enforces the status and priority vocabulary', async () => {
    const org = await newOrg(owner(), 'Vocabulary');
    await expectSqlState(
      owner().query(`INSERT INTO ticket (org_id, subject, status) VALUES ($1, 's', 'done')`, [org]),
      CHECK_VIOLATION,
    );
    await expectSqlState(
      owner().query(`INSERT INTO ticket (org_id, subject, priority) VALUES ($1, 's', 'P0')`, [org]),
      CHECK_VIOLATION,
    );
    await expectSqlState(
      owner().query(`INSERT INTO ticket (org_id, subject, channel) VALUES ($1, 's', 'fax')`, [org]),
      CHECK_VIOLATION,
    );
  });

  it('refuses a merged ticket without a parent, its own parent, and any cycle', async () => {
    const org = await newOrg(owner(), 'Cycles');
    const a = await newTicket(owner(), org, 'A');
    const b = await newTicket(owner(), org, 'B');
    const c = await newTicket(owner(), org, 'C');
    await expectSqlState(
      owner().query(`UPDATE ticket SET status = 'merged' WHERE id = $1`, [a]),
      CHECK_VIOLATION,
    );
    await expectSqlState(
      owner().query(`UPDATE ticket SET parent_ticket_id = id WHERE id = $1`, [a]),
      CHECK_VIOLATION,
    );
    await owner().query(
      `UPDATE ticket SET status = 'merged', parent_ticket_id = $2 WHERE id = $1`,
      [a, b],
    );
    await owner().query(
      `UPDATE ticket SET status = 'merged', parent_ticket_id = $2 WHERE id = $1`,
      [b, c],
    );
    // c -> a would close the loop a -> b -> c -> a.
    await expectSqlState(
      owner().query(`UPDATE ticket SET parent_ticket_id = $2 WHERE id = $1`, [c, a]),
      CHECK_VIOLATION,
    );
    await expectSqlState(
      owner().query(`UPDATE ticket SET parent_ticket_id = $2 WHERE id = $1`, [b, a]),
      CHECK_VIOLATION,
    );
  });

  it('has the indexes the queue needs', async () => {
    const rows = await owner().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'ticket'`,
    );
    const names = rows.rows.map((row) => row.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'ticket_number_key',
        'ticket_queue_idx',
        'ticket_org_status_idx',
        'ticket_assignee_status_idx',
        'ticket_open_due_idx',
        'ticket_subject_trgm_idx',
      ]),
    );
  });
});

describe('messages', () => {
  it('rejects the same provider message twice, per channel account', async () => {
    const org = await newOrg(owner(), 'Idempotency');
    const ticket = await newTicket(owner(), org);
    const account = await scalar<string>(
      owner(),
      `SELECT id AS value FROM channel_account WHERE type = 'portal'`,
    );
    const insert = (externalId: string | null) =>
      owner().query(
        `INSERT INTO message (ticket_id, channel_account_id, direction, visibility, body_text, external_id)
         VALUES ($1, $2, 'inbound', 'public', 'hello', $3)`,
        [ticket, account, externalId],
      );
    await insert('submission-1');
    await expectSqlState(insert('submission-1'), UNIQUE_VIOLATION);
    await insert('submission-2');
    // Messages without a provider id (staff replies) do not collide with each other.
    await insert(null);
    await insert(null);
  });

  it('keeps internal notes internal: visibility and direction must agree', async () => {
    const org = await newOrg(owner(), 'Visibility');
    const ticket = await newTicket(owner(), org);
    const insert = (direction: string, visibility: string) =>
      owner().query(
        `INSERT INTO message (ticket_id, direction, visibility, body_text) VALUES ($1, $2, $3, 'x')`,
        [ticket, direction, visibility],
      );
    await expectSqlState(insert('outbound', 'internal'), CHECK_VIOLATION);
    await expectSqlState(insert('internal', 'public'), CHECK_VIOLATION);
    await insert('internal', 'internal');
    await insert('outbound', 'public');
  });

  it('is not partitioned, which is what makes the idempotency key hold across months', async () => {
    expect(
      await scalar<string>(
        owner(),
        `SELECT relkind::text AS value FROM pg_class WHERE relname = 'message'`,
      ),
    ).toBe('r');
  });
});

describe('ticket_event is append-only and partitioned by month', () => {
  async function insertEvent(pool: Pool, ticket: string): Promise<string> {
    return scalar<string>(
      pool,
      `INSERT INTO ticket_event (ticket_id, type, actor_type, payload)
       VALUES ($1, 'ticket.created', 'system', '{}'::jsonb) RETURNING id AS value`,
      [ticket],
    );
  }

  it('accepts inserts into the current month partition', async () => {
    const org = await newOrg(owner(), 'Events');
    const ticket = await newTicket(app, org);
    await insertEvent(app, ticket);
    const partition = await scalar<string>(
      owner(),
      `SELECT tableoid::regclass::text AS value FROM ticket_event WHERE ticket_id = $1`,
      [ticket],
    );
    expect(partition).toMatch(/^ticket_event_p\d{6}$/);
    const partitions = await scalar<string>(
      owner(),
      `SELECT count(*)::text AS value FROM pg_inherits WHERE inhparent = 'ticket_event'::regclass`,
    );
    expect(Number(partitions)).toBeGreaterThanOrEqual(13);
  });

  it('refuses UPDATE, DELETE and TRUNCATE for the application role', async () => {
    const org = await newOrg(owner(), 'Events 2');
    const ticket = await newTicket(app, org);
    await insertEvent(app, ticket);
    await expectSqlState(app.query(`UPDATE ticket_event SET type = 'x'`), PRIVILEGE_ERROR);
    await expectSqlState(app.query('DELETE FROM ticket_event'), PRIVILEGE_ERROR);
    await expectSqlState(app.query('TRUNCATE ticket_event'), PRIVILEGE_ERROR);
  });

  it('refuses them for the owner too, through the triggers', async () => {
    const org = await newOrg(owner(), 'Events 3');
    const ticket = await newTicket(owner(), org);
    await insertEvent(owner(), ticket);
    await expectSqlState(owner().query(`UPDATE ticket_event SET type = 'x'`), RESTRICT_VIOLATION);
    await expectSqlState(owner().query('DELETE FROM ticket_event'), RESTRICT_VIOLATION);
    await expectSqlState(owner().query('TRUNCATE ticket_event'), RESTRICT_VIOLATION);
    const partition = await scalar<string>(
      owner(),
      `SELECT tableoid::regclass::text AS value FROM ticket_event LIMIT 1`,
    );
    await expectSqlState(owner().query(`TRUNCATE ${partition}`), RESTRICT_VIOLATION);
  });

  it('keeps an event that lands outside every monthly partition in the default partition', async () => {
    const org = await newOrg(owner(), 'Events 4');
    const ticket = await newTicket(owner(), org);
    await owner().query(
      `INSERT INTO ticket_event (ticket_id, type, actor_type, created_at)
       VALUES ($1, 'ticket.created', 'system', '2001-01-01T00:00:00Z')`,
      [ticket],
    );
    expect(
      await scalar<string>(
        owner(),
        `SELECT tableoid::regclass::text AS value FROM ticket_event WHERE created_at < '2002-01-01'`,
      ),
    ).toBe('ticket_event_default');
  });

  it('refuses an event for a ticket that does not exist', async () => {
    await expectSqlState(
      insertEvent(app, '00000000-0000-4000-8000-000000000001'),
      FOREIGN_KEY_VIOLATION,
    );
  });
});

describe('Thai text search with pg_trgm', () => {
  const subject = 'ไม่สามารถเข้าสู่ระบบได้ หลังจากเปลี่ยนรหัสผ่าน';
  const body = 'ลูกค้าแจ้งว่าระบบแจ้งเตือนไม่ทำงาน ตั้งค่า webhook แล้วแต่ไม่ได้รับข้อมูล';
  let orgId: string;

  beforeAll(async () => {
    orgId = await newOrg(owner(), 'Thai text');
    const ticket = await newTicket(owner(), orgId, subject);
    await owner().query(
      `INSERT INTO message (ticket_id, direction, visibility, body_text) VALUES ($1, 'inbound', 'public', $2)`,
      [ticket, body],
    );
    await newTicket(owner(), orgId, 'English only subject about billing');
  });

  it('builds trigrams from Thai characters in this database', async () => {
    const trigrams = await scalar<string[]>(owner(), `SELECT show_trgm('เข้าสู่ระบบ') AS value`);
    expect(trigrams.length).toBeGreaterThan(3);
  });

  it('finds a Thai substring in the subject and in a message', async () => {
    const bySubject = await owner().query(
      `SELECT id FROM ticket WHERE org_id = $1 AND subject ILIKE $2`,
      [orgId, '%เปลี่ยนรหัสผ่าน%'],
    );
    expect(bySubject.rows).toHaveLength(1);
    const byMessage = await owner().query(
      `SELECT ticket_id FROM message WHERE body_text ILIKE $1`,
      ['%แจ้งเตือนไม่ทำงาน%'],
    );
    expect(byMessage.rows).toHaveLength(1);
    const none = await owner().query(
      `SELECT id FROM ticket WHERE org_id = $1 AND subject ILIKE $2`,
      [orgId, '%ไม่มีคำนี้%'],
    );
    expect(none.rows).toHaveLength(0);
  });

  it('answers the Thai substring query from the trigram index, not a table scan', async () => {
    const client = await owner().connect();
    try {
      await client.query('SET enable_seqscan = off');
      const plan = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id FROM ticket WHERE subject ILIKE '%เปลี่ยนรหัสผ่าน%'`,
      );
      expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
        'ticket_subject_trgm_idx',
      );
      const messagePlan = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT ticket_id FROM message WHERE body_text ILIKE '%แจ้งเตือนไม่ทำงาน%'`,
      );
      expect(messagePlan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
        'message_body_trgm_idx',
      );
    } finally {
      await client.query('RESET enable_seqscan');
      client.release();
    }
  });

  it('ranks by similarity so close matches come first', async () => {
    const rows = await owner().query<{ subject: string }>(
      `SELECT subject FROM ticket WHERE org_id = $1
        ORDER BY word_similarity($2, subject) DESC, subject LIMIT 1`,
      [orgId, 'เข้าสู่ระบบ'],
    );
    expect(rows.rows[0]?.subject).toBe(subject);
  });
});

describe('down and up again', () => {
  it('reverts 0002 with data present and reapplies it', async () => {
    const org = await newOrg(owner(), 'Revert me', ['revert.example.com']);
    await owner().query(
      `INSERT INTO users (email, name, role, org_id) VALUES ('rev@example.com', 'R', 'client', $1)`,
      [org],
    );
    await owner().query(
      `INSERT INTO users (email, name, role) VALUES ('staff-rev@example.com', 'S', 'agent')`,
    );
    await newTicket(owner(), org);

    const later = await migrationsAfter('0005_security');
    expect(await migrateDown(owner(), { steps: 4 + later.length })).toEqual([
      ...later.toReversed(),
      '0005_security',
      '0004_portal',
      '0003_followups_outbox',
      '0002_ticketing',
    ]);
    expect(
      await scalar<string | null>(owner(), `SELECT to_regclass('ticket')::text AS value`),
    ).toBeNull();
    expect(
      await scalar<string>(
        owner(),
        `SELECT count(*)::text AS value FROM permissions WHERE key = 'queue.manage'`,
      ),
    ).toBe('0');
    // Clients belonged to the dropped organizations and go with them; staff accounts of 0001 survive.
    expect(
      await scalar<string>(
        owner(),
        `SELECT count(*)::text AS value FROM users WHERE email = 'rev@example.com'`,
      ),
    ).toBe('0');
    expect(
      await scalar<string>(
        owner(),
        `SELECT count(*)::text AS value FROM users WHERE email = 'staff-rev@example.com'`,
      ),
    ).toBe('1');

    expect(await migrateUp(owner())).toEqual([
      '0002_ticketing',
      '0003_followups_outbox',
      '0004_portal',
      '0005_security',
      ...later,
    ]);
    expect(
      await scalar<string>(owner(), `SELECT count(*)::text AS value FROM ticket_status_transition`),
    ).toBe(String(defaultTransitionList().length));
    // Reapplying keeps the privileges: the application role can still write tickets.
    const orgAgain = await newOrg(owner(), 'After revert');
    await newTicket(app, orgAgain);
  });
});
