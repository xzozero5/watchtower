import { ACCESS_COOKIE, REFRESH_COOKIE, type SessionInfo } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, uniqueEmail, type Harness } from '../testing/harness.js';
import { ProbeController, RogueController } from '../testing/test-controllers.js';

// Sign-in in mock mode, sessions, refresh rotation, devices, forced logout, CSRF and Origin, on the
// real application with Postgres, Redis and BullMQ from docker compose.

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ controllers: [RogueController, ProbeController] });
});

afterAll(async () => {
  await h.close();
});

const pool = () => h.db.owner.pool;

async function signedIn(role: 'agent' | 'lead' | 'head' = 'agent') {
  const client = h.client();
  const email = uniqueEmail(role);
  const session = await client.devLogin(email, role);
  return { client, email, session };
}

async function auditRows(where: string, params: unknown[] = []) {
  const result = await pool().query<{
    action: string;
    outcome: string;
    actor_id: string | null;
    actor_type: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT action, outcome, actor_id, actor_type, metadata FROM audit_log WHERE ${where} ORDER BY created_at`,
    params,
  );
  return result.rows;
}

describe('mock mode', () => {
  it('reports itself on the public config endpoint', async () => {
    const response = await h.client().get<Record<string, unknown>>('/v1/auth/config');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      google: { mode: 'mock', startPath: null },
      devLoginEnabled: true,
      magicLinkEnabled: true,
      breakGlassEnabled: true,
    });
  });

  it('has no Google start route to call (404) and makes no outbound request', async () => {
    const response = await h.client().get('/v1/auth/google/start');
    expect(response.status).toBe(404);
  });

  it('dev login signs in, sets HttpOnly cookies and keeps tokens out of the body', async () => {
    const client = h.client();
    const email = uniqueEmail('head');
    const response = await client.post<SessionInfo>('/v1/auth/dev-login', { email, role: 'head' });
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ email, role: 'head', orgId: null });
    expect(response.body.authMethod).toBe('dev');
    expect(response.body.permissions).toContain('audit.read');
    expect(response.body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const access =
      response.setCookies.find((cookie) => cookie.startsWith(`${ACCESS_COOKIE}=`)) ?? '';
    const refresh =
      response.setCookies.find((cookie) => cookie.startsWith(`${REFRESH_COOKIE}=`)) ?? '';
    expect(access).toMatch(/HttpOnly/i);
    expect(access).toMatch(/SameSite=Lax/i);
    expect(access).toMatch(/Path=\//);
    expect(refresh).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/SameSite=Strict/i);
    expect(access).not.toMatch(/Domain=/i);
    // Plain http on localhost in tests: Secure is added in production and over https.
    expect(access).not.toMatch(/Secure/i);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain(client.cookie(ACCESS_COOKIE) ?? 'x-missing');
    expect(body).not.toContain(client.cookie(REFRESH_COOKIE) ?? 'x-missing');
  });

  it('refuses a staff dev account outside the allowed domain, and a client without an org', async () => {
    const client = h.client();
    expect(
      (await client.post('/v1/auth/dev-login', { email: 'someone@other.test', role: 'agent' }))
        .status,
    ).toBe(403);
    expect(
      (await client.post('/v1/auth/dev-login', { email: uniqueEmail('client'), role: 'client' }))
        .status,
    ).toBe(400);
    expect((await client.post('/v1/auth/dev-login', { email: 'not-an-email' })).status).toBe(400);
  });

  it('sends nothing outside the machine: no request but the ones to the api itself', async () => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return original(input, init);
    };
    // Boot a whole application under the spy, then use every sign-in path that exists in mock mode.
    const quiet = await startHarness();
    try {
      const client = quiet.client();
      await client.get('/v1/auth/config');
      await client.get('/v1/auth/google/start');
      await client.devLogin(uniqueEmail('agent'), 'agent');
      await client.post('/v1/auth/refresh');
      await quiet.client().post('/v1/auth/magic-link/request', { email: uniqueEmail('someone') });
      await quiet
        .client()
        .post('/v1/auth/break-glass', { email: uniqueEmail('bg'), password: 'whatever-password' });
    } finally {
      await quiet.close();
      globalThis.fetch = original;
    }
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((url) => !url.startsWith('http://127.0.0.1:'))).toEqual([]);
  });

  it('is a 404 when Google credentials are set (live mode), as if the route did not exist', async () => {
    const live = await startHarness({
      env: {
        GOOGLE_OIDC_CLIENT_ID: 'client-id',
        GOOGLE_OIDC_CLIENT_SECRET: 'client-secret',
        GOOGLE_ALLOWED_DOMAIN: 'example.com',
      },
    });
    try {
      const client = live.client();
      const config = await client.get<{ devLoginEnabled: boolean; google: { mode: string } }>(
        '/v1/auth/config',
      );
      expect(config.body.devLoginEnabled).toBe(false);
      expect(config.body.google.mode).toBe('live');
      const attempt = await client.post('/v1/auth/dev-login', {
        email: uniqueEmail('agent'),
        role: 'head',
      });
      expect(attempt.status).toBe(404);
      expect(client.cookie(ACCESS_COOKIE)).toBeUndefined();
      const created = await live.db.owner.pool.query('SELECT count(*)::int AS n FROM users');
      expect((created.rows[0] as { n: number }).n).toBe(0);
    } finally {
      await live.close();
    }
  });
});

describe('who am I and sign-out', () => {
  it('returns the session for the cookie, with the same CSRF token as sign-in', async () => {
    const { client, email, session } = await signedIn('lead');
    const response = await client.get<SessionInfo>('/v1/auth/session');
    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe(email);
    expect(response.body.csrfToken).toBe(session.csrfToken);
    expect(response.body.permissions).toContain('kb.approve');
    expect(response.body.permissions).not.toContain('audit.read');
  });

  it('is 401 without a cookie, with garbage, and with a tampered token', async () => {
    const anonymous = h.client();
    const missing = await anonymous.get<{ code: string }>('/v1/auth/session');
    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe('unauthenticated');

    anonymous.cookies.set(ACCESS_COOKIE, 'garbage');
    expect((await anonymous.get('/v1/auth/session')).status).toBe(401);

    const { client } = await signedIn();
    const token = client.cookie(ACCESS_COOKIE) ?? '';
    const [header, payload, signature] = token.split('.');
    const flipped = `${signature?.slice(0, -2) ?? ''}${signature?.endsWith('AA') ? 'BB' : 'AA'}`;
    client.cookies.set(ACCESS_COOKIE, `${header ?? ''}.${payload ?? ''}.${flipped}`);
    expect((await client.get('/v1/auth/session')).status).toBe(401);
  });

  it('logout revokes the session on the server, not just the cookies', async () => {
    const { client } = await signedIn();
    const stolenAccess = client.cookie(ACCESS_COOKIE) ?? '';
    const stolenRefresh = client.cookie(REFRESH_COOKIE) ?? '';

    const out = await client.post('/v1/auth/logout');
    expect(out.status).toBe(204);
    expect(out.setCookies.join('\n')).toMatch(/wt_at=;/);
    expect(client.cookie(ACCESS_COOKIE)).toBeUndefined();
    expect(client.cookie(REFRESH_COOKIE)).toBeUndefined();

    // A copy of the old cookies is worthless.
    const thief = h.client();
    thief.cookies.set(ACCESS_COOKIE, stolenAccess);
    thief.cookies.set(REFRESH_COOKIE, stolenRefresh);
    expect((await thief.get('/v1/auth/session')).status).toBe(401);
    expect((await thief.post('/v1/auth/refresh')).status).toBe(401);
  });

  it('logout is idempotent and works with only the refresh cookie', async () => {
    expect((await h.client().post('/v1/auth/logout')).status).toBe(204);
    const { client } = await signedIn();
    client.cookies.delete(ACCESS_COOKIE);
    expect((await client.post('/v1/auth/logout')).status).toBe(204);
    const rows = await pool().query(
      `SELECT revoked_reason FROM sessions WHERE revoked_reason = 'logout'`,
    );
    expect(rows.rowCount).toBeGreaterThan(0);
  });
});

describe('refresh token rotation', () => {
  it('issues a new refresh token and a new access token each time', async () => {
    const { client, session } = await signedIn();
    const firstRefresh = client.cookie(REFRESH_COOKIE) ?? '';

    const response = await client.post<SessionInfo>('/v1/auth/refresh');
    expect(response.status).toBe(200);
    expect(client.cookie(REFRESH_COOKIE)).not.toBe(firstRefresh);
    expect(response.body.sessionId).toBe(session.sessionId);
    expect(response.body.csrfToken).toBe(session.csrfToken);
    expect(response.body.authMethod).toBe('dev');
    expect((await client.get('/v1/auth/session')).status).toBe(200);
  });

  it('stores only hashes of refresh tokens', async () => {
    const { client } = await signedIn();
    const token = client.cookie(REFRESH_COOKIE) ?? '';
    const rows = await pool().query<{ token_hash: string }>(
      'SELECT token_hash FROM refresh_tokens',
    );
    expect(rows.rows.some((row) => row.token_hash === token)).toBe(false);
    expect(rows.rows.every((row) => /^[0-9a-f]{64}$/.test(row.token_hash))).toBe(true);
    const sessions = await pool().query(
      `SELECT 1 FROM sessions WHERE to_jsonb(sessions)::text LIKE $1`,
      [`%${token}%`],
    );
    expect(sessions.rowCount).toBe(0);
  });

  it('treats a replayed refresh token as theft: 401, and the whole session dies', async () => {
    const { client, session } = await signedIn();
    const stale = client.cookie(REFRESH_COOKIE) ?? '';
    expect((await client.post('/v1/auth/refresh')).status).toBe(200);
    const current = {
      access: client.cookie(ACCESS_COOKIE) ?? '',
      refresh: client.cookie(REFRESH_COOKIE) ?? '',
    };

    const thief = h.client();
    thief.cookies.set(REFRESH_COOKIE, stale);
    const replay = await thief.post<{ code: string }>('/v1/auth/refresh');
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('invalid_refresh_token');
    expect(replay.setCookies.join('\n')).toMatch(/wt_rt=;/);

    // The legitimate holder lost the session too: both must sign in again.
    const owner = h.client();
    owner.cookies.set(ACCESS_COOKIE, current.access);
    owner.cookies.set(REFRESH_COOKIE, current.refresh);
    expect((await owner.get('/v1/auth/session')).status).toBe(401);
    expect((await owner.post('/v1/auth/refresh')).status).toBe(401);

    const row = await pool().query<{ revoked_reason: string }>(
      'SELECT revoked_reason FROM sessions WHERE id = $1',
      [session.sessionId],
    );
    expect(row.rows[0]?.revoked_reason).toBe('refresh_reuse');
    const audit = await auditRows(`action = 'auth.refresh.reuse_detected' AND actor_id = $1`, [
      session.user.id,
    ]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ outcome: 'failure', actor_type: 'user' });
    expect(audit[0]?.metadata).toMatchObject({ reason: 'reuse' });
  });

  it('lets exactly one of two simultaneous refreshes with the same token succeed', async () => {
    const { client } = await signedIn();
    const token = client.cookie(REFRESH_COOKIE) ?? '';
    const make = () => {
      const copy = h.client();
      copy.cookies.set(REFRESH_COOKIE, token);
      return copy.post('/v1/auth/refresh');
    };
    const results = await Promise.all([make(), make()]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
  });

  it('rejects unknown, missing and expired refresh tokens without revoking anything', async () => {
    const nothing = h.client();
    expect((await nothing.post('/v1/auth/refresh')).status).toBe(401);
    nothing.cookies.set(REFRESH_COOKIE, 'x'.repeat(43));
    expect((await nothing.post('/v1/auth/refresh')).status).toBe(401);

    const { client, session } = await signedIn();
    await pool().query(
      `UPDATE refresh_tokens SET expires_at = now() - interval '1 minute' WHERE session_id = $1`,
      [session.sessionId],
    );
    const expired = await client.post('/v1/auth/refresh');
    expect(expired.status).toBe(401);
    const row = await pool().query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM sessions WHERE id = $1',
      [session.sessionId],
    );
    expect(row.rows[0]?.revoked_at).toBeNull();
    const audit = await auditRows(
      `action = 'auth.refresh' AND outcome = 'failure' AND actor_id = $1`,
      [session.user.id],
    );
    expect(audit.at(-1)?.metadata).toMatchObject({ reason: 'expired' });
  });

  it('ends a session at its absolute lifetime even with a valid access token', async () => {
    const { client, session } = await signedIn();
    await pool().query(
      `UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [session.sessionId],
    );
    expect((await client.get('/v1/auth/session')).status).toBe(401);
    expect((await client.post('/v1/auth/refresh')).status).toBe(401);
  });

  it('never gives a refresh token a lifetime beyond its session', async () => {
    const { client, session } = await signedIn();
    await pool().query(
      `UPDATE sessions SET expires_at = now() + interval '90 seconds' WHERE id = $1`,
      [session.sessionId],
    );
    expect((await client.post('/v1/auth/refresh')).status).toBe(200);
    const rows = await pool().query<{ ok: boolean }>(
      `SELECT bool_and(t.expires_at <= s.expires_at) AS ok
         FROM refresh_tokens t JOIN sessions s ON s.id = t.session_id WHERE s.id = $1 AND t.used_at IS NULL`,
      [session.sessionId],
    );
    expect(rows.rows[0]?.ok).toBe(true);
  });
});

