import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0113 (T-414, ADR-029 section 9.2 and 9.9): the stored narration of a screen element, and
// `my_work` as a kind of `ai_summary`. The application role reads and writes (the worker is the only
// writer by lint, C-15); the CHECKs and the unique key keep one narration per audience and language.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const UNDEFINED_TABLE = '42P01';

let testDb: TestDatabase;
let app: Pool;
let userId: string;
const owner = () => testDb.owner.pool;

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
  app = new Pool({ connectionString: testDb.appUrl, max: 3 });
  const user = await owner().query<{ id: string }>(
    `INSERT INTO users (email, name, role) VALUES ('insight@example.com', 'I', 'agent') RETURNING id`,
  );
  userId = user.rows[0]?.id ?? '';
});
afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

const insert = (
  extra: { locale?: string; scope?: string; org?: string | null; expires?: string } = {},
) =>
  app.query(
    `INSERT INTO ai_element_insight (element, scope_key, period, locale, org_id, facts, facts_fingerprint,
                                     claims, prompt_id, prompt_version, model, generated_at, expires_at)
     VALUES ('alerts.noise', $1, 'd7', $2, $3, '[]', 'fp', '[]', 'element_insight', 'v1', 'mock',
             now(), now() + $4::interval)`,
    [
      extra.scope ?? 'instance',
      extra.locale ?? 'en',
      extra.org ?? null,
      extra.expires ?? '6 hours',
    ],
  );

describe('ai_element_insight', () => {
  it('lets the application role write and read one narration per audience and language', async () => {
    await insert();
    await insert({ locale: 'th' });
    await insert({ scope: 'org:00000000-0000-4000-8000-000000000001' });
    expect((await app.query(`SELECT 1 FROM ai_element_insight`)).rowCount).toBe(3);
    expect(await code(insert())).toBe(UNIQUE_VIOLATION);
  });

  it('refuses a language that is not th or en, a narration that expires before it was made, and a wrong org', async () => {
    expect(await code(insert({ locale: 'fr', scope: 'x' }))).toBe(CHECK_VIOLATION);
    expect(await code(insert({ scope: 'y', expires: '-1 hour' }))).toBe(CHECK_VIOLATION);
    expect(await code(insert({ scope: 'z', org: '00000000-0000-4000-8000-0000000000aa' }))).toBe(
      FOREIGN_KEY_VIOLATION,
    );
    expect(
      await code(
        app.query(
          `INSERT INTO ai_element_insight (element, scope_key, period, locale, facts, facts_fingerprint, claims,
                                           prompt_id, prompt_version, model, generated_at, expires_at)
           VALUES ('e', 's', 'p', 'en', '{}', 'fp', '[]', 'p', 'v', 'm', now(), now() + interval '1 hour')`,
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('has the expiry index the purge uses', async () => {
    const indexes = await owner().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'ai_element_insight' ORDER BY indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'ai_element_insight_expires_idx',
        'ai_element_insight_key',
        'ai_element_insight_org_idx',
        'ai_element_insight_run_idx',
      ]),
    );
  });
});

describe('ai_summary kind my_work', () => {
  it('accepts my_work per person and language and still refuses an unknown kind', async () => {
    await app.query(
      `INSERT INTO ai_summary (kind, user_id, locale, fingerprint, claims, data_as_of)
       VALUES ('my_work', $1, 'th', 'a', '[]', now()), ('my_work', $1, 'en', 'a', '[]', now())`,
      [userId],
    );
    expect(
      await code(
        app.query(
          `INSERT INTO ai_summary (kind, user_id, fingerprint, claims, data_as_of) VALUES ('digest', $1, 'a', '[]', now())`,
          [userId],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });
});

describe('0113 goes down and up again', () => {
  it('drops the table and the my_work rows, restores the old CHECK, and comes back', async () => {
    const later = await migrationsAfter('0113_element_insights');
    const reverted = await migrateDown(owner(), { steps: later.length + 1 });
    expect(reverted[reverted.length - 1]).toBe('0113_element_insights');
    expect(await code(owner().query(`SELECT 1 FROM ai_element_insight`))).toBe(UNDEFINED_TABLE);
    expect((await owner().query(`SELECT 1 FROM ai_summary WHERE kind = 'my_work'`)).rowCount).toBe(
      0,
    );
    expect(
      await code(
        owner().query(
          `INSERT INTO ai_summary (kind, user_id, fingerprint, claims, data_as_of) VALUES ('my_work', $1, 'a', '[]', now())`,
          [userId],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
    await owner().query(
      `INSERT INTO ai_summary (kind, user_id, fingerprint, claims, data_as_of) VALUES ('brief', $1, 'a', '[]', now())`,
      [userId],
    );

    expect(await migrateUp(owner())).toEqual(['0113_element_insights', ...later]);
    expect((await owner().query(`SELECT 1 FROM ai_element_insight`)).rowCount).toBe(0);
    expect((await owner().query(`SELECT 1 FROM ai_summary WHERE kind = 'brief'`)).rowCount).toBe(1);
  });
});
