import { ACCESS_COOKIE, REFRESH_COOKIE, type SessionInfo } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, uniqueEmail, type Harness } from '../testing/harness.js';
import { captureLogs } from '../testing/support.js';

// T-010 fixes on the real application: dev login provenance (C-1), response headers (C-5),
// __Host- cookies and duplicate cookies (C-6), the proxy hint (C-8).

let h: Harness;
const pool = () => h.db.owner.pool;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

/** A request with exactly the Cookie header given (the test client would add its own jar). */
function withCookie(target: Harness, method: 'GET' | 'POST', path: string, cookie: string) {
  return fetch(`${target.base}${path}`, {
    method,
    headers: { cookie, 'x-forwarded-for': '10.9.9.9', 'user-agent': 'watchtower-test-client' },
  });
}

describe('dev login only signs in to accounts it created (C-1)', () => {
  async function refused(email: string, role: 'agent' | 'head' = 'agent') {
    const client = h.client();
    const response = await client.post('/v1/auth/dev-login', { email, role });
    expect(response.status, email).toBe(403);
    expect(response.setCookies).toEqual([]);
    expect(client.cookie(ACCESS_COOKIE)).toBeUndefined();
  }

  it('creates a marked account on first use and signs in to it again', async () => {
    const email = uniqueEmail('dev-made');
    const first = await h.client().devLogin(email, 'agent');
    const flag = await pool().query<{ dev_created: boolean }>(
      'SELECT dev_created FROM users WHERE email = $1',
      [email],
    );
    expect(flag.rows[0]?.dev_created).toBe(true);
    const again = await h.client().devLogin(email, 'agent');
    expect(again.user.id).toBe(first.user.id);
  });

  it('refuses an account a head invited, even for the same role', async () => {
    const head = h.client();
    await head.devLogin(uniqueEmail('inviting-head'), 'head');
    const invited = uniqueEmail('invited');
    expect(
      (await head.post('/v1/users', { email: invited, name: 'I', role: 'agent' })).status,
    ).toBe(201);
    await refused(invited);
  });

  it('refuses an account created by SQL (a seed, a migration, a real person) and a break-glass admin', async () => {
    const seeded = uniqueEmail('seeded');
    await pool().query(`INSERT INTO users (email, name, role) VALUES ($1, 'Seeded', 'head')`, [
      seeded,
    ]);
    await refused(seeded, 'head');

    const admin = uniqueEmail('bg');
    await pool().query(
      `INSERT INTO users (email, name, role, is_break_glass, password_hash, dev_created)
       VALUES ($1, 'BG', 'head', true, 'not-a-real-hash', true)`,
      [admin],
    );
    await refused(admin, 'head');
  });

  it('refuses a dev-created account once it is disabled', async () => {
    const email = uniqueEmail('dev-disabled');
    await h.client().devLogin(email, 'agent');
    await pool().query(`UPDATE users SET status = 'disabled' WHERE email = $1`, [email]);
    await refused(email);
  });

  it('is a 404 unless DEV_LOGIN_ENABLED=true, even in mock mode outside production', async () => {
    const off = await startHarness({ env: { DEV_LOGIN_ENABLED: 'false' } });
    try {
      const client = off.client();
      const config = await client.get<{ devLoginEnabled: boolean; google: { mode: string } }>(
        '/v1/auth/config',
      );
      expect(config.body.devLoginEnabled).toBe(false);
      expect(config.body.google.mode).toBe('mock');
      const response = await client.post('/v1/auth/dev-login', {
        email: uniqueEmail('agent'),
        role: 'agent',
      });
      expect(response.status).toBe(404);
      const users = await off.db.owner.pool.query('SELECT 1 FROM users');
      expect(users.rowCount).toBe(0);
    } finally {
      await off.close();
    }
  });
});

