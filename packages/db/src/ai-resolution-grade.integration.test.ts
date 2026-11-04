import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0094 (T-301): the grader's verdict per resolution of a ticket. One row per (ticket, cycle);
// the CHECKs keep a class, a verdict and a quality score meaningful.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const UNDEFINED_TABLE = '42P01';

let testDb: TestDatabase;
let app: Pool;
let ticketId: string;
const owner = () => testDb.owner.pool;

const code = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const grade = (over: Record<string, unknown> = {}) => {
  const row = {
    cycle: 0,
    resolution_class: 'contained',
    draft_verdict: 'no_draft',
    draft_quality: null,
    prompt_version: 1,
    ...over,
  };
  return app.query(
    `INSERT INTO ai_resolution_grade (ticket_id, cycle, resolution_class, draft_verdict, draft_quality, prompt_version)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      ticketId,
      row.cycle,
      row.resolution_class,
      row.draft_verdict,
      row.draft_quality,
      row.prompt_version,
    ],
  );
};

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 3 });
  const org = await owner().query<{ id: string }>(
    `INSERT INTO organization (name) VALUES ('Example Org') RETURNING id`,
  );
  const ticket = await owner().query<{ id: string }>(
    `INSERT INTO ticket (org_id, subject) VALUES ($1, 'Cannot sign in') RETURNING id`,
    [org.rows[0]?.id],
  );
  ticketId = ticket.rows[0]?.id ?? '';
});
afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

describe('ai_resolution_grade', () => {
  it('lets the application role write a grade, one per ticket and resolution', async () => {
    await grade({ cycle: 0 });
    await grade({
      cycle: 1,
      resolution_class: 'verified',
      draft_verdict: 'partial',
      draft_quality: 0.5,
    });
    expect(await code(grade({ cycle: 0 }))).toBe(UNIQUE_VIOLATION);
    const rows = await app.query(`SELECT cycle FROM ai_resolution_grade WHERE ticket_id = $1`, [
      ticketId,
    ]);
    expect(rows.rowCount).toBe(2);
  });

  it('refuses an unknown class or verdict, a score outside 0..1, and a score that disagrees with the verdict', async () => {
    expect(await code(grade({ cycle: 5, resolution_class: 'solved' }))).toBe(CHECK_VIOLATION);
    expect(await code(grade({ cycle: 5, draft_verdict: 'great' }))).toBe(CHECK_VIOLATION);
    expect(await code(grade({ cycle: 5, draft_verdict: 'matches', draft_quality: 1.5 }))).toBe(
      CHECK_VIOLATION,
    );
    expect(await code(grade({ cycle: 5, draft_verdict: 'matches', draft_quality: null }))).toBe(
      CHECK_VIOLATION,
    );
    expect(await code(grade({ cycle: 5, draft_verdict: 'no_draft', draft_quality: 0.3 }))).toBe(
      CHECK_VIOLATION,
    );
  });
});

describe('0094 goes down and up again', () => {
  it('drops the table and brings it back', async () => {
    const later = await migrationsAfter('0094_ai_resolution_grade');
    const reverted = await migrateDown(owner(), { steps: later.length + 1 });
    expect(reverted[reverted.length - 1]).toBe('0094_ai_resolution_grade');
    expect(await code(owner().query(`SELECT 1 FROM ai_resolution_grade`))).toBe(UNDEFINED_TABLE);

    expect(await migrateUp(owner())).toEqual(['0094_ai_resolution_grade', ...later]);
    expect((await owner().query(`SELECT 1 FROM ai_resolution_grade`)).rowCount).toBe(0);
  });
});
