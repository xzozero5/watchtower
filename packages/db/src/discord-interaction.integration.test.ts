import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PG, isPgError } from './errors.js';
import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0045 (T-202b): the ids of Discord interactions already handled. The unique id is what makes
// a redelivery change nothing.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
let app: Pool;
const owner = (): Pool => testDb.owner.pool;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
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

describe('0045 discord_interaction', () => {
  it('records an interaction id once; a second delivery of it is a conflict the handler skips', async () => {
    await app.query(
      `INSERT INTO discord_interaction (id, outcome) VALUES ('123456789012345678', 'acked')`,
    );
    await rejects(
      app.query(
        `INSERT INTO discord_interaction (id, outcome) VALUES ('123456789012345678', 'acked')`,
      ),
      PG.uniqueViolation,
    );
    const skipped = await app.query(
      `INSERT INTO discord_interaction (id, outcome) VALUES ('123456789012345678', 'x') ON CONFLICT DO NOTHING RETURNING id`,
    );
    expect(skipped.rowCount).toBe(0);
  });

  it('keeps a snowflake and a short code, nothing else', async () => {
    await rejects(
      app.query(
        `INSERT INTO discord_interaction (id, outcome) VALUES ('not-a-snowflake', 'acked')`,
      ),
      PG.checkViolation,
    );
    await rejects(
      app.query(`INSERT INTO discord_interaction (id, outcome) VALUES ('223456789012345678', '')`),
      PG.checkViolation,
    );
    await rejects(
      app.query(
        `INSERT INTO discord_interaction (id, outcome) VALUES ('323456789012345678', repeat('x', 61))`,
      ),
      PG.checkViolation,
    );
  });

  it('stamps the handling time with the database clock', async () => {
    await app.query(
      `INSERT INTO discord_interaction (id, outcome) VALUES ('423456789012345678', 'acked')`,
    );
    const row = await owner().query<{ seconds: string }>(
      `SELECT abs(extract(epoch FROM clock_timestamp() - handled_at))::text AS seconds
         FROM discord_interaction WHERE id = '423456789012345678'`,
    );
    expect(Number(row.rows[0]?.seconds)).toBeLessThan(60);
  });
});

describe('0045 is reversible', () => {
  it('goes down and up again', async () => {
    const later = await migrationsAfter('0045_discord_interaction');
    if (later.length > 0) await migrateDown(owner(), { steps: later.length });
    expect(await migrateDown(owner(), { steps: 1 })).toEqual(['0045_discord_interaction']);
    const gone = await owner().query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'discord_interaction'`,
    );
    expect(gone.rowCount).toBe(0);
    expect(await migrateUp(owner())).toEqual(['0045_discord_interaction', ...later]);
  });
});
