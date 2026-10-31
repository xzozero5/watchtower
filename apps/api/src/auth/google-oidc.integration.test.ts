import { randomUUID } from 'node:crypto';

import { ACCESS_COOKIE, type SessionInfo } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  startFakeIdp,
  type FakeIdp,
  type IdentityClaims,
  type TokenFaults,
} from '../testing/fake-idp.js';
import { startHarness, uniqueEmail, type Harness, type TestClient } from '../testing/harness.js';
import { OIDC_COOKIE } from './cookies.js';

// Staff sign-in through the real `openid-client` flow (authorization code + PKCE) against a local
// fake identity provider. Nothing leaves the machine.

const DOMAIN = 'example.com';
let idp: FakeIdp;
let h: Harness;

beforeAll(async () => {
  idp = await startFakeIdp();
  h = await startHarness({
    env: {
      GOOGLE_OIDC_CLIENT_ID: idp.clientId,
      GOOGLE_OIDC_CLIENT_SECRET: idp.clientSecret,
      GOOGLE_ALLOWED_DOMAIN: DOMAIN,
    },
    oidc: { issuer: idp.issuer },
  });
});

afterAll(async () => {
  await h.close();
  await idp.stop();
});

const pool = () => h.db.owner.pool;

async function createStaff(role: 'agent' | 'lead' | 'head' = 'agent', status = 'active') {
  const email = uniqueEmail(role);
  const row = await pool().query<{ id: string }>(
    `INSERT INTO users (email, name, role, status) VALUES ($1, 'Staff', $2, $3) RETURNING id`,
    [email, role, status],
  );
  return { email, id: row.rows[0]?.id ?? '' };
}

const goodClaims = (email: string, overrides: Partial<IdentityClaims> = {}): IdentityClaims => ({
  sub: `google-sub-${randomUUID()}`,
  email,
  email_verified: true,
  hd: DOMAIN,
  name: 'Some Person',
  ...overrides,
});

/** Runs the browser's side of the flow: /start, the provider, then /callback. */
async function signIn(
  claims: IdentityClaims,
  options: { faults?: TokenFaults; returnTo?: string; client?: TestClient } = {},
) {
  const client = options.client ?? h.client();
  const start = await client.get(
    `/v1/auth/google/start${options.returnTo === undefined ? '' : `?returnTo=${encodeURIComponent(options.returnTo)}`}`,
  );
  expect(start.status).toBe(302);
  const request = idp.parseAuthorize(start.headers.get('location') ?? '');
  const code = idp.approve(request, claims, options.faults);
  const callback = await client.get(
    `/v1/auth/google/callback?code=${code}&state=${encodeURIComponent(request.state)}`,
  );
  return { client, start, request, code, callback };
}

function landed(response: { headers: Headers }): URL {
  return new URL(response.headers.get('location') ?? '');
}

