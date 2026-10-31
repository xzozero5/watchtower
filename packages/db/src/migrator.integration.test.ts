import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from './client.js';
import {
  loadMigrations,
  MIGRATIONS_TABLE,
  migrateDown,
  migrateUp,
  migrationStatus,
} from './migrator.js';

// Real Postgres from docker compose. Each run gets a throwaway database, so the dev data in the
// compose database is never touched.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const databaseName = `wt_test_${randomBytes(6).toString('hex')}`;

function urlFor(name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

let admin: Pool;
let database: Database;
let allIds: string[] = [];

async function installedExtensions(): Promise<string[]> {
  const result = await database.pool.query<{ extname: string }>(
    `SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm') ORDER BY extname`,
  );
  return result.rows.map((row) => row.extname);
}

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`CREATE DATABASE ${databaseName}`);
  database = createDatabase({ url: urlFor(databaseName), applicationName: 'wt-db-test' });
  allIds = (await loadMigrations()).map((migration) => migration.id);
});

afterAll(async () => {
  await database.close();
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await admin.end();
});

describe('migrations against real Postgres', () => {
  it('answers ping', async () => {
    await expect(database.ping()).resolves.toBeUndefined();
  });

  it('applies up, enabling vector and pg_trgm', async () => {
    expect(await installedExtensions()).toEqual([]);
    expect(allIds[0]).toBe('0000_extensions');
    expect(await migrateUp(database.pool)).toEqual(allIds);
    expect(await installedExtensions()).toEqual(['pg_trgm', 'vector']);
  });

  it('supports the extensions it enabled', async () => {
    const vector = await database.pool.query<{ distance: number }>(
      `SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance`,
    );
    expect(vector.rows[0]?.distance).toBe(1);
    const trigram = await database.pool.query<{ similarity: number }>(
      `SELECT similarity('watchtower', 'watchtowar') AS similarity`,
    );
    expect(trigram.rows[0]?.similarity).toBeGreaterThan(0.5);
  });

  it('is idempotent: a second up applies nothing', async () => {
    expect(await migrateUp(database.pool)).toEqual([]);
    expect((await migrationStatus(database.pool)).every((row) => row.applied)).toBe(true);
  });

  it('rolls back with down, then forward again (up, down, up)', async () => {
    // Newest first, so each down runs while what it depends on still exists.
    expect(await migrateDown(database.pool, { steps: allIds.length })).toEqual(
      [...allIds].reverse(),
    );
    expect(await installedExtensions()).toEqual([]);
    expect((await migrationStatus(database.pool))[0]?.applied).toBe(false);
    expect(await migrateUp(database.pool)).toEqual(allIds);
    expect(await installedExtensions()).toEqual(['pg_trgm', 'vector']);
  });

  it('is safe when two migrators start at once', async () => {
    await migrateDown(database.pool, { steps: allIds.length });
    const [a, b] = await Promise.all([migrateUp(database.pool), migrateUp(database.pool)]);
    expect([...a, ...b]).toEqual(allIds);
  });

  it('refuses to continue when an applied migration was edited', async () => {
    const migrations = await loadMigrations();
    await database.pool.query(`UPDATE ${MIGRATIONS_TABLE} SET checksum = 'tampered'`);
    await expect(migrateUp(database.pool)).rejects.toThrow(/edited after it was applied/);
    for (const migration of migrations) {
      await database.pool.query(`UPDATE ${MIGRATIONS_TABLE} SET checksum = $1 WHERE id = $2`, [
        migration.checksum,
        migration.id,
      ]);
    }
    await expect(migrateUp(database.pool)).resolves.toEqual([]);
  });

  it('rolls a failing migration back completely and records nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wt-bad-migration-'));
    try {
      await writeFile(join(dir, '0000_x.sql'), 'CREATE TABLE half_done (id int); SELECT boom();');
      await writeFile(join(dir, '0000_x.down.sql'), 'DROP TABLE IF EXISTS half_done;');
      const scratch = createDatabase({ url: urlFor(databaseName), max: 1 });
      try {
        await scratch.pool.query(`DROP TABLE IF EXISTS ${MIGRATIONS_TABLE}`);
        await expect(migrateUp(scratch.pool, { dir })).rejects.toThrow(/boom/);
        const leftover = await scratch.pool.query(`SELECT to_regclass('half_done') AS name`);
        expect(leftover.rows[0]).toEqual({ name: null });
        const recorded = await scratch.pool.query(
          `SELECT count(*)::int AS n FROM ${MIGRATIONS_TABLE}`,
        );
        expect(recorded.rows[0]).toEqual({ n: 0 });
      } finally {
        await scratch.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
