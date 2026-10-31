import type { AuditLogEntry } from '@watchtower/shared';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createOrg,
  startHarness,
  uniqueEmail,
  type Harness,
  type TestClient,
} from '../testing/harness.js';
import { ProbeController } from '../testing/test-controllers.js';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '@watchtower/db';

// The audit interceptor, redaction, PII-read logging, immutability and the head's audit endpoint,
// on the real application and the real (partitioned, trigger-protected) table.

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ controllers: [ProbeController] });
});

afterAll(async () => {
  await h.close();
});

const pool = () => h.db.owner.pool;

async function signedIn(role: 'agent' | 'lead' | 'head' = 'agent') {
  const client = h.client();
  const session = await client.devLogin(uniqueEmail(role), role);
  return { client, session };
}

interface Row {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  outcome: string;
  target_type: string | null;
  target_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
}

async function rows(where: string, params: unknown[] = []): Promise<Row[]> {
  const result = await pool().query<Row>(
    `SELECT * FROM audit_log WHERE ${where} ORDER BY created_at, id`,
    params,
  );
  return result.rows;
}

describe('every mutation is audited', () => {
  it('writes a row for a route nobody annotated, with who, where from and which request', async () => {
    const { client, session } = await signedIn();
    const response = await client.post('/test/unnamed', {});
    expect(response.status).toBe(201);

    const [row] = await rows(`action = 'http.POST /test/unnamed' AND actor_id = $1`, [
      session.user.id,
    ]);
    expect(row).toMatchObject({
      actor_type: 'user',
      actor_id: session.user.id,
      outcome: 'success',
      ip: client.ip,
      request_id: response.headers.get('x-request-id'),
    });
    expect(row?.metadata).toMatchObject({ method: 'POST', route: '/test/unnamed', status: 201 });
  });

  it('uses the action, target, before and after the handler supplies', async () => {
    const { client, session } = await signedIn();
    await client.post('/test/mutate', { note: 'changed' });
    const [row] = await rows(`action = 'test.mutate' AND actor_id = $1`, [session.user.id]);
    expect(row).toMatchObject({ target_type: 'widget', target_id: 'widget-1', outcome: 'success' });
    expect(row?.before).toMatchObject({ note: 'old' });
    expect(row?.after).toMatchObject({ note: 'changed' });
  });

  it('records a refused or failed mutation as such, with the status and error code', async () => {
    const { client, session } = await signedIn();
    expect((await client.post('/test/boom', {})).status).toBe(409);
    const [boom] = await rows(`action = 'test.boom' AND actor_id = $1`, [session.user.id]);
    expect(boom).toMatchObject({ outcome: 'failure' });
    expect(boom?.metadata).toMatchObject({ status: 409, errorCode: 'conflict' });

    // A body the schema rejects still leaves a trace.
    expect((await client.post('/test/mutate', {})).status).toBe(400);
    const failures = await rows(
      `action = 'test.mutate' AND actor_id = $1 AND outcome = 'failure'`,
      [session.user.id],
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.metadata).toMatchObject({ status: 400 });
  });

  it('does not write a row for a plain read', async () => {
    const { client, session } = await signedIn();
    const before = await rows(`actor_id = $1`, [session.user.id]);
    await client.get('/test/plain-read');
    await client.get('/v1/auth/session');
    expect(await rows(`actor_id = $1`, [session.user.id])).toHaveLength(before.length);
  });

  it('puts the row in the partition of the current month', async () => {
    const { client, session } = await signedIn();
    await client.post('/test/unnamed', {});
    const where = await pool().query<{ part: string }>(
      `SELECT tableoid::regclass::text AS part FROM audit_log WHERE actor_id = $1 AND action LIKE 'http.%' LIMIT 1`,
      [session.user.id],
    );
    const now = new Date();
    const month = `${String(now.getUTCFullYear())}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(where.rows[0]?.part).toBe(`audit_log_p${month}`);
  });

  it('writes one row, not two, when a service audits inside its own transaction', async () => {
    const { client } = await signedIn();
    const response = await client.post('/test/atomic', {});
    expect(response.status).toBe(201);
    const written = await rows(`action = 'test.atomic' AND target_id = 'w-atomic'`);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ actor_type: 'system', actor_id: 'atomic-test' });
  });
});

describe('reads of personal data', () => {
  it('are audited when the route says it returns PII, naming the record', async () => {
    const { client, session } = await signedIn();
    const response = await client.get('/test/pii/contact-42');
    expect(response.status).toBe(200);
    const [row] = await rows(`action = 'pii.read' AND actor_id = $1`, [session.user.id]);
    expect(row).toMatchObject({
      actor_type: 'user',
      target_type: 'contact',
      target_id: 'contact-42',
      outcome: 'success',
      ip: client.ip,
    });
    expect(row?.metadata).toMatchObject({ method: 'GET', route: '/test/pii/:id' });
  });

  it('are audited even when the read is refused', async () => {
    const client = h.client();
    const session = await client.devLogin(uniqueEmail('client'), 'client', {
      orgId: await createOrg(h.db.owner.pool),
    });
    expect((await client.get('/test/pii/contact-1')).status).toBe(403);
    const [row] = await rows(`action = 'authz.denied' AND actor_id = $1`, [session.user.id]);
    expect(row).toMatchObject({ outcome: 'denied' });
  });

  it('reading the audit log is itself audited', async () => {
    const { client, session } = await signedIn('head');
    await client.get('/v1/audit-logs?limit=1');
    const reads = await rows(`action = 'audit.log.read' AND actor_id = $1`, [session.user.id]);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ target_type: 'audit_log', outcome: 'success' });
  });
});

describe('secrets never reach the log', () => {
  it('redacts credentials a careless handler put into before and after', async () => {
    const { client, session } = await signedIn();
    await client.post('/test/mutate', { note: 'x' });
    const [row] = await rows(`action = 'test.mutate' AND actor_id = $1`, [session.user.id]);
    expect(row?.before).toEqual({
      note: 'old',
      password: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', ok: 1 },
    });
    expect(row?.after).toMatchObject({
      note: 'x',
      refreshToken: '[REDACTED]',
      header: '[REDACTED]',
      hash: '[REDACTED]',
    });
    const raw = JSON.stringify(row);
    for (const secret of ['hunter2-plain', 'k-123', 'rt-plain-value', 'abc.def.ghi', '$argon2id']) {
      expect(raw).not.toContain(secret);
    }
  });

  it('keeps tokens out of everything written while a session is created, used and ended', async () => {
    const client = h.client();
    const session = await client.devLogin(uniqueEmail('agent'), 'agent');
    const access = client.cookie('wt_at') ?? '';
    const refresh = client.cookie('wt_rt') ?? '';
    await client.post('/v1/auth/refresh');
    const rotated = client.cookie('wt_rt') ?? '';
    await client.post('/test/mutate', { note: 'during' });
    await client.post('/v1/auth/logout');

    const dump = await pool().query<{ dump: string }>(
      `SELECT string_agg(to_jsonb(a)::text, ' ') AS dump FROM audit_log a`,
    );
    for (const secret of [access, refresh, rotated, session.csrfToken]) {
      expect(dump.rows[0]?.dump).not.toContain(secret);
    }
  });
});

describe('the log cannot be changed', () => {
  it('is written through a database role that has no UPDATE, DELETE or TRUNCATE', async () => {
    const database = h.app.get<Database>(DATABASE);
    const me = await database.pool.query<{ who: string }>('SELECT current_user AS who');
    expect(me.rows[0]?.who).toMatch(/^wt_app_/);
    for (const statement of [
      `UPDATE audit_log SET action = 'forged'`,
      'DELETE FROM audit_log',
      'TRUNCATE audit_log',
      'DROP TABLE audit_log',
      'ALTER TABLE audit_log DISABLE TRIGGER ALL',
    ]) {
      await expect(database.pool.query(statement), statement).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('is protected by a trigger as well, so even the owner cannot rewrite history', async () => {
    await signedIn();
    for (const statement of [
      `UPDATE audit_log SET actor_id = 'someone-else'`,
      'DELETE FROM audit_log',
      'TRUNCATE audit_log',
    ]) {
      await expect(pool().query(statement), statement).rejects.toMatchObject({ code: '23001' });
    }
    const intact = await pool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE actor_id = 'someone-else'`,
    );
    expect(intact.rows[0]?.n).toBe(0);
  });

  it('cannot be edited by a separate connection with the same credentials as the api', async () => {
    const separate = new Pool({ connectionString: h.db.appUrl, max: 1 });
    try {
      await expect(
        separate.query(`UPDATE audit_log SET outcome = 'success'`),
      ).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await separate.end();
    }
  });
});