describe('devices and forced logout', () => {
  async function twoDevices() {
    const email = uniqueEmail('agent');
    const a = h.client();
    const b = h.client();
    const sessionA = await a.devLogin(email, 'agent');
    const sessionB = await b.devLogin(email, 'agent');
    return { a, b, sessionA, sessionB };
  }

  it('lists my devices and marks the current one', async () => {
    const { a, sessionA, sessionB } = await twoDevices();
    const response = await a.get<{
      devices: { id: string; current: boolean; userAgent: string | null }[];
    }>('/v1/auth/sessions');
    expect(response.status).toBe(200);
    expect(response.body.devices.map((device) => device.id).sort()).toEqual(
      [sessionA.sessionId, sessionB.sessionId].sort(),
    );
    expect(response.body.devices.find((device) => device.current)?.id).toBe(sessionA.sessionId);
    expect(response.body.devices[0]?.userAgent).toBe('watchtower-test-client');
  });

  it('signs out one device without touching the other', async () => {
    const { a, b, sessionB } = await twoDevices();
    const removed = await a.delete(`/v1/auth/sessions/${sessionB.sessionId}`);
    expect(removed.status).toBe(204);
    expect((await b.get('/v1/auth/session')).status).toBe(401);
    expect((await a.get('/v1/auth/session')).status).toBe(200);
    expect((await a.delete(`/v1/auth/sessions/${sessionB.sessionId}`)).status).toBe(404);
  });

  it("cannot sign out somebody else's device", async () => {
    const { client: other, session: otherSession } = await signedIn();
    const { client } = await signedIn();
    expect((await client.delete(`/v1/auth/sessions/${otherSession.sessionId}`)).status).toBe(404);
    expect((await other.get('/v1/auth/session')).status).toBe(200);
  });

  it('lets a head force a user off at once, though their access token has not expired', async () => {
    const { client: agent, session } = await signedIn('agent');
    const { client: head } = await signedIn('head');
    expect((await agent.get('/v1/auth/session')).status).toBe(200);

    const forced = await head.post<{ revokedSessions: number }>(
      `/v1/users/${session.user.id}/force-logout`,
    );
    expect(forced.status).toBe(200);
    expect(forced.body.revokedSessions).toBe(1);
    expect((await agent.get('/v1/auth/session')).status).toBe(401);
    expect((await agent.post('/v1/auth/refresh')).status).toBe(401);

    const audit = await auditRows(`action = 'auth.force_logout' AND target_id = $1`, [
      session.user.id,
    ]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ outcome: 'success' });
  });

  it('does not let an agent or a lead force anyone off', async () => {
    const { client: victim, session } = await signedIn('agent');
    for (const role of ['agent', 'lead'] as const) {
      const { client } = await signedIn(role);
      const attempt = await client.post(`/v1/users/${session.user.id}/force-logout`);
      expect(attempt.status).toBe(403);
    }
    expect((await victim.get('/v1/auth/session')).status).toBe(200);
  });

  it('ends every session of a user who is disabled, and keeps them out', async () => {
    const { client: agent, session, email } = await signedIn('agent');
    const { client: head } = await signedIn('head');
    const disabled = await head.patch(`/v1/users/${session.user.id}`, { status: 'disabled' });
    expect(disabled.status).toBe(200);
    expect((await agent.get('/v1/auth/session')).status).toBe(401);
    expect((await agent.post('/v1/auth/refresh')).status).toBe(401);
    expect((await h.client().post('/v1/auth/dev-login', { email, role: 'agent' })).status).toBe(
      403,
    );
  });
});

