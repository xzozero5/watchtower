import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLES } from '@watchtower/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0006 (T-123a): the Phase 1 permission strings and their default grants. The roles'
// seeded rows must equal DEFAULT_ROLE_PERMISSIONS in packages/shared (auth.integration.test.ts
// checks the whole matrix; this file checks the Phase 1 slice and the revert).
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const PHASE_1 = [
  'inbound.read',
  'outbox.manage',
  'view.share',
  'ai.emergency_switch',
  'shift.note.write',
  'handoff.ack',
  'csat.read',
  'ai.run.read',
] as const;

// Permissions added by later migrations; they go when the steps are reverted too.
const ADDED_LATER = [
  'ticket.cancel.any',
  'kb.read.customer',
  'kb.publish.break_glass',
] as const;

let testDb: TestDatabase;
const owner = (): Pool => testDb.owner.pool;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
});

afterAll(async () => {
  await testDb.cleanup();
});

async function phase1Rows(): Promise<{ keys: string[]; grants: string[] }> {
  const keys = await owner().query<{ key: string }>(
    'SELECT key FROM permissions WHERE key = ANY($1) ORDER BY key',
    [PHASE_1],
  );
  const grants = await owner().query<{ role: string; permission: string }>(
    'SELECT role, permission FROM role_permissions WHERE permission = ANY($1)',
    [PHASE_1],
  );
  return {
    keys: keys.rows.map((row) => row.key),
    grants: grants.rows.map((row) => `${row.role}:${row.permission}`).toSorted(),
  };
}

describe('0006 Phase 1 permissions', () => {
  it('seeds the permission strings with the descriptions of the shared vocabulary', async () => {
    const rows = await owner().query<{ key: string; description: string }>(
      'SELECT key, description FROM permissions WHERE key = ANY($1)',
      [PHASE_1],
    );
    expect(Object.fromEntries(rows.rows.map((row) => [row.key, row.description]))).toEqual(
      Object.fromEntries(PHASE_1.map((key) => [key, PERMISSIONS[key]])),
    );
  });

  it('grants exactly what the shared defaults say, to nobody else', async () => {
    const expected = ROLES.flatMap((role) =>
      DEFAULT_ROLE_PERMISSIONS[role]
        .filter((permission) => (PHASE_1 as readonly string[]).includes(permission))
        .map((permission) => `${role}:${permission}`),
    ).toSorted();
    expect((await phase1Rows()).grants).toEqual(expected);
    expect(expected.some((grant) => grant.startsWith('client:'))).toBe(false);
    expect(expected.some((grant) => grant.startsWith('system:'))).toBe(false);
  });

  it('goes down (taking its grants, including a hand-made one) and up again', async () => {
    const before = await phase1Rows();
    // A head may have granted a new string to another role by hand; it must go with the string.
    await owner().query(`INSERT INTO role_permissions (role, permission) VALUES ('client', $1)`, [
      'csat.read',
    ]);

    const later = await migrationsAfter('0006_phase1_permissions');
    const reverted = await migrateDown(owner(), { steps: 1 + later.length });
    expect(reverted).toEqual([...later.toReversed(), '0006_phase1_permissions']);
    expect(await phase1Rows()).toEqual({ keys: [], grants: [] });
    // The strings that existed before 0006 are untouched.
    const remaining = await owner().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM permissions',
    );
    expect(remaining.rows[0]?.n).toBe(
      Object.keys(PERMISSIONS).length - PHASE_1.length - ADDED_LATER.length,
    );

    expect(await migrateUp(owner())).toEqual(['0006_phase1_permissions', ...later]);
    expect(await phase1Rows()).toEqual(before);
  });
});
