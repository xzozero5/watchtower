import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool, PoolClient } from 'pg';

/**
 * Reversible SQL migrations.
 *
 * Layout of the migrations directory (drizzle-kit writes the up files with
 * `drizzle-kit generate`; the matching `.down.sql` is written by hand, reviewed with the up file):
 *
 *   0001_create_things.sql        up
 *   0001_create_things.down.sql   down (required)
 *
 * drizzle's own migrator has no down step, which PRD section 8.1 requires, so this runner
 * replaces it and ignores drizzle-kit's `meta/` snapshots.
 */

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export const MIGRATIONS_TABLE = '__watchtower_migrations';

/** Held for the whole run so concurrent replicas cannot apply the same migration twice. */
const ADVISORY_LOCK_KEY = 726_150_001;

const UP_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const DOWN_FILE = /^(\d{4})_([a-z0-9_]+)\.down\.sql$/;

export interface Migration {
  /** File name without extension, e.g. `0001_create_things`. Sorts in apply order. */
  readonly id: string;
  readonly up: string;
  readonly down: string;
  /** sha256 of the up file, recorded when applied to detect later edits. */
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly id: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

export interface MigrationStatus {
  readonly id: string;
  readonly applied: boolean;
  readonly appliedAt?: Date;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface MigratorOptions {
  readonly dir?: string;
  readonly log?: (message: string) => void;
}

export async function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<Migration[]> {
  const files = await readdir(dir);
  const ups = new Map<string, string>();
  const downs = new Map<string, string>();
  for (const file of files) {
    const up = UP_FILE.exec(file);
    const down = DOWN_FILE.exec(file);
    if (up) ups.set(`${up[1] ?? ''}_${up[2] ?? ''}`, file);
    else if (down) downs.set(`${down[1] ?? ''}_${down[2] ?? ''}`, file);
  }

  for (const id of downs.keys()) {
    if (!ups.has(id)) throw new MigrationError(`${id}.down.sql has no matching ${id}.sql`);
  }

  const migrations: Migration[] = [];
  for (const id of [...ups.keys()].sort()) {
    const downFile = downs.get(id);
    if (downFile === undefined) {
      throw new MigrationError(
        `${id}.sql has no ${id}.down.sql: every migration must be reversible`,
      );
    }
    const up = await readFile(join(dir, `${id}.sql`), 'utf8');
    const down = await readFile(join(dir, downFile), 'utf8');
    migrations.push({ id, up, down, checksum: createHash('sha256').update(up).digest('hex') });
  }

  const prefixes = migrations.map((migration) => migration.id.slice(0, 4));
  if (new Set(prefixes).size !== prefixes.length) {
    throw new MigrationError('Two migrations share the same number prefix');
  }
  return migrations;
}

async function ensureTable(client: PoolClient): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
       id text PRIMARY KEY,
       checksum text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

async function readApplied(client: PoolClient): Promise<AppliedMigration[]> {
  const result = await client.query<{ id: string; checksum: string; applied_at: Date }>(
    `SELECT id, checksum, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY id`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

async function withLock<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    try {
      await ensureTable(client);
      return await run(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function inTransaction(
  client: PoolClient,
  sql: string,
  after: () => Promise<void>,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await after();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function assertConsistent(
  migrations: readonly Migration[],
  applied: readonly AppliedMigration[],
): void {
  const known = new Map(migrations.map((migration) => [migration.id, migration]));
  for (const row of applied) {
    const migration = known.get(row.id);
    if (!migration) {
      throw new MigrationError(
        `${row.id} is applied but its files are missing (database is ahead of this build)`,
      );
    }
    if (migration.checksum !== row.checksum) {
      throw new MigrationError(
        `${row.id} was edited after it was applied; add a new migration instead`,
      );
    }
  }
  const appliedIds = new Set(applied.map((row) => row.id));
  const lastApplied = applied.at(-1)?.id;
  for (const migration of migrations) {
    if (!appliedIds.has(migration.id) && lastApplied !== undefined && migration.id < lastApplied) {
      throw new MigrationError(
        `${migration.id} is older than the last applied migration ${lastApplied}`,
      );
    }
  }
}

/** Applies every pending migration, each in its own transaction. Returns the ids applied. */
export async function migrateUp(pool: Pool, options: MigratorOptions = {}): Promise<string[]> {
  const migrations = await loadMigrations(options.dir);
  return withLock(pool, async (client) => {
    const applied = await readApplied(client);
    assertConsistent(migrations, applied);
    const appliedIds = new Set(applied.map((row) => row.id));
    const done: string[] = [];
    for (const migration of migrations) {
      if (appliedIds.has(migration.id)) continue;
      await inTransaction(client, migration.up, async () => {
        await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (id, checksum) VALUES ($1, $2)`, [
          migration.id,
          migration.checksum,
        ]);
      });
      options.log?.(`applied ${migration.id}`);
      done.push(migration.id);
    }
    return done;
  });
}

/** Reverts the last `steps` applied migrations, newest first. Returns the ids reverted. */
export async function migrateDown(
  pool: Pool,
  options: MigratorOptions & { steps?: number } = {},
): Promise<string[]> {
  const steps = options.steps ?? 1;
  if (!Number.isInteger(steps) || steps < 1)
    throw new MigrationError('steps must be a positive integer');
  const migrations = await loadMigrations(options.dir);
  return withLock(pool, async (client) => {
    const applied = await readApplied(client);
    assertConsistent(migrations, applied);
    const known = new Map(migrations.map((migration) => [migration.id, migration]));
    const done: string[] = [];
    for (const row of applied.slice(-steps).reverse()) {
      const migration = known.get(row.id);
      if (!migration) throw new MigrationError(`${row.id} has no files to revert with`);
      await inTransaction(client, migration.down, async () => {
        await client.query(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = $1`, [migration.id]);
      });
      options.log?.(`reverted ${migration.id}`);
      done.push(migration.id);
    }
    return done;
  });
}

export async function migrationStatus(
  pool: Pool,
  options: MigratorOptions = {},
): Promise<MigrationStatus[]> {
  const migrations = await loadMigrations(options.dir);
  return withLock(pool, async (client) => {
    const applied = new Map((await readApplied(client)).map((row) => [row.id, row]));
    return migrations.map((migration) => {
      const row = applied.get(migration.id);
      return row
        ? { id: migration.id, applied: true, appliedAt: row.appliedAt }
        : { id: migration.id, applied: false };
    });
  });
}