describe('CSRF', () => {
  it("rejects an unsafe request without the token, with a wrong one, and with another session's", async () => {
    const { client } = await signedIn('agent');
    const { session: other } = await signedIn('agent');

    const missing = await client.post<{ code: string }>(
      '/test/mutate',
      { note: 'x' },
      { csrf: false },
    );
    expect(missing.status).toBe(403);
    expect(missing.body.code).toBe('csrf_invalid');
    expect((await client.post('/test/mutate', { note: 'x' }, { csrf: 'nope' })).status).toBe(403);
    expect(
      (await client.post('/test/mutate', { note: 'x' }, { csrf: other.csrfToken })).status,
    ).toBe(403);
    expect((await client.post('/test/mutate', { note: 'x' })).status).toBe(201);
  });

  it('applies to PUT, PATCH and DELETE too, and never to reads', async () => {
    const { client } = await signedIn('head');
    const { session } = await signedIn('agent');
    expect(
      (await client.patch(`/v1/users/${session.user.id}`, { name: 'Renamed' }, { csrf: false }))
        .status,
    ).toBe(403);
    expect(
      (await client.put('/v1/rbac/roles/agent/permissions', { permissions: [] }, { csrf: false }))
        .status,
    ).toBe(403);
    expect(
      (await client.delete(`/v1/auth/sessions/${session.sessionId}`, { csrf: false })).status,
    ).toBe(403);
    expect((await client.get('/v1/users')).status).toBe(200);
    expect((await client.get('/v1/audit-logs')).status).toBe(200);
  });

  it('writes the rejection to the audit log, attributed to the signed-in user', async () => {
    const { client, session } = await signedIn('agent');
    await client.post('/test/mutate', { note: 'x' }, { csrf: false });
    const rows = await auditRows(`action = 'auth.csrf_rejected' AND actor_id = $1`, [
      session.user.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'denied', actor_type: 'user' });
    expect(rows[0]?.metadata).toMatchObject({ method: 'POST', route: '/test/mutate' });
  });
});

