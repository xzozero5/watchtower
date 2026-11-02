import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Pool } from 'pg';

import { provisionAppRole } from './app-role.js';
import { createDatabase, type Database } from './client.js';
import { loadMigrations, migrateUp } from './migrator.js';

/**
 * Test support, imported as `@watchtower/db/testing`. Gives an integration test its own throwaway
 * database on the compose Postgres, so it never touches the data of the main stack and parallel
 * test files never see each other's rows.
 */

export interface TestDatabase {
  readonly name: string;
  /** Connection string of the schema owner: runs migrations and may do DDL. */
  readonly ownerUrl: string;
  /** Connection string of the restricted login role the api and worker use in compose. */
  readonly appUrl: string;
  readonly owner: Database;
  /** Drops the database and the login role. */
  cleanup(): Promise<void>;
}

function withCredentials(base: string, name: string, user?: string, password?: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  if (user !== undefined) url.username = user;
  if (password !== undefined) url.password = password;
  return url.toString();
}

async function waitForNoSessions(admin: Pool, database: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [database],
    );
    if ((rows[0]?.n ?? 0) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Ids of the migrations that sort after `id`, oldest first. A reversibility test reverts down to
 * the migration it is about and has to revert the newer ones first; asking for them here (instead
 * of listing them) means a migration added later does not break the test (T-123a).
 */
export async function migrationsAfter(id: string): Promise<string[]> {
  const ids = (await loadMigrations()).map((migration) => migration.id);
  const index = ids.indexOf(id);
  if (index === -1) throw new Error(`unknown migration ${id}`);
  return ids.slice(index + 1);
}

/**
 * @param adminUrl a superuser connection to any database on the server (`TEST_DATABASE_URL`)
 */
export async function createTestDatabase(adminUrl: string): Promise<TestDatabase> {
  const suffix = randomBytes(6).toString('hex');
  const name = `wt_test_${suffix}`;
  const appUser = `wt_app_${suffix}`;
  const appPassword = randomBytes(18).toString('hex');

  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  let owner: Database | undefined;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const ownerUrl = withCredentials(adminUrl, name);
    owner = createDatabase({ url: ownerUrl, max: 4, applicationName: 'wt-test-owner' });
    await migrateUp(owner.pool);
    await provisionAppRole(owner.pool, { user: appUser, password: appPassword });
    const database = owner;
    return {
      name,
      ownerUrl,
      appUrl: withCredentials(adminUrl, name, appUser, appPassword),
      owner: database,
      async cleanup() {
        await database.close();
        // `pool.end()` resolves before the server has seen every socket close. Dropping WITH (FORCE)
        // while a backend is still finishing sends 57P01 to a client that no longer has an error
        // listener, which vitest reports as an unhandled error. Wait briefly for the sessions to go.
        await waitForNoSessions(admin, name);
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await admin.query(`DROP ROLE IF EXISTS ${appUser}`);
        await admin.end();
      },
    };
  } catch (error) {
    await owner?.close().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${appUser}`).catch(() => undefined);
    await admin.end();
    throw error;
  }
}

export interface ProductMockDatabase {
  readonly name: string;
  /** The read-only login the data tool uses (columns only, no personal ones). */
  readonly readOnlyUrl: string;
  /** The owner, for a test that needs to look at or change the data. */
  readonly ownerUrl: string;
  cleanup(): Promise<void>;
}

/** The organizations the stand-in flow runs are seeded for (the ids in `examples/tools/fixtures.json` too). */
export const DEMO_ORG_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
];

const METRICS_DIR = new URL('../../../examples/metrics/', import.meta.url);

/**
 * A throwaway copy of `product_mock` (T-203c): the schema, seed and grants of `examples/metrics/`, a
 * database of its own (`wt_pm_*`, which `isSandboxDatabase` knows) and a random read-only login. The
 * same three files build the one compose creates, so the tests exercise what a deployment has.
 */
export async function createProductMockDatabase(adminUrl: string): Promise<ProductMockDatabase> {
  const suffix = randomBytes(6).toString('hex');
  const name = `wt_pm_${suffix}`;
  const role = `wt_pmro_${suffix}`;
  const reader = `${role}_reader`;
  const password = randomBytes(18).toString('hex');
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.query(`CREATE ROLE ${reader} NOLOGIN`);
    await admin.query(`CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${password}'`);
    const ownerUrl = withCredentials(adminUrl, name);
    pool = new Pool({ connectionString: ownerUrl, max: 1 });
    const read = (file: string): Promise<string> => readFile(new URL(file, METRICS_DIR), 'utf8');
    await pool.query(await read('product-mock.schema.sql'));
    await pool.query(await read('product-mock.seed.sql'));
    // The stand-in flow runs of the starter usage metrics (T-205a), for the two demo organizations.
    await pool.query(await read('product_mock.sql'));
    await pool.query('SELECT product_mock.seed($1::uuid[])', [DEMO_ORG_IDS]);
    await pool.query(
      (await read('product-mock.grants.sql'))
        .replaceAll('__RO_ROLE__', role)
        .replaceAll('__READER_ROLE__', reader),
    );
    await pool.end();
    pool = undefined;
    return {
      name,
      readOnlyUrl: withCredentials(adminUrl, name, role, password),
      ownerUrl,
      async cleanup() {
        await waitForNoSessions(admin, name);
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await admin.query(`DROP ROLE IF EXISTS ${role}`);
        await admin.query(`DROP ROLE IF EXISTS ${reader}`);
        await admin.end();
      },
    };
  } catch (error) {
    await pool?.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${reader}`).catch(() => undefined);
    await admin.end();
    throw error;
  }
}
