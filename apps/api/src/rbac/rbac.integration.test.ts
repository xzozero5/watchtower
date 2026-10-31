import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  LOCKED_HEAD_PERMISSIONS,
  type Role,
  type SessionInfo,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createOrg,
  startHarness,
  uniqueEmail,
  type Harness,
  type TestClient,
} from '../testing/harness.js';
import { ProbeController } from '../testing/test-controllers.js';

// Roles, permissions, users, organization scoping and the role editor, on the real application.

let h: Harness;
let orgA: string;
let orgB: string;

beforeAll(async () => {
  h = await startHarness({ controllers: [ProbeController] });
  orgA = await createOrg(h.db.owner.pool);
  orgB = await createOrg(h.db.owner.pool);
});

afterAll(async () => {
  await h.close();
});

const pool = () => h.db.owner.pool;

async function login(role: 'agent' | 'lead' | 'head' | 'client', orgId?: string) {
  const client = h.client();
  const email = uniqueEmail(role);
  const session = await client.devLogin(email, role, orgId === undefined ? {} : { orgId });
  return { client, email, session };
}

async function auditCount(where: string, params: unknown[] = []): Promise<number> {
  const result = await pool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE ${where}`,
    params,
  );
  return result.rows[0]?.n ?? 0;
}

describe('role matrix (PRD section 2.2)', () => {
  it.each(['agent', 'lead', 'head', 'client'] as const)(
    '%s gets exactly the permissions of the seeded matrix',
    async (role) => {
      const { session } = await login(role, role === 'client' ? orgA : undefined);
      expect(session.permissions).toEqual([...DEFAULT_ROLE_PERMISSIONS[role]].toSorted());
    },
  );

  it('gives a system identity nothing by default, and no way to sign in as one', async () => {
    expect(DEFAULT_ROLE_PERMISSIONS.system).toEqual([]);
    const email = uniqueEmail('robot');
    await pool().query(`INSERT INTO users (email, name, role) VALUES ($1, 'Robot', 'system')`, [
      email,
    ]);
    // No sign-in method starts a session for a system identity, not even the dev login.
    const response = await h.client().post('/v1/auth/dev-login', { email, role: 'agent' });
    expect(response.status).toBe(403);
    const link = await h.client().post('/v1/auth/magic-link/request', { email });
    expect(link.status).toBe(202);
    const sessions = await pool().query(
      'SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1',
      [email],
    );
    expect(sessions.rowCount).toBe(0);
  });

  // [method, path, body, who may call it]
  const cases: readonly (readonly [string, string, unknown, readonly Role[]])[] = [
    ['GET', '/v1/audit-logs', undefined, ['head']],
    ['GET', '/v1/rbac/roles', undefined, ['head']],
    ['GET', '/v1/users', undefined, ['lead', 'head']],
    ['GET', '/test/plain-read', undefined, ['agent', 'lead', 'head']],
    ['GET', '/v1/auth/session', undefined, ['agent', 'lead', 'head', 'client']],
    ['GET', '/v1/auth/sessions', undefined, ['agent', 'lead', 'head', 'client']],
    ['POST', '/test/mutate', { note: 'n' }, ['agent', 'lead', 'head']],
  ];

  it.each(cases)('%s %s is allowed for %j only', async (method, path, body, allowed) => {
    for (const role of ['agent', 'lead', 'head', 'client'] as const) {
      const { client } = await login(role, role === 'client' ? orgA : undefined);
      const response = await client.request(method, path, body === undefined ? {} : { body });
      const expected = allowed.includes(role);
      expect(response.status < 300, `${role} ${method} ${path} -> ${String(response.status)}`).toBe(
        expected,
      );
      if (!expected) expect(response.status).toBe(403);
    }
  });

  it('records every refusal in the audit log, attributed to the caller', async () => {
    const { client, session } = await login('agent');
    const before = await auditCount(`action = 'authz.denied' AND actor_id = $1`, [session.user.id]);
    expect((await client.get('/v1/audit-logs')).status).toBe(403);
    expect((await client.get('/v1/rbac/roles')).status).toBe(403);
    const rows = await pool().query<{
      outcome: string;
      actor_type: string;
      metadata: { route: string; required: string[] };
    }>(
      `SELECT outcome, actor_type, metadata FROM audit_log WHERE action = 'authz.denied' AND actor_id = $1 ORDER BY created_at`,
      [session.user.id],
    );
    expect(rows.rowCount).toBe(before + 2);
    expect(rows.rows[0]).toMatchObject({ outcome: 'denied', actor_type: 'user' });
    expect(rows.rows.map((row) => row.metadata.route)).toEqual([
      '/v1/audit-logs',
      '/v1/rbac/roles',
    ]);
    expect(rows.rows[0]?.metadata.required).toEqual(['audit.read']);
  });

  it('does not run a refused request: no side effect, no matter the body', async () => {
    const { client } = await login('agent');
    const email = uniqueEmail('sneaky');
    const attempt = await client.post('/v1/users', { email, name: 'Sneaky', role: 'head' });
    expect(attempt.status).toBe(403);
    const created = await pool().query('SELECT 1 FROM users WHERE email = $1', [email]);
    expect(created.rowCount).toBe(0);
  });
});

describe('user administration', () => {
  it('lets a head create staff and a lead only invite clients', async () => {
    const { client: head } = await login('head');
    const { client: lead } = await login('lead');
    const staffEmail = uniqueEmail('new-agent');

    const created = await head.post<{ id: string; role: string; status: string }>('/v1/users', {
      email: staffEmail.toUpperCase(),
      name: 'New Agent',
      role: 'agent',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ role: 'agent', status: 'active' });
    const stored = await pool().query<{ email: string }>('SELECT email FROM users WHERE id = $1', [
      created.body.id,
    ]);
    expect(stored.rows[0]?.email).toBe(staffEmail);

    const leadStaff = await lead.post<{ code: string }>('/v1/users', {
      email: uniqueEmail('x'),
      name: 'X',
      role: 'agent',
    });
    expect(leadStaff.status).toBe(403);

    const leadClient = await lead.post<{ id: string; orgId: string }>('/v1/users', {
      email: uniqueEmail('invited'),
      name: 'Invited',
      role: 'client',
      orgId: orgA,
    });
    expect(leadClient.status).toBe(201);
    expect(leadClient.body.orgId).toBe(orgA);
  });

  it('keeps a client in exactly one organization and an email on exactly one account', async () => {
    const { client: head } = await login('head');
    const email = uniqueEmail('twice');
    expect(
      (await head.post('/v1/users', { email, name: 'C', role: 'client', orgId: orgA })).status,
    ).toBe(201);
    const again = await head.post<{ code: string }>('/v1/users', {
      email,
      name: 'C',
      role: 'client',
      orgId: orgB,
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('conflict');
    const rows = await pool().query<{ org_id: string }>(
      'SELECT org_id FROM users WHERE email = $1',
      [email],
    );
    expect(rows.rows).toEqual([{ org_id: orgA }]);

    expect(
      (await head.post('/v1/users', { email: uniqueEmail('c'), name: 'C', role: 'client' })).status,
    ).toBe(400);
    expect(
      (
        await head.post('/v1/users', {
          email: uniqueEmail('s'),
          name: 'S',
          role: 'agent',
          orgId: orgA,
        })
      ).status,
    ).toBe(400);
    expect(
      (await head.post('/v1/users', { email: uniqueEmail('r'), name: 'R', role: 'system' })).status,
    ).toBe(400);
  });

  it('updates a user and records before and after in the audit log', async () => {
    const { client: head } = await login('head');
    const { session: target } = await login('agent');
    const updated = await head.patch<{ role: string; name: string }>(
      `/v1/users/${target.user.id}`,
      {
        role: 'lead',
        name: 'Promoted',
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ role: 'lead', name: 'Promoted' });

    const rows = await pool().query<{
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      actor_id: string;
    }>(
      `SELECT before, after, actor_id FROM audit_log WHERE action = 'user.update' AND target_id = $1`,
      [target.user.id],
    );
    expect(rows.rowCount).toBe(1);
    // Ids and states only: no address, no name (C-9).
    expect(rows.rows[0]?.before).toEqual({
      id: target.user.id,
      role: 'agent',
      status: 'active',
      hasEmail: true,
    });
    expect(rows.rows[0]?.after).toEqual({
      id: target.user.id,
      role: 'lead',
      status: 'active',
      hasEmail: true,
    });
    const raw = JSON.stringify(rows.rows[0]);
    expect(raw).not.toContain('Promoted');
    expect(raw).not.toContain(target.user.email);
  });

  it('applies a role change to a signed-in user on their next request', async () => {
    const { client: head } = await login('head');
    const { client: agent, session } = await login('agent');
    expect((await agent.get('/v1/users')).status).toBe(403);
    await head.patch(`/v1/users/${session.user.id}`, { role: 'lead' });
    expect((await agent.get('/v1/users')).status).toBe(200);
    await head.patch(`/v1/users/${session.user.id}`, { role: 'agent' });
    expect((await agent.get('/v1/users')).status).toBe(403);
  });

  it('refuses the changes that would lock people out or change the wrong account', async () => {
    const { client: head, session: self } = await login('head');
    expect((await head.patch(`/v1/users/${self.user.id}`, { role: 'agent' })).status).toBe(409);
    expect((await head.patch(`/v1/users/${self.user.id}`, { status: 'disabled' })).status).toBe(
      409,
    );
    expect((await head.patch(`/v1/users/${self.user.id}`, { name: 'Fine' })).status).toBe(200);

    const bgEmail = uniqueEmail('bg');
    const bg = await pool().query<{ id: string }>(
      `INSERT INTO users (email, name, role, password_hash, is_break_glass)
       VALUES ($1, 'BG', 'head', '$argon2id$placeholder', true) RETURNING id`,
      [bgEmail],
    );
    expect(
      (await head.patch(`/v1/users/${bg.rows[0]?.id ?? ''}`, { status: 'disabled' })).status,
    ).toBe(409);

    const client = await pool().query<{ id: string }>(
      `INSERT INTO users (email, name, role, org_id) VALUES ($1, 'C', 'client', $2) RETURNING id`,
      [uniqueEmail('c'), orgA],
    );
    expect(
      (await head.patch(`/v1/users/${client.rows[0]?.id ?? ''}`, { role: 'agent' })).status,
    ).toBe(409);
    expect((await head.patch(`/v1/users/${randomUUID()}`, { name: 'Ghost' })).status).toBe(404);
    expect((await head.patch(`/v1/users/not-a-uuid`, { name: 'x' })).status).toBe(400);
    expect((await head.patch(`/v1/users/${self.user.id}`, {})).status).toBe(400);
  });

  it('lists users to a lead and a head, never to an agent or a client', async () => {
    const { client: lead } = await login('lead');
    const response = await lead.get<{ users: { email: string; isBreakGlass: boolean }[] }>(
      '/v1/users',
    );
    expect(response.status).toBe(200);
    expect(response.body.users.length).toBeGreaterThan(0);
    expect(JSON.stringify(response.body)).not.toMatch(/password|hash|argon2/i);
    expect((await (await login('client', orgA)).client.get('/v1/users')).status).toBe(403);
  });
});

describe('role editor (permissions change without a deploy)', () => {
  async function restoreDefaults(head: TestClient, role: Role) {
    await head.put(`/v1/rbac/roles/${role}/permissions`, {
      permissions: DEFAULT_ROLE_PERMISSIONS[role],
    });
  }

  it('lists roles with a catalog of every permission string', async () => {
    const { client } = await login('head');
    const response = await client.get<{
      roles: { role: string; permissions: string[] }[];
      catalog: { key: string; description: string }[];
    }>('/v1/rbac/roles');
    expect(response.status).toBe(200);
    expect(response.body.roles.map((entry) => entry.role)).toEqual([
      'agent',
      'lead',
      'head',
      'client',
      'system',
    ]);
    expect(response.body.catalog.length).toBeGreaterThan(30);
    expect(response.body.roles.find((entry) => entry.role === 'client')?.permissions).toEqual(
      expect.arrayContaining(['ticket.read.org', 'ticket.reply.own']),
    );
  });

  it('grants and revokes a permission to a role, effective on the next request', async () => {
    const { client: head } = await login('head');
    const { client: agent, session } = await login('agent');
    expect((await agent.get('/v1/users')).status).toBe(403);

    const granted = await head.put<{ permissions: string[] }>('/v1/rbac/roles/agent/permissions', {
      permissions: [...DEFAULT_ROLE_PERMISSIONS.agent, 'user.read'],
    });
    expect(granted.status).toBe(200);
    expect(granted.body.permissions).toContain('user.read');
    expect((await agent.get('/v1/users')).status).toBe(200);
    expect((await agent.get<SessionInfo>('/v1/auth/session')).body.permissions).toContain(
      'user.read',
    );

    await restoreDefaults(head, 'agent');
    expect((await agent.get('/v1/users')).status).toBe(403);

    const rows = await pool().query<{ before: string[]; after: string[]; actor_id: string }>(
      `SELECT before, after, actor_id FROM audit_log
        WHERE action = 'rbac.role_permissions.set' AND target_id = 'agent' ORDER BY created_at`,
    );
    const grant = rows.rows.find((row) => row.after.includes('user.read'));
    expect(grant?.before).not.toContain('user.read');
    expect(grant?.actor_id).toBeDefined();
    expect(session.user.role).toBe('agent');
  });

  it('refuses to strip the head role of the permissions that undo mistakes', async () => {
    const { client: head } = await login('head');
    for (const locked of LOCKED_HEAD_PERMISSIONS) {
      const without = DEFAULT_ROLE_PERMISSIONS.head.filter((permission) => permission !== locked);
      const attempt = await head.put<{ code: string }>('/v1/rbac/roles/head/permissions', {
        permissions: without,
      });
      expect(attempt.status, locked).toBe(409);
    }
    expect((await head.get('/v1/rbac/roles')).status).toBe(200);
  });

  it('rejects unknown permissions and unknown roles', async () => {
    const { client: head } = await login('head');
    expect(
      (
        await head.put('/v1/rbac/roles/agent/permissions', {
          permissions: ['ticket.read', 'made.up'],
        })
      ).status,
    ).toBe(400);
    expect(
      (await head.put('/v1/rbac/roles/superuser/permissions', { permissions: [] })).status,
    ).toBe(400);
    expect((await head.put('/v1/rbac/roles/agent/permissions', {})).status).toBe(400);
  });

  it('is for the head only', async () => {
    for (const role of ['agent', 'lead'] as const) {
      const { client } = await login(role);
      expect(
        (await client.put('/v1/rbac/roles/agent/permissions', { permissions: [] })).status,
      ).toBe(403);
    }
    const { client: agent } = await login('agent');
    const info = await agent.get<SessionInfo>('/v1/auth/session');
    expect(info.body.permissions).toContain('ticket.read');
  });

  it('adds per-user extra permissions on top of the role, ignoring strings it does not know', async () => {
    const { client: agent, session } = await login('agent');
    expect((await agent.get('/v1/audit-logs')).status).toBe(403);
    await pool().query(
      `UPDATE users SET permissions = ARRAY['audit.read', 'not.a.permission'] WHERE id = $1`,
      [session.user.id],
    );
    expect((await agent.get('/v1/audit-logs')).status).toBe(200);
    const info = await agent.get<SessionInfo>('/v1/auth/session');
    expect(info.body.permissions).toContain('audit.read');
    expect(info.body.permissions).not.toContain('not.a.permission');
  });
});

describe('organization scope for clients', () => {
  async function seedOrgUsers() {
    const inA = [uniqueEmail('a1'), uniqueEmail('a2')];
    const inB = [uniqueEmail('b1')];
    for (const email of inA) {
      await pool().query(
        `INSERT INTO users (email, name, role, org_id) VALUES ($1, 'U', 'client', $2)`,
        [email, orgA],
      );
    }
    for (const email of inB) {
      await pool().query(
        `INSERT INTO users (email, name, role, org_id) VALUES ($1, 'U', 'client', $2)`,
        [email, orgB],
      );
    }
    return { inA, inB };
  }

  it('shows a client their own organization and nothing of another', async () => {
    const { inA, inB } = await seedOrgUsers();
    const { client } = await login('client', orgA);

    const own = await client.get<{ emails: string[] }>(`/test/org/${orgA}/users`);
    expect(own.status).toBe(200);
    expect(own.body.emails).toEqual(expect.arrayContaining(inA));
    expect(own.body.emails).not.toEqual(expect.arrayContaining(inB));

    const other = await client.get<{ code: string }>(`/test/org/${orgB}/users`);
    expect(other.status).toBe(404);
    expect(JSON.stringify(other.body)).not.toContain(inB[0] ?? 'x-missing');
  });

  it('answers 404, not 403, so a client cannot tell which organizations exist', async () => {
    const { client } = await login('client', orgA);
    const existing = await client.get<{ code: string; message: string }>(`/test/org/${orgB}/users`);
    const imaginary = await client.get<{ code: string; message: string }>(
      `/test/org/${randomUUID()}/users`,
    );
    expect(existing.status).toBe(404);
    expect(imaginary.status).toBe(404);
    expect(existing.body).toEqual(imaginary.body);
  });

  it('lets staff see any organization', async () => {
    const { inB } = await seedOrgUsers();
    const { client } = await login('agent');
    const response = await client.get<{ emails: string[] }>(`/test/org/${orgB}/users`);
    expect(response.status).toBe(200);
    expect(response.body.emails).toEqual(expect.arrayContaining(inB));
  });

  it('puts the organization in the session and cannot be switched by the client', async () => {
    const { client, session } = await login('client', orgA);
    expect(session.user.orgId).toBe(orgA);
    // A second dev login for the same address, claiming another org, still gets the stored one.
    const again = h.client();
    const info = await again.devLogin(session.user.email, 'client', { orgId: orgB });
    expect(info.user.orgId).toBe(orgA);
    expect((await client.get<SessionInfo>('/v1/auth/session')).body.user.orgId).toBe(orgA);
  });
});