describe('Origin and CORS', () => {
  it('refuses an unsafe request from another origin, even to a public route', async () => {
    const client = h.client();
    for (const origin of ['http://evil.example.com', 'null', 'http://localhost:3000.evil.test']) {
      const attempt = await client.post<{ code: string }>(
        '/v1/auth/magic-link/request',
        { email: uniqueEmail('x') },
        { origin },
      );
      expect(attempt.status, origin).toBe(403);
      expect(attempt.body.code).toBe('origin_not_allowed');
    }
  });

  it('allows credentials for the web app origin only', async () => {
    const client = h.client();
    const ok = await client.get('/v1/auth/config', { origin: 'http://localhost:3000' });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
    expect(ok.headers.get('vary') ?? '').toMatch(/origin/i);

    const evil = await client.get('/v1/auth/config', { origin: 'http://evil.example.com' });
    // No allowed origin means the browser withholds the response, whatever else is in the headers.
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers the preflight with the CSRF header allowed, for the app origin only', async () => {
    const preflight = (origin: string) =>
      fetch(`${h.base}/v1/users`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-csrf-token',
        },
      });
    const ok = await preflight('http://localhost:3000');
    expect(ok.status).toBeLessThan(300);
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
    expect(ok.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('x-csrf-token');
    expect(
      (await preflight('http://evil.example.com')).headers.get('access-control-allow-origin'),
    ).toBeNull();
  });
});

