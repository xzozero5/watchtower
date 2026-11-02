import {
  DEFAULT_ROLE_PERMISSIONS,
  MANUAL_CHANNELS,
  ROLES,
  TICKET_CHANNELS,
} from '@watchtower/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0080 (T-137, T-136): the dev role, the manual channels, ticket.dev_owner_id and ticket_link.
// The seeded grants must equal DEFAULT_ROLE_PERMISSIONS in packages/shared.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const MIGRATION = '0080_dev_role_manual_ticket';

let testDb: TestDatabase;
const owner = (): Pool => testDb.owner.pool;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
});

afterAll(async () => {
  await testDb.cleanup();
});

async function insertUser(role: string, email: string): Promise<string> {
  const result = await owner().query<{ id: string }>(
    'INSERT INTO users (email, name, role) VALUES ($1, $1, $2) RETURNING id',
    [email, role],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('no user');
  return id;
}

async function insertOrg(name: string): Promise<string> {
  const result = await owner().query<{ id: string }>(
    `INSERT INTO organization (name, tier) VALUES ($1, 'standard') RETURNING id`,
    [name],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('no organization');
  return id;
}

async function insertTicket(orgId: string, channel: string): Promise<string> {
  const result = await owner().query<{ id: string }>(
    `INSERT INTO ticket (subject, org_id, channel) VALUES ('s', $1, $2) RETURNING id`,
    [orgId, channel],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('no ticket');
  return id;
}

describe('0080 dev role and manual ticket', () => {
  it('seeds the grants of every role as the shared defaults say, dev included', async () => {
    const rows = await owner().query<{ role: string; permission: string }>(
      'SELECT role, permission FROM role_permissions',
    );
    for (const role of ROLES) {
      const seeded = rows.rows
        .filter((row) => row.role === role)
        .map((row) => row.permission)
        .toSorted();
      expect(seeded).toEqual([...DEFAULT_ROLE_PERMISSIONS[role]].toSorted());
    }
    expect(DEFAULT_ROLE_PERMISSIONS.dev.length).toBeGreaterThan(0);
  });

  it('accepts a dev user and every ticket channel the shared list names, and nothing else', async () => {
    await insertUser('dev', 'dev-a@example.com');
    const orgId = await insertOrg('Channel Org');
    for (const channel of TICKET_CHANNELS) await insertTicket(orgId, channel);
    await expect(insertTicket(orgId, 'sms')).rejects.toThrow(/ticket_channel_check/);
    await expect(insertUser('janitor', 'bad-role@example.com')).rejects.toThrow(/users_role_check/);
  });

  it('keeps the manual channels out of channel accounts: nothing is delivered on them', async () => {
    for (const type of MANUAL_CHANNELS) {
      await expect(
        owner().query(`INSERT INTO channel_account (type, name) VALUES ($1, 'x')`, [type]),
      ).rejects.toThrow(/channel_account_type_check/);
    }
  });

  it('links a ticket to an incident or a deploy, exactly one of the two, once each', async () => {
    const orgId = await insertOrg('Link Org');
    const ticketId = await insertTicket(orgId, 'phone');
    const incident = await owner().query<{ id: string }>(
      `INSERT INTO incident (title, severity) VALUES ('Outage', 'SEV2') RETURNING id`,
    );
    const deploy = await owner().query<{ id: string }>(
      `INSERT INTO deploy (service_slug, version, env, source, external_id)
       VALUES ('api', 'v1', 'prod', 'ci', 'ext-1') RETURNING id`,
    );
    const incidentId = incident.rows[0]?.id;
    const deployId = deploy.rows[0]?.id;
    expect(incidentId).toBeDefined();
    expect(deployId).toBeDefined();

    await owner().query(
      `INSERT INTO ticket_link (ticket_id, kind, incident_id) VALUES ($1, 'incident', $2)`,
      [ticketId, incidentId],
    );
    await owner().query(
      `INSERT INTO ticket_link (ticket_id, kind, deploy_id) VALUES ($1, 'deploy', $2)`,
      [ticketId, deployId],
    );
    await expect(
      owner().query(
        `INSERT INTO ticket_link (ticket_id, kind, incident_id) VALUES ($1, 'incident', $2)`,
        [ticketId, incidentId],
      ),
    ).rejects.toThrow(/ticket_link_incident_key/);
    await expect(
      owner().query(
        `INSERT INTO ticket_link (ticket_id, kind, incident_id, deploy_id) VALUES ($1, 'incident', $2, $3)`,
        [ticketId, incidentId, deployId],
      ),
    ).rejects.toThrow(/ticket_link_target_check/);
    await expect(
      owner().query(`INSERT INTO ticket_link (ticket_id, kind) VALUES ($1, 'deploy')`, [ticketId]),
    ).rejects.toThrow(/ticket_link_target_check/);
  });

  it('goes down only when nothing would be orphaned, and comes up again', async () => {
    const later = await migrationsAfter(MIGRATION);
    const orgId = await insertOrg('Revert Org');
    const ticketId = await insertTicket(orgId, 'portal');
    const devId = await insertUser('dev', 'dev-owner@example.com');
    await owner().query('UPDATE ticket SET dev_owner_id = $1 WHERE id = $2', [devId, ticketId]);

    // Newer migrations first, then 0080 itself refuses while a dev user, a manual-channel ticket or a
    // dev owner exists.
    if (later.length > 0) await migrateDown(owner(), { steps: later.length });
    await expect(migrateDown(owner())).rejects.toThrow(/cannot revert 0080/);

    await owner().query('UPDATE ticket SET dev_owner_id = NULL');
    await expect(migrateDown(owner())).rejects.toThrow(/users with role dev exist/);
    await owner().query(`DELETE FROM users WHERE role = 'dev'`);
    await expect(migrateDown(owner())).rejects.toThrow(/manual channel/);
    await owner().query(
      `DELETE FROM ticket WHERE channel IN ('phone', 'walk_in', 'chat', 'other')`,
    );

    expect(await migrateDown(owner())).toEqual([MIGRATION]);
    const gone = await owner().query(
      `SELECT 1 FROM permissions WHERE key IN ('ticket.read.masked', 'ticket.dev.work')`,
    );
    expect(gone.rowCount).toBe(0);
    const column = await owner().query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'ticket' AND column_name = 'dev_owner_id'`,
    );
    expect(column.rowCount).toBe(0);

    expect(await migrateUp(owner())).toEqual([MIGRATION, ...later]);
    const back = await owner().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM role_permissions WHERE role = 'dev'`,
    );
    expect(back.rows[0]?.n).toBe(DEFAULT_ROLE_PERMISSIONS.dev.length);
  });
});