describe('response headers (C-5)', () => {
  it('forbids framing and sniffing on every reply and caching on /v1/auth/*', async () => {
    const client = h.client();
    for (const path of ['/v1/auth/config', '/v1/auth/session', '/health', '/v1/does-not-exist']) {
      const response = await client.get(path);
      expect(response.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(response.headers.get('content-security-policy'), path).toBe("frame-ancestors 'none'");
    }
    // Errors carry them too (the 401 comes from the guard, the 404 from the router).
    expect((await client.get('/v1/auth/session')).headers.get('cache-control')).toBe('no-store');
    expect((await client.get('/v1/auth/config')).headers.get('cache-control')).toBe('no-store');
    expect(
      (await client.post('/v1/auth/magic-link/request', { email: uniqueEmail('x') })).headers.get(
        'cache-control',
      ),
    ).toBe('no-store');
    expect((await client.get('/health')).headers.get('cache-control')).not.toBe('no-store');
  });

  it('sends no HSTS outside production', async () => {
    const response = await h.client().get('/v1/auth/config');
    expect(response.headers.has('strict-transport-security')).toBe(false);
  });

  it('keeps the OpenAPI document and its UI reachable', async () => {
    expect((await h.client().get('/docs-json')).status).toBe(200);
  });
});

describe('plain local http keeps the bare cookie names (C-6)', () => {
  it('sets wt_at and wt_rt, and refuses a request that repeats the access cookie', async () => {
    const client = h.client();
    const session = await client.devLogin(uniqueEmail('plain'), 'agent');
    const access = client.cookie(ACCESS_COOKIE);
    expect(access).toBeDefined();
    expect(client.cookie(REFRESH_COOKIE)).toBeDefined();

    const single = await client.get('/v1/auth/session');
    expect(single.status).toBe(200);

    expect(
      (await withCookie(h, 'GET', '/v1/auth/session', `${ACCESS_COOKIE}=${access ?? ''}`)).status,
    ).toBe(200);
    const duplicated = await withCookie(
      h,
      'GET',
      '/v1/auth/session',
      `${ACCESS_COOKIE}=${access ?? ''}; ${ACCESS_COOKIE}=${access ?? ''}`,
    );
    expect(duplicated.status).toBe(401);
    // Planted first, real second (or the other way round): neither is believed.
    for (const cookie of [
      `${ACCESS_COOKIE}=planted; ${ACCESS_COOKIE}=${access ?? ''}`,
      `${ACCESS_COOKIE}=${access ?? ''}; ${ACCESS_COOKIE}=planted`,
    ]) {
      expect((await withCookie(h, 'GET', '/v1/auth/session', cookie)).status).toBe(401);
    }
    expect(session.user.email).toContain('plain-');
  });

  it('answers a repeated refresh cookie with 401 and records why', async () => {
    const client = h.client();
    await client.devLogin(uniqueEmail('refresh-dup'), 'agent');
    const refresh = client.cookie(REFRESH_COOKIE) ?? '';
    const response = await withCookie(
      h,
      'POST',
      '/v1/auth/refresh',
      `${REFRESH_COOKIE}=${refresh}; ${REFRESH_COOKIE}=${refresh}`,
    );
    expect(response.status).toBe(401);
    const audit = await pool().query<{ metadata: { reason?: string } }>(
      `SELECT metadata FROM audit_log WHERE action = 'auth.refresh' AND outcome = 'failure'
       ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.metadata.reason).toBe('duplicate_refresh_cookie');
    // The token was not consumed: the single, honest cookie still refreshes.
    expect((await client.post('/v1/auth/refresh')).status).toBe(200);
  });
});

describe('Secure deployments use __Host- cookies (C-6)', () => {
  let secure: Harness;

  beforeAll(async () => {
    secure = await startHarness({ env: { API_URL: 'https://api.example.test' } });
  });

  afterAll(async () => {
    await secure.close();
  });

  it('sets __Host-wt_at and __Host-wt_rt with Secure, Path=/ and no Domain', async () => {
    const client = secure.client();
    const response = await client.post<SessionInfo>('/v1/auth/dev-login', {
      email: uniqueEmail('host'),
      role: 'agent',
    });
    expect(response.status).toBe(200);
    expect(response.setCookies).toHaveLength(2);
    for (const [index, name] of ['__Host-wt_at', '__Host-wt_rt'].entries()) {
      const cookie = response.setCookies[index] ?? '';
      expect(cookie.startsWith(`${name}=`), cookie.split('=')[0]).toBe(true);
      expect(cookie).toMatch(/;\s*Secure/i);
      expect(cookie).toMatch(/;\s*HttpOnly/i);
      expect(cookie).toMatch(/;\s*Path=\/(;|$)/i);
      expect(cookie).not.toMatch(/;\s*Domain=/i);
    }
    expect(client.cookie('wt_at')).toBeUndefined();
  });

  it('works with the prefixed names, ignores the bare names a sibling could plant, and clears the prefixed ones on logout', async () => {
    const client = secure.client();
    const session = await client.post<SessionInfo>('/v1/auth/dev-login', {
      email: uniqueEmail('host-2'),
      role: 'agent',
    });
    client.csrfToken = session.body.csrfToken;
    const access = client.cookie('__Host-wt_at') ?? '';
    expect((await client.get('/v1/auth/session')).status).toBe(200);

    // The bare name carries no weight on a Secure deployment, even with a valid token in it.
    const planted = await withCookie(secure, 'GET', '/v1/auth/session', `wt_at=${access}`);
    expect(planted.status).toBe(401);
    // A planted bare cookie next to the real one does not break or replace it.
    const both = await withCookie(
      secure,
      'GET',
      '/v1/auth/session',
      `wt_at=planted; __Host-wt_at=${access}`,
    );
    expect(both.status).toBe(200);
    // Two prefixed cookies are refused.
    const twice = await withCookie(
      secure,
      'GET',
      '/v1/auth/session',
      `__Host-wt_at=${access}; __Host-wt_at=${access}`,
    );
    expect(twice.status).toBe(401);

    const loggedOut = await client.post('/v1/auth/logout');
    expect(loggedOut.status).toBe(204);
    const cleared = loggedOut.setCookies.map((cookie) => cookie.split(';')[0] ?? '');
    expect(cleared).toEqual(['__Host-wt_at=', '__Host-wt_rt=']);
    for (const cookie of loggedOut.setCookies) {
      expect(cookie).toMatch(/;\s*Secure/i);
      expect(cookie).toMatch(/;\s*Path=\/(;|$)/i);
    }
    expect(client.cookie('__Host-wt_at')).toBeUndefined();
  });

  it('serves HSTS only in production, so not here', async () => {
    expect(
      (await secure.client().get('/v1/auth/config')).headers.has('strict-transport-security'),
    ).toBe(false);
  });
});

describe('proxy hint (C-8)', () => {
  it('warns once when requests carry X-Forwarded-For from a private address while TRUST_PROXY_HOPS=0', async () => {
    const logs = captureLogs();
    const untrusting = await startHarness({
      env: { TRUST_PROXY_HOPS: '0', LOG_LEVEL: 'warn' },
      logs,
    });
    try {
      const client = untrusting.client();
      // The harness client sends X-Forwarded-For and connects from loopback, like Caddy would.
      await client.get('/health');
      await client.get('/health');
      const warnings = logs
        .lines()
        .filter((line) => typeof line.msg === 'string' && line.msg.includes('TRUST_PROXY_HOPS=1'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ level: 'warn' });
      expect(logs.raw()).not.toContain(client.ip);
    } finally {
      await untrusting.close();
    }
  });

  it('stays silent when the hop count is set', async () => {
    const logs = captureLogs();
    const trusting = await startHarness({
      env: { TRUST_PROXY_HOPS: '1', LOG_LEVEL: 'warn' },
      logs,
    });
    try {
      await trusting.client().get('/health');
      expect(logs.raw()).not.toContain('TRUST_PROXY_HOPS=1');
    } finally {
      await trusting.close();
    }
  });
});