describe('deny by default at runtime', () => {
  it('refuses a route that has neither @Public() nor a permission, even for a head', async () => {
    const { client: head } = await signedIn('head');
    for (const attempt of [
      await head.get<{ code: string }>('/test/rogue'),
      await head.post<{ code: string }>('/test/rogue-write'),
      await h.client().get<{ code: string }>('/test/rogue'),
    ]) {
      expect(attempt.status).toBe(403);
      expect(attempt.body.code).toBe('route_not_configured');
    }
  });

  it('keeps the public probes public', async () => {
    const client = h.client();
    expect((await client.get('/health')).status).toBe(200);
    expect((await client.get('/health/ready')).status).toBe(200);
    expect((await client.get('/metrics')).status).toBe(200);
  });

  it('protects every route that needs a session: 401 without one', async () => {
    const client = h.client();
    for (const [method, path] of [
      ['GET', '/v1/users'],
      ['POST', '/v1/users'],
      ['PATCH', '/v1/users/6d8f0a1e-0000-4000-8000-000000000001'],
      ['GET', '/v1/audit-logs'],
      ['GET', '/v1/rbac/roles'],
      ['PUT', '/v1/rbac/roles/agent/permissions'],
      ['GET', '/v1/auth/session'],
      ['GET', '/v1/auth/sessions'],
      ['POST', '/test/mutate'],
    ] as const satisfies readonly (readonly [string, string])[]) {
      const response = await client.request(method, path, {
        body: method === 'GET' ? undefined : {},
      });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('OpenAPI', () => {
  interface Operation {
    security?: Record<string, unknown>[];
    'x-required-permissions'?: string[];
    requestBody?: unknown;
    parameters?: { name: string; in: string }[];
    responses?: Record<string, unknown>;
  }
  type Document = {
    paths: Record<string, Record<string, Operation>>;
    components: { securitySchemes: Record<string, unknown> };
  };

  it('documents every auth, user, rbac and audit route, with its permission and cookie auth', async () => {
    const response = await h.client().get<Document>('/docs-json');
    expect(response.status).toBe(200);
    const { paths, components } = response.body;

    expect(components.securitySchemes.cookie).toMatchObject({
      type: 'apiKey',
      in: 'cookie',
      name: 'wt_at',
    });
    const operation = (path: string, method: string) => paths[path]?.[method];

    for (const [path, method] of [
      ['/v1/auth/config', 'get'],
      ['/v1/auth/google/start', 'get'],
      ['/v1/auth/google/callback', 'get'],
      ['/v1/auth/dev-login', 'post'],
      ['/v1/auth/magic-link/request', 'post'],
      ['/v1/auth/magic-link/verify', 'post'],
      ['/v1/auth/break-glass', 'post'],
      ['/v1/auth/refresh', 'post'],
      ['/v1/auth/logout', 'post'],
      ['/v1/auth/session', 'get'],
      ['/v1/auth/sessions', 'get'],
      ['/v1/auth/sessions/{id}', 'delete'],
      ['/v1/users', 'get'],
      ['/v1/users', 'post'],
      ['/v1/users/{id}', 'patch'],
      ['/v1/users/{id}/force-logout', 'post'],
      ['/v1/rbac/roles', 'get'],
      ['/v1/rbac/roles/{role}/permissions', 'put'],
      ['/v1/audit-logs', 'get'],
    ] as const) {
      expect(operation(path, method), `${method.toUpperCase()} ${path}`).toBeDefined();
    }

    expect(operation('/v1/audit-logs', 'get')?.['x-required-permissions']).toEqual(['audit.read']);
    expect(operation('/v1/audit-logs', 'get')?.security).toEqual([{ cookie: [] }]);
    expect(operation('/v1/audit-logs', 'get')?.parameters?.map((p) => p.name)).toEqual(
      expect.arrayContaining(['actorId', 'action', 'cursor', 'limit']),
    );
    expect(operation('/v1/users', 'post')?.['x-required-permissions']).toEqual([
      'user.manage',
      'client.invite',
    ]);
    expect(operation('/v1/auth/dev-login', 'post')?.security).toBeUndefined();
    expect(JSON.stringify(operation('/v1/users', 'post')?.requestBody)).toContain('"orgId"');
    expect(JSON.stringify(operation('/v1/auth/magic-link/request', 'post')?.responses)).toContain(
      'accepted',
    );
    expect(JSON.stringify(operation('/v1/auth/session', 'get')?.responses)).toContain('csrfToken');
  });
});