describe('starting', () => {
  it('advertises the live mode, and sends the browser to the provider with PKCE, state and nonce', async () => {
    const config = await h
      .client()
      .get<{ google: { mode: string; startPath: string }; devLoginEnabled: boolean }>(
        '/v1/auth/config',
      );
    expect(config.body).toMatchObject({
      google: { mode: 'live', startPath: '/v1/auth/google/start' },
      devLoginEnabled: false,
    });

    const client = h.client();
    const start = await client.get('/v1/auth/google/start');
    expect(start.status).toBe(302);
    const request = idp.parseAuthorize(start.headers.get('location') ?? '');
    expect(request.params.get('response_type')).toBe('code');
    expect(request.clientId).toBe(idp.clientId);
    expect(request.scope.split(' ')).toEqual(expect.arrayContaining(['openid', 'email']));
    expect(request.challengeMethod).toBe('S256');
    expect(request.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(request.state.length).toBeGreaterThanOrEqual(20);
    expect(request.nonce.length).toBeGreaterThanOrEqual(20);
    expect(request.hd).toBe(DOMAIN);
    expect(request.redirectUri).toBe('http://localhost:4000/v1/auth/google/callback');

    const cookie = start.setCookies.find((entry) => entry.startsWith(`${OIDC_COOKIE}=`)) ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    // The verifier stays in the (signed) cookie; it is never part of the URL the provider sees.
    expect(start.headers.get('location')).not.toContain('code_verifier');
  });

  it('uses fresh state, nonce and PKCE values every time', async () => {
    const a = idp.parseAuthorize(
      (await h.client().get('/v1/auth/google/start')).headers.get('location') ?? '',
    );
    const b = idp.parseAuthorize(
      (await h.client().get('/v1/auth/google/start')).headers.get('location') ?? '',
    );
    expect(new Set([a.state, b.state]).size).toBe(2);
    expect(new Set([a.nonce, b.nonce]).size).toBe(2);
    expect(new Set([a.challenge, b.challenge]).size).toBe(2);
  });
});

describe('a staff member from the allowed domain', () => {
  it('signs in, gets a session with their role, and the provider verified PKCE', async () => {
    const staff = await createStaff('lead');
    const before = idp.pkceVerified();
    const { client, callback } = await signIn(goodClaims(staff.email));
    expect(callback.status).toBe(302);
    expect(landed(callback).toString()).toBe('http://localhost:3000/');
    expect(idp.pkceVerified()).toBe(before + 1);
    expect(client.cookie(ACCESS_COOKIE)).toBeDefined();
    expect(client.cookie(OIDC_COOKIE)).toBeUndefined();

    const session = await client.get<SessionInfo>('/v1/auth/session');
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({
      authMethod: 'google',
      user: { email: staff.email, role: 'lead' },
    });

    const audit = await pool().query<{ outcome: string; actor_id: string }>(
      `SELECT outcome, actor_id FROM audit_log WHERE action = 'auth.login.google' AND actor_id = $1`,
      [staff.id],
    );
    expect(audit.rows).toEqual([{ outcome: 'success', actor_id: staff.id }]);
  });

  it('links the Google account on first sign-in and recognizes it afterwards', async () => {
    const staff = await createStaff();
    const claims = goodClaims(staff.email);
    await signIn(claims);
    const row = await pool().query<{ google_sub: string }>(
      'SELECT google_sub FROM users WHERE id = $1',
      [staff.id],
    );
    expect(row.rows[0]?.google_sub).toBe(claims.sub);
    expect(landed((await signIn(claims)).callback).pathname).toBe('/');
  });

  it('lands on the page they asked for, but only ever on this site', async () => {
    const staff = await createStaff();
    const claims = goodClaims(staff.email);
    const ok = await signIn(claims, { returnTo: '/inbox?view=mine' });
    expect(landed(ok.callback).toString()).toBe('http://localhost:3000/inbox?view=mine');
    for (const returnTo of [
      '//evil.example.com',
      'https://evil.example.com/x',
      '/\\evil',
      'javascript:alert(1)',
      '/a\nb',
    ]) {
      const attempt = await signIn(claims, { returnTo });
      expect(landed(attempt.callback).toString(), returnTo).toBe('http://localhost:3000/');
    }
  });
});

describe('refusals', () => {
  async function expectRefused(
    claims: IdentityClaims,
    reason: string,
    options: { faults?: TokenFaults } = {},
  ) {
    const usersBefore = (await pool().query<{ n: number }>('SELECT count(*)::int AS n FROM users'))
      .rows[0]?.n;
    const { client, callback } = await signIn(claims, options);
    expect(callback.status).toBe(302);
    const target = landed(callback);
    expect(target.origin + target.pathname).toBe('http://localhost:3000/login');
    expect(target.searchParams.get('error')).toBe(reason);
    expect(client.cookie(ACCESS_COOKIE)).toBeUndefined();
    expect((await client.get('/v1/auth/session')).status).toBe(401);
    const usersAfter = (await pool().query<{ n: number }>('SELECT count(*)::int AS n FROM users'))
      .rows[0]?.n;
    expect(usersAfter).toBe(usersBefore);
    return client;
  }

  it('refuses another Workspace domain (hd claim), whatever the email says', async () => {
    const staff = await createStaff();
    await expectRefused(goodClaims(staff.email, { hd: 'other.example.org' }), 'domain_not_allowed');
  });

  it('refuses an account with no hd claim (a personal Google account)', async () => {
    const staff = await createStaff();
    await expectRefused(goodClaims(staff.email, { hd: undefined }), 'domain_not_allowed');
  });

  it('refuses an address outside the domain even when hd claims the right one', async () => {
    await expectRefused(
      goodClaims(uniqueEmail('agent', 'other.example.org')),
      'domain_not_allowed',
    );
  });

  it('refuses an unverified email', async () => {
    const staff = await createStaff();
    await expectRefused(goodClaims(staff.email, { email_verified: false }), 'email_not_verified');
    await expectRefused(
      goodClaims(staff.email, { email_verified: undefined }),
      'email_not_verified',
    );
  });

  it('does not create accounts: an unknown person on the right domain is refused', async () => {
    await expectRefused(goodClaims(uniqueEmail('walk-in')), 'staff_not_provisioned');
  });

  it('refuses a disabled account, a client, and the break-glass account', async () => {
    const disabled = await createStaff('agent', 'disabled');
    await expectRefused(goodClaims(disabled.email), 'account_disabled');

    const clientEmail = uniqueEmail('client');
    await pool().query(
      `INSERT INTO users (email, name, role, org_id) VALUES ($1, 'C', 'client', $2)`,
      [clientEmail, randomUUID()],
    );
    await expectRefused(goodClaims(clientEmail), 'staff_not_provisioned');

    const breakGlass = uniqueEmail('bg');
    await pool().query(
      `INSERT INTO users (email, name, role, password_hash, is_break_glass) VALUES ($1, 'BG', 'head', '$argon2id$x', true)`,
      [breakGlass],
    );
    await expectRefused(goodClaims(breakGlass), 'staff_not_provisioned');
  });

  it('refuses a different Google account for a mailbox that was linked to another one', async () => {
    const staff = await createStaff();
    await signIn(goodClaims(staff.email));
    await expectRefused(goodClaims(staff.email), 'account_mismatch');
  });

  it('refuses one Google account claiming two staff records', async () => {
    const first = await createStaff();
    const second = await createStaff();
    const claims = goodClaims(first.email);
    await signIn(claims);
    await expectRefused({ ...claims, email: second.email }, 'account_mismatch');
  });

  it('records each refusal as a failed sign-in with the reason, and no actor', async () => {
    const staff = await createStaff('agent', 'disabled');
    await signIn(goodClaims(staff.email));
    const rows = await pool().query<{
      outcome: string;
      actor_type: string;
      metadata: { reason: string };
    }>(
      `SELECT outcome, actor_type, metadata FROM audit_log
        WHERE action = 'auth.login.google_failed' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows.rows[0]).toMatchObject({
      outcome: 'failure',
      actor_type: 'anonymous',
      metadata: { reason: 'account_disabled' },
    });
  });
});

describe('attacks on the flow', () => {
  it('rejects a callback whose state is not the one this browser started', async () => {
    const staff = await createStaff();
    const client = h.client();
    const start = await client.get('/v1/auth/google/start');
    const request = idp.parseAuthorize(start.headers.get('location') ?? '');
    const code = idp.approve(request, goodClaims(staff.email));
    const callback = await client.get(
      `/v1/auth/google/callback?code=${code}&state=attacker-chosen-state`,
    );
    expect(landed(callback).searchParams.get('error')).toBe('state_invalid');
    expect(client.cookie(ACCESS_COOKIE)).toBeUndefined();
  });

  it('rejects a callback that arrives in a different browser (login CSRF)', async () => {
    const staff = await createStaff();
    const victim = h.client();
    const start = await victim.get('/v1/auth/google/start');
    const request = idp.parseAuthorize(start.headers.get('location') ?? '');
    const code = idp.approve(request, goodClaims(staff.email));
    // The attacker's own browser has no wt_oidc cookie from this /start.
    const attacker = h.client();
    const callback = await attacker.get(
      `/v1/auth/google/callback?code=${code}&state=${encodeURIComponent(request.state)}`,
    );
    expect(landed(callback).searchParams.get('error')).toBe('state_invalid');
    expect(attacker.cookie(ACCESS_COOKIE)).toBeUndefined();
  });

  it('rejects a forged or foreign state cookie', async () => {
    const staff = await createStaff();
    const client = h.client();
    const start = await client.get('/v1/auth/google/start');
    const request = idp.parseAuthorize(start.headers.get('location') ?? '');
    const code = idp.approve(request, goodClaims(staff.email));
    const real = client.cookie(OIDC_COOKIE) ?? '';
    const [header, payload, signature] = real.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()),
        state: 'x',
      }),
    ).toString('base64url');

    for (const value of [`${header ?? ''}.${forgedPayload}.${signature ?? ''}`, 'garbage', '']) {
      client.cookies.set(OIDC_COOKIE, value);
      const callback = await client.get(
        `/v1/auth/google/callback?code=${code}&state=${encodeURIComponent(request.state)}`,
      );
      expect(landed(callback).searchParams.get('error'), value).toBe('state_invalid');
    }

    // An access token is signed with the same secret but is not accepted as a flow cookie.
    const session = h.client();
    const staffSignIn = await createStaff();
    await signIn(goodClaims(staffSignIn.email), { client: session });
    client.cookies.set(OIDC_COOKIE, session.cookie(ACCESS_COOKIE) ?? '');
    const callback = await client.get(
      `/v1/auth/google/callback?code=${code}&state=${encodeURIComponent(request.state)}`,
    );
    expect(landed(callback).searchParams.get('error')).toBe('state_invalid');
  });

  it('uses each authorization code once', async () => {
    const staff = await createStaff();
    const first = await signIn(goodClaims(staff.email));
    expect(first.client.cookie(ACCESS_COOKIE)).toBeDefined();
    // Replaying the same callback in the same browser: the state cookie is gone after first use.
    const replay = await first.client.get(
      `/v1/auth/google/callback?code=${first.code}&state=${encodeURIComponent(first.request.state)}`,
    );
    expect(landed(replay).searchParams.get('error')).toBe('state_invalid');

    // Even with the cookie restored, the provider refuses the used code.
    const client = h.client();
    const start = await client.get('/v1/auth/google/start');
    const request = idp.parseAuthorize(start.headers.get('location') ?? '');
    const code = idp.approve(request, goodClaims(staff.email, { sub: first.code }));
    const cookie = client.cookie(OIDC_COOKIE) ?? '';
    const ok = await client.get(
      `/v1/auth/google/callback?code=${code}&state=${encodeURIComponent(request.state)}`,
    );
    expect(ok.status).toBe(302);
    client.cookies.set(OIDC_COOKIE, cookie);
    const again = await client.get(
      `/v1/auth/google/callback?code=${code}&state=${encodeURIComponent(request.state)}`,
    );
    expect(landed(again).searchParams.get('error')).toBe('google_unavailable');
  });

  it.each<[string, TokenFaults]>([
    ["signed with a key that is not the provider's", { wrongKey: true }],
    ['issued for another client', { audience: 'someone-elses-client-id' }],
    ['bound to another nonce (replayed into this flow)', { nonce: 'a-different-nonce-value' }],
    ['already expired', { expired: true }],
  ])('rejects an ID token %s', async (_name, faults) => {
    const staff = await createStaff();
    const { client, callback } = await signIn(goodClaims(staff.email), { faults });
    expect(landed(callback).searchParams.get('error')).toBe('google_unavailable');
    expect(client.cookie(ACCESS_COOKIE)).toBeUndefined();
  });

  it('reports a user who declined at the provider, without trying to exchange anything', async () => {
    const client = h.client();
    const start = await client.get('/v1/auth/google/start');
    const request = idp.parseAuthorize(start.headers.get('location') ?? '');
    const callback = await client.get(
      `/v1/auth/google/callback?error=access_denied&state=${encodeURIComponent(request.state)}`,
    );
    expect(landed(callback).searchParams.get('error')).toBe('google_denied');
  });

  it('does not break when the callback has no parameters at all', async () => {
    const callback = await h.client().get('/v1/auth/google/callback');
    expect(landed(callback).searchParams.get('error')).toBe('state_invalid');
  });
});

describe('when the provider is unreachable', () => {
  it('sends the browser to the login page with an error instead of failing', async () => {
    const broken = await startHarness({
      env: {
        GOOGLE_OIDC_CLIENT_ID: 'id',
        GOOGLE_OIDC_CLIENT_SECRET: 'secret',
        GOOGLE_ALLOWED_DOMAIN: DOMAIN,
      },
      oidc: { issuer: new URL('http://127.0.0.1:1') },
    });
    try {
      const response = await broken.client().get('/v1/auth/google/start');
      expect(response.status).toBe(302);
      expect(landed(response).searchParams.get('error')).toBe('google_unavailable');
      // And mock-mode helpers stay closed.
      expect(
        (await broken.client().post('/v1/auth/dev-login', { email: uniqueEmail('a') })).status,
      ).toBe(404);
    } finally {
      await broken.close();
    }
  });
});