describe('failing closed', () => {
  it('fails a successful mutation with 500 when it cannot be audited, instead of hiding it', async () => {
    const { client } = await signedIn();
    await pool().query('REVOKE INSERT ON audit_log FROM watchtower_app');
    try {
      const response = await client.post<{ message: string }>('/test/unnamed', {});
      expect(response.status).toBe(500);
      expect(response.body.message).toContain('could not be audited');
    } finally {
      await pool().query('GRANT INSERT ON audit_log TO watchtower_app');
    }
    expect((await client.post('/test/unnamed', {})).status).toBe(201);
  });

  it('still refuses a forbidden request when the refusal cannot be audited', async () => {
    const { client } = await signedIn('agent');
    await pool().query('REVOKE INSERT ON audit_log FROM watchtower_app');
    try {
      expect((await client.get('/v1/audit-logs')).status).toBe(403);
    } finally {
      await pool().query('GRANT INSERT ON audit_log TO watchtower_app');
    }
  });
});

describe('the audit log endpoint', () => {
  async function seed(client: TestClient, count: number) {
    for (let i = 0; i < count; i += 1) await client.post('/test/mutate', { note: `n${String(i)}` });
  }

  it('is for the head only', async () => {
    for (const role of ['agent', 'lead'] as const) {
      const { client } = await signedIn(role);
      expect((await client.get('/v1/audit-logs')).status).toBe(403);
    }
    expect((await h.client().get('/v1/audit-logs')).status).toBe(401);
    const { client: head } = await signedIn('head');
    expect((await head.get('/v1/audit-logs')).status).toBe(200);
  });

  it('filters by actor, action, outcome, target and time', async () => {
    const { client: head } = await signedIn('head');
    const { client: agent, session } = await signedIn('agent');
    await seed(agent, 2);
    await agent.post('/test/boom', {});

    type Page = { entries: AuditLogEntry[]; nextCursor: string | null };
    const byActor = await head.get<Page>(`/v1/audit-logs?actorId=${session.user.id}&limit=200`);
    expect(byActor.body.entries.every((entry) => entry.actorId === session.user.id)).toBe(true);
    expect(byActor.body.entries.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['test.mutate', 'test.boom']),
    );

    const mutate = await head.get<Page>(
      `/v1/audit-logs?actorId=${session.user.id}&action=test.mutate&outcome=success&targetType=widget&targetId=widget-1`,
    );
    expect(mutate.body.entries).toHaveLength(2);
    expect(mutate.body.entries[0]).toMatchObject({ actorType: 'user', targetType: 'widget' });

    const failures = await head.get<Page>(
      `/v1/audit-logs?actorId=${session.user.id}&outcome=failure`,
    );
    expect(failures.body.entries.map((entry) => entry.action)).toEqual(['test.boom']);

    const future = new Date(Date.now() + 3_600_000).toISOString();
    const none = await head.get<Page>(`/v1/audit-logs?from=${encodeURIComponent(future)}`);
    expect(none.body.entries).toEqual([]);
    const past = await head.get<Page>(`/v1/audit-logs?to=2001-01-01T00:00:00.000Z`);
    expect(past.body.entries).toEqual([]);
  });

  it('pages newest first without skipping or repeating a row', async () => {
    const { client: head } = await signedIn('head');
    const { client: agent, session } = await signedIn('agent');
    await seed(agent, 7);

    type Page = { entries: AuditLogEntry[]; nextCursor: string | null };
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/v1/audit-logs?actorId=${session.user.id}&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page: { body: Page } = await head.get<Page>(url);
      seen.push(...page.body.entries.map((entry) => entry.id));
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    const expected = (await rows(`actor_id = $1`, [session.user.id])).map((row) => row.id);
    expect(seen).toHaveLength(expected.length);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].reverse()).toEqual(expected);
    expect(pages).toBeGreaterThan(2);
  });

  it('shows the redacted values, never the raw ones', async () => {
    const { client: head } = await signedIn('head');
    const { client: agent } = await signedIn('agent');
    await agent.post('/test/mutate', { note: 'visible' });
    const response = await head.get<{ entries: AuditLogEntry[] }>(
      '/v1/audit-logs?action=test.mutate&limit=1',
    );
    const raw = JSON.stringify(response.body);
    expect(raw).toContain('[REDACTED]');
    expect(raw).not.toContain('hunter2-plain');
  });

  it('rejects a bad cursor, a bad limit and a bad time', async () => {
    const { client: head } = await signedIn('head');
    expect((await head.get('/v1/audit-logs?cursor=not-a-cursor')).status).toBe(400);
    expect((await head.get('/v1/audit-logs?limit=0')).status).toBe(400);
    expect((await head.get('/v1/audit-logs?limit=201')).status).toBe(400);
    expect((await head.get('/v1/audit-logs?from=yesterday')).status).toBe(400);
    expect((await head.get('/v1/audit-logs?outcome=maybe')).status).toBe(400);
  });
});

describe('client address', () => {
  it('ignores X-Forwarded-For unless a proxy is trusted, so the audit IP and rate limits cannot be spoofed', async () => {
    const direct = await startHarness({ env: { TRUST_PROXY_HOPS: '0' } });
    try {
      const client = direct.client();
      const session = await client.devLogin(uniqueEmail('agent'), 'agent');
      const result = await direct.db.owner.pool.query<{ ip: string }>(
        `SELECT ip FROM audit_log WHERE actor_id = $1 AND action = 'auth.login.dev'`,
        [session.user.id],
      );
      expect(result.rows[0]?.ip).not.toBe(client.ip);
      expect(result.rows[0]?.ip).toMatch(/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/);
    } finally {
      await direct.close();
    }
  });
});
