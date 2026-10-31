import { randomBytes } from 'node:crypto';

import { Pool } from 'pg';

import { provisionAppRole } from './app-role.js';
import { createDatabase, type Database } from './client.js';
import { migrateUp } from './migrator.js';

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
