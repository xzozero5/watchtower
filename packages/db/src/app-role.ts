import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

import type { Pool } from 'pg';

/** Group role created by migration 0001. Login roles of the api and worker are members of it. */
export const APP_ROLE_GROUP = 'watchtower_app';

const LOGIN_ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const RESERVED_NAMES = new Set([APP_ROLE_GROUP, 'postgres']);
const SCRAM_ITERATIONS = 4096;

/**
 * PostgreSQL SCRAM-SHA-256 verifier for a password. Sending the verifier instead of the clear
 * password keeps the password out of the server's statement log.
 */
export function scramVerifier(password: string): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${String(SCRAM_ITERATIONS)}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

export interface AppRoleOptions {
  /** Login role to create or update, for example `watchtower_api`. */
  readonly user: string;
  readonly password: string;
}

/**
 * Creates (or updates the password of) a login role and makes it a member of `watchtower_app`, so
 * the api and worker run without ownership of the schema: no DDL, and no UPDATE/DELETE on the
 * audit log. Idempotent. Run it as the migration owner, after `migrateUp`.
 */
export async function provisionAppRole(
  pool: Pool,
  options: AppRoleOptions,
): Promise<'created' | 'updated'> {
  if (!LOGIN_ROLE_NAME.test(options.user) || RESERVED_NAMES.has(options.user)) {
    throw new Error(
      'app role name must be lowercase letters, digits or underscores and not reserved',
    );
  }
  if (options.password.length < 8)
    throw new Error('app role password must be at least 8 characters');

  const client = await pool.connect();
  try {
    const role = client.escapeIdentifier(options.user);
    const verifier = client.escapeLiteral(scramVerifier(options.password));
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [options.user]);
    const created = exists.rowCount === 0;
    await client.query(
      created
        ? `CREATE ROLE ${role} LOGIN PASSWORD ${verifier}`
        : `ALTER ROLE ${role} WITH LOGIN PASSWORD ${verifier}`,
    );
    await client.query(`GRANT ${APP_ROLE_GROUP} TO ${role}`);
    return created ? 'created' : 'updated';
  } finally {
    client.release();
  }
}
