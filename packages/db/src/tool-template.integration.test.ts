import { randomBytes } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0051 (T-203d): saved investigation templates and the evidence cards a run leaves.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const UNDEFINED_TABLE = '42P01';

let testDb: TestDatabase;
let app: Pool;
let ticketId: string;
let intentId: string;
const owner = () => testDb.owner.pool;
const hash = (): string => randomBytes(32).toString('hex');

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
  const org = await owner().query<{ id: string }>(
    `INSERT INTO organization (name) VALUES ('Example Org') RETURNING id`,
  );
  const ticket = await owner().query<{ id: string }>(
    `INSERT INTO ticket (subject, org_id) VALUES ('Webhook not received', $1) RETURNING id`,
    [org.rows[0]?.id],
  );
  ticketId = ticket.rows[0]?.id ?? '';
  const intent = await owner().query<{ id: string }>(
    `INSERT INTO intent (key, name) VALUES ('webhook_not_received', 'Webhook not received') RETURNING id`,
  );
  intentId = intent.rows[0]?.id ?? '';
});
afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

const template = (name: string, extra = '') =>
  app.query<{ id: string }>(
    `INSERT INTO tool_template (kind, name, title, body${extra === '' ? '' : ', intent_id'})
     VALUES ('logs', $1, 'Title', 'severity>=ERROR'${extra === '' ? '' : ', $2'}) RETURNING id`,
    extra === '' ? [name] : [name, extra],
  );

const card = (fields: { ticket?: string | null; incident?: string | null; kind?: string; excerpt?: string }) =>
  app.query(
    `INSERT INTO evidence_card (ticket_id, incident_id, kind, template_name, title, summary, excerpt, result_count,
                               params_hash, result_hash, run_key)
     VALUES ($1, $2, $3, 'adhoc', 't', 's', $4, 1, $5, $6, 'run')`,
    [
      fields.ticket ?? null,
      fields.incident ?? null,
      fields.kind ?? 'logs',
      fields.excerpt ?? 'line',
      hash(),
      hash(),
    ],
  );

describe('0051 tool_template', () => {
  it('stores a template per kind and name, optionally for an intent', async () => {
    await template('errors');
    await template('errors-for-intent', intentId);
    expect(await code(template('errors'))).toBe(UNIQUE_VIOLATION);
    expect(await code(template('bad name'))).toBe(CHECK_VIOLATION);
    expect(await code(template('x'))).toBe(CHECK_VIOLATION);
    expect(
      await code(
        app.query(`INSERT INTO tool_template (kind, name, title, body) VALUES ('shell', 'abc', 't', 'b')`),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await code(app.query(`INSERT INTO tool_template (kind, name, title, body) VALUES ('logs', 'empty', 't', '')`)),
    ).toBe(CHECK_VIOLATION);
  });

  it('keeps an intent that has templates (no silent turn into a generic template)', async () => {
    expect(await code(owner().query(`DELETE FROM intent WHERE id = $1`, [intentId]))).toBe(
      FOREIGN_KEY_VIOLATION,
    );
  });
});

describe('0051 evidence_card', () => {
  it('pins to a ticket or to an incident, exactly one', async () => {
    const incident = await owner().query<{ id: string }>(
      `INSERT INTO incident (title, severity) VALUES ('Delivery failing', 'SEV2') RETURNING id`,
    );
    const incidentId = incident.rows[0]?.id ?? '';
    await card({ ticket: ticketId });
    await card({ incident: incidentId });
    expect(await code(card({}))).toBe(CHECK_VIOLATION);
    expect(await code(card({ ticket: ticketId, incident: incidentId }))).toBe(CHECK_VIOLATION);
  });

  it('refuses a kind it does not know, an oversized excerpt and a hash that is not a hash', async () => {
    expect(await code(card({ ticket: ticketId, kind: 'shell' }))).toBe(CHECK_VIOLATION);
    expect(await code(card({ ticket: ticketId, excerpt: 'x'.repeat(6001) }))).toBe(CHECK_VIOLATION);
    expect(
      await code(
        app.query(
          `INSERT INTO evidence_card (ticket_id, kind, template_name, title, summary, excerpt, result_count, params_hash, result_hash, run_key)
           VALUES ($1, 'logs', 'adhoc', 't', 's', 'e', 1, 'nope', 'nope', 'run')`,
          [ticketId],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('survives its template being deleted and keeps the template name', async () => {
    const made = await template('short-lived');
    await app.query(
      `INSERT INTO evidence_card (ticket_id, kind, template_id, template_name, title, summary, excerpt, result_count, params_hash, result_hash, run_key)
       VALUES ($1, 'logs', $2, 'short-lived', 't', 's', 'e', 0, $3, $4, 'run-2')`,
      [ticketId, made.rows[0]?.id, hash(), hash()],
    );
    await app.query(`DELETE FROM tool_template WHERE id = $1`, [made.rows[0]?.id]);
    const left = await owner().query<{ template_id: string | null; template_name: string }>(
      `SELECT template_id, template_name FROM evidence_card WHERE run_key = 'run-2'`,
    );
    expect(left.rows).toEqual([{ template_id: null, template_name: 'short-lived' }]);
  });

  it('keeps a ticket that has cards (they are evidence)', async () => {
    expect(await code(owner().query(`DELETE FROM ticket WHERE id = $1`, [ticketId]))).toBe(
      FOREIGN_KEY_VIOLATION,
    );
  });
});

describe('0051 goes down and up again', () => {
  it('drops both tables and brings them back empty', async () => {
    const later = await migrationsAfter('0051_tool_template_evidence');
    const reverted = await migrateDown(owner(), { steps: later.length + 1 });
    expect(reverted[reverted.length - 1]).toBe('0051_tool_template_evidence');
    expect(await code(owner().query(`SELECT 1 FROM tool_template`))).toBe(UNDEFINED_TABLE);
    expect(await code(owner().query(`SELECT 1 FROM evidence_card`))).toBe(UNDEFINED_TABLE);
    expect(await migrateUp(owner())).toEqual(['0051_tool_template_evidence', ...later]);
    expect((await owner().query(`SELECT 1 FROM tool_template`)).rowCount).toBe(0);
    expect((await owner().query(`SELECT 1 FROM evidence_card`)).rowCount).toBe(0);
  });
});
