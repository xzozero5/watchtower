import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../client.js';
import { createTestDatabase, type TestDatabase } from '../testing.js';
import { runSeed, seedYear } from './index.js';
import { markSeed } from './mark.js';

// ADR-025 section 10: the seed puts what it creates into a seed_batch; `db:mark-seed` does the same for rows
// seeded before migration 0096. Throwaway database, the seed runs with the schema owner's connection.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
let database: Database;
const owner = (): Pool => testDb.owner.pool;

async function n(sql: string): Promise<number> {
  const result = await owner().query<{ n: number }>(sql);
  return result.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  database = createDatabase({ url: testDb.ownerUrl, max: 2, applicationName: 'seed-batch-test' });
  await runSeed(database, {});
}, 120_000);

afterAll(async () => {
  await database.close();
  await testDb.cleanup();
});

describe('the default seed', () => {
  it('puts every organization and ticket it made into one demo batch', async () => {
    expect(await n(`SELECT count(*)::int AS n FROM seed_batch`)).toBe(1);
    expect(await n(`SELECT count(*)::int AS n FROM seed_batch WHERE kind = 'demo'`)).toBe(1);
    expect(await n(`SELECT count(*)::int AS n FROM organization`)).toBeGreaterThan(0);
    expect(await n(`SELECT count(*)::int AS n FROM organization WHERE seed_batch_id IS NULL`)).toBe(
      0,
    );
    expect(await n(`SELECT count(*)::int AS n FROM ticket`)).toBeGreaterThan(0);
    expect(await n(`SELECT count(*)::int AS n FROM ticket WHERE seed_batch_id IS NULL`)).toBe(0);
  });

  it('makes no second batch when run again', async () => {
    await runSeed(database, {});
    expect(await n(`SELECT count(*)::int AS n FROM seed_batch`)).toBe(1);
  });

  it('leaves the reference-only run without a batch', { timeout: 120_000 }, async () => {
    const other = await createTestDatabase(adminUrl);
    const db = createDatabase({ url: other.ownerUrl, max: 2, applicationName: 'seed-batch-ref' });
    try {
      await runSeed(db, { referenceOnly: true });
      const result = await other.owner.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM seed_batch`,
      );
      expect(result.rows[0]?.n).toBe(0);
    } finally {
      await db.close();
      await other.cleanup();
    }
  });
});

describe('the one-year scenario', () => {
  it('marks its organizations and tickets as a year batch, and nothing of a real customer', async () => {
    const other = await createTestDatabase(adminUrl);
    const db = createDatabase({ url: other.ownerUrl, max: 2, applicationName: 'seed-batch-year' });
    try {
      await runSeed(db, {});
      await other.owner.pool.query(`INSERT INTO organization (name) VALUES ('A Real Customer')`);
      const result = await seedYear(db, {
        now: new Date(),
        ticketKeyPrefix: 'OPS',
        ticketTarget: 40,
      });
      expect(result.skipped).toBe(false);
      const count = async (sql: string): Promise<number> =>
        (await other.owner.pool.query<{ n: number }>(sql)).rows[0]?.n ?? 0;
      expect(await count(`SELECT count(*)::int AS n FROM seed_batch WHERE kind = 'year'`)).toBe(1);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM organization WHERE seed_batch_id IN (SELECT id FROM seed_batch WHERE kind = 'year')`,
        ),
      ).toBeGreaterThan(3);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM ticket WHERE seed_batch_id IN (SELECT id FROM seed_batch WHERE kind = 'year')`,
        ),
      ).toBeGreaterThan(20);
      // Nothing of the year scenario is left without a batch, and a real organization stays out.
      expect(await count(`SELECT count(*)::int AS n FROM ticket WHERE seed_batch_id IS NULL`)).toBe(
        0,
      );
      expect(
        await count(`SELECT count(*)::int AS n FROM organization WHERE seed_batch_id IS NULL`),
      ).toBe(1);
    } finally {
      await db.close();
      await other.cleanup();
    }
  }, 280_000);
});

describe('db:mark-seed', () => {
  it('counts without writing in a dry run, marks on apply, and finds nothing the second time', async () => {
    // Pretend the instance was seeded before 0096: take the marks off (the schema owner may).
    await owner().query(`UPDATE ticket SET seed_batch_id = NULL`);
    await owner().query(`UPDATE organization SET seed_batch_id = NULL`);
    // A real organization with a real ticket, which must stay out.
    const org = await owner().query<{ id: string }>(
      `INSERT INTO organization (name) VALUES ('A Real Customer') RETURNING id`,
    );
    await owner().query(`INSERT INTO ticket (subject, org_id) VALUES ('real work', $1)`, [
      org.rows[0]?.id,
    ]);
    const totalTickets = await n(`SELECT count(*)::int AS n FROM ticket`);

    const dry = await markSeed(database, { dryRun: true });
    expect(dry.applied).toBe(false);
    const demo = dry.kinds.find((kind) => kind.kind === 'demo');
    expect(demo?.organizations).toBeGreaterThan(0);
    expect(demo?.tickets).toBe(totalTickets - 1);
    expect(demo?.leftAlone).toBe(0);
    expect(await n(`SELECT count(*)::int AS n FROM ticket WHERE seed_batch_id IS NOT NULL`)).toBe(
      0,
    );

    const applied = await markSeed(database, { dryRun: false });
    expect(applied.applied).toBe(true);
    expect(await n(`SELECT count(*)::int AS n FROM ticket WHERE seed_batch_id IS NULL`)).toBe(1);
    expect(
      await n(
        `SELECT count(*)::int AS n FROM organization WHERE seed_batch_id IS NULL AND name = 'A Real Customer'`,
      ),
    ).toBe(1);
    expect(
      await n(`SELECT count(*)::int AS n FROM seed_batch WHERE note LIKE 'marked afterwards%'`),
    ).toBe(1);

    const again = await markSeed(database, { dryRun: true });
    expect(again.kinds.every((kind) => kind.organizations === 0 && kind.tickets === 0)).toBe(true);
  });
});
