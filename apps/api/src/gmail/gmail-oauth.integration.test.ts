import { createHash } from 'node:crypto';

import { gmail, type FetchLike } from '@watchtower/channels';
import { AUDIT_ACTIONS } from '@watchtower/shared';
import type {
  GmailConnectionStatus,
  GmailOauthResult,
  GmailOauthStartResult,
} from '@watchtower/shared';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REDIS } from '../redis/redis.module.js';
import { startHarness, type Harness } from '../testing/harness.js';
import { captureLogs } from '../testing/support.js';
import { signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';
import { GMAIL_OAUTH_FETCH } from './gmail-oauth.service.js';

// T-102e: connect the support mailbox by OAuth, on real Postgres and Redis. Google is a scripted
// `fetch`; nothing leaves the machine. Every secret below is a marker so the tests can search logs,
// audit rows, responses and redirects for it.

const CLIENT_ID = 'oauth-client-id-marker.apps.example.test';
const CLIENT_SECRET = 'PLAINTEXT-oauth-client-secret-4e1b9c';
const REFRESH = 'PLAINTEXT-refresh-token-a83d02';
const ACCESS = 'PLAINTEXT-access-token-71c5ef';
const CODE = 'PLAINTEXT-auth-code-0f66b1';
const ENV_REFRESH = 'PLAINTEXT-env-refresh-token-9b2e11';
const NEW_TOKEN = 'PLAINTEXT-second-refresh-token-2d8a41';
const NEW_TOKEN_2 = 'PLAINTEXT-third-refresh-token-90c7e5';
const MARKERS = [CLIENT_SECRET, REFRESH, ACCESS, CODE, ENV_REFRESH, NEW_TOKEN, NEW_TOKEN_2];
const MAILBOX = 'support@example.com';
const [READ_SCOPE, SEND_SCOPE] = gmail.GMAIL_OAUTH_SCOPES;
const BOTH_SCOPES = gmail.GMAIL_OAUTH_SCOPES.join(' ');

interface GoogleCall {
  readonly url: string;
  readonly method: string;
  readonly form: URLSearchParams;
  readonly authorization: string | null;
}

/** The three Google endpoints this flow reaches, scripted per test. */
class FakeGoogle {
  readonly calls: GoogleCall[] = [];
  token: () => Response = () => FakeGoogle.json(FakeGoogle.grant());
  profile: () => Response = () => FakeGoogle.json({ emailAddress: MAILBOX });
  revoke: () => Response = () => new Response('', { status: 200 });

  static json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  static grant(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      access_token: ACCESS,
      expires_in: 3599,
      refresh_token: REFRESH,
      scope: BOTH_SCOPES,
      token_type: 'Bearer',
      ...over,
    };
  }

  reset(): void {
    this.calls.length = 0;
    this.token = () => FakeGoogle.json(FakeGoogle.grant());
    this.profile = () => FakeGoogle.json({ emailAddress: MAILBOX });
    this.revoke = () => new Response('', { status: 200 });
  }

  readonly fetch: FetchLike = (url, init) => {
    const headers = new Headers(init?.headers);
    this.calls.push({
      url,
      method: init?.method ?? 'GET',
      form: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
      authorization: headers.get('authorization'),
    });
    const host = new URL(url).host;
    if (host === 'oauth2.googleapis.com' && url.endsWith('/token')) {
      return Promise.resolve(this.token());
    }
    if (host === 'oauth2.googleapis.com' && url.endsWith('/revoke')) {
      return Promise.resolve(this.revoke());
    }
    if (host === 'gmail.googleapis.com') return Promise.resolve(this.profile());
    return Promise.reject(new Error(`unexpected host ${host}`));
  };

  ofKind(kind: 'token' | 'revoke' | 'profile'): GoogleCall[] {
    const suffix = { token: '/token', revoke: '/revoke', profile: '/profile' }[kind];
    return this.calls.filter((call) => call.url.endsWith(suffix));
  }
}

const logs = captureLogs();
const google = new FakeGoogle();
let h: Harness;
const seen: string[] = [];
const owner = () => h.db.owner.pool;

async function call<T>(
  who: Persona,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
) {
  const response = await who.client.request<T>(method, path, body === undefined ? {} : { body });
  seen.push(JSON.stringify(response.body), response.headers.get('location') ?? '');
  return response;
}

async function head(): Promise<Persona> {
  return signIn(h, 'head');
}

/** A head who has saved the OAuth client (the admin page's PUT) and is ready to start. */
async function headWithClient(): Promise<Persona> {
  const who = await head();
  const saved = await call(who, 'PUT', '/v1/admin/integrations/gmail', {
    fields: { oauthClientId: CLIENT_ID, oauthClientSecret: CLIENT_SECRET },
  });
  expect(saved.status).toBe(200);
  return who;
}

const START = '/v1/admin/integrations/gmail/oauth/start';
const CALLBACK = '/v1/admin/integrations/gmail/oauth/callback';
const STATUS = '/v1/admin/integrations/gmail/oauth/status';
const DISCONNECT = '/v1/admin/integrations/gmail/oauth/disconnect';

async function start(who: Persona, mailbox = MAILBOX) {
  const response = await call<GmailOauthStartResult>(who, 'POST', START, { mailbox });
  expect(response.status).toBe(200);
  const url = new URL(response.body.authorizationUrl);
  return { response, url, state: url.searchParams.get('state') ?? '' };
}

function callbackPath(state: string, extra: Record<string, string> = { code: CODE }): string {
  return `${CALLBACK}?${new URLSearchParams({ state, ...extra }).toString()}`;
}

function resultOf(response: {
  status: number;
  headers: Headers;
}): GmailOauthResult | 'no-redirect' {
  if (response.status !== 302) return 'no-redirect';
  const location = new URL(response.headers.get('location') ?? '');
  expect(location.origin).toBe(new URL(h.config.APP_URL).origin);
  expect(location.pathname).toBe('/admin/integrations');
  return (location.searchParams.get('gmail_oauth') ?? 'no-redirect') as GmailOauthResult;
}

async function finish(who: Persona, state: string, extra?: Record<string, string>) {
  const response = await call(who, 'GET', callbackPath(state, extra));
  return { response, result: resultOf(response) };
}

async function auditRows(action: string) {
  const result = await owner().query<{
    actor_id: string | null;
    outcome: string;
    target_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT actor_id, outcome, target_id, metadata FROM audit_log WHERE action = $1 ORDER BY created_at, id`,
    [action],
  );
  return result.rows;
}

async function storedFields(): Promise<string[]> {
  const rows = await owner().query<{ field: string }>(
    `SELECT field FROM integration_credential WHERE integration = 'gmail' ORDER BY field`,
  );
  return rows.rows.map((row) => row.field);
}

async function clearConnection(): Promise<void> {
  await owner().query(
    `DELETE FROM integration_credential WHERE integration = 'gmail' AND field IN ('oauthRefreshToken','oauthMailbox')`,
  );
}

beforeAll(async () => {
  h = await startHarness({
    logs,
    env: { LOG_LEVEL: 'trace' },
    overrides: [{ token: GMAIL_OAUTH_FETCH, value: google.fetch }],
  });
});
afterAll(async () => {
  await h.close();
});

describe('access', () => {
  const routes: readonly [string, string, unknown][] = [
    ['POST', START, { mailbox: MAILBOX }],
    ['GET', `${CALLBACK}?state=x&code=y`, undefined],
    ['GET', STATUS, undefined],
    ['POST', DISCONNECT, {}],
  ];

  it('is for the head only: lead, agent and client get 403, no session gets 401, nothing is written or sent', async () => {
    const lead = await signIn(h, 'lead');
    const agent = await signIn(h, 'agent');
    const org = await lead.client.post<{ id: string }>('/v1/orgs', { name: 'Acme OAuth' });
    const client = await signIn(h, 'client', org.body.id);
    for (const [method, path, body] of routes) {
      for (const who of [lead, agent, client]) {
        const response = await who.client.request(method, path, body === undefined ? {} : { body });
        expect(response.status, `${who.session.user.role} ${method} ${path}`).toBe(403);
      }
      const anonymous = await h
        .client()
        .request(method, path, body === undefined ? {} : { body, csrf: false });
      expect(anonymous.status, `anonymous ${method} ${path}`).toBe(401);
    }
    expect(google.calls).toEqual([]);
    expect(await storedFields()).toEqual([]);
    expect(
      (await owner().query("SELECT 1 FROM channel_account WHERE type = 'gmail'")).rowCount,
    ).toBe(0);
  });
});

describe('start', () => {
  it('needs the OAuth client to be saved first', async () => {
    const who = await head();
    const response = await call<ApiErrorBody>(who, 'POST', START, { mailbox: MAILBOX });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('conflict');
  });

  it('refuses something that is not an email address', async () => {
    const who = await headWithClient();
    for (const mailbox of ['', 'not-an-address', 'a@b']) {
      const response = await call(who, 'POST', START, { mailbox });
      expect(response.status, mailbox).toBe(400);
    }
  });

  it('answers with a Google URL that asks for exactly the two scopes, offline access, consent and an S256 challenge', async () => {
    const who = await headWithClient();
    const { response, url } = await start(who, 'Support@Example.com');
    const p = url.searchParams;
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('scope')).toBe(`${READ_SCOPE} ${SEND_SCOPE}`);
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge') ?? '').toHaveLength(43);
    expect(p.get('state') ?? '').not.toBe('');
    expect(p.get('login_hint')).toBe(MAILBOX);
    expect(p.get('redirect_uri')).toBe(
      new URL('/v1/admin/integrations/gmail/oauth/callback', h.config.API_URL).toString(),
    );
    expect(response.body.redirectUri).toBe(p.get('redirect_uri'));
    expect(new Date(response.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // The URL goes to the browser: no secret in it.
    expect(response.body.authorizationUrl).not.toContain(CLIENT_SECRET);
    // The server contacted nobody to build it.
    expect(google.calls).toEqual([]);
    // Audited without the mailbox.
    const rows = await auditRows(AUDIT_ACTIONS.gmailOauthStart);
    expect(rows.at(-1)).toMatchObject({
      actor_id: who.userId,
      outcome: 'success',
      target_id: 'gmail',
    });
    expect(JSON.stringify(rows.at(-1))).not.toContain('example.com');
  });

  it('keeps the state and the PKCE verifier on the server, hashed key, with an expiry', async () => {
    const who = await headWithClient();
    const { state } = await start(who);
    const redis = h.app.get<Redis>(REDIS);
    const key = `${h.config.RATE_LIMIT_NAMESPACE}:gmail-oauth:${createHash('sha256').update(state).digest('hex')}`;
    expect(await redis.ttl(key)).toBeGreaterThan(0);
    const keys = await redis.keys(`${h.config.RATE_LIMIT_NAMESPACE}:gmail-oauth:*`);
    for (const stored of keys) expect(stored).not.toContain(state);
  });
});

describe('callback', () => {
  it('stores the refresh token encrypted, creates the mailbox, queues a sync, audits and redirects with a result code only', async () => {
    google.reset();
    const who = await headWithClient();
    const { url, state } = await start(who);
    const { response, result } = await finish(who, state);
    expect(result).toBe('connected');
    expect(response.status).toBe(302);

    // The code was traded once, with the verifier whose S256 hash is the challenge we sent.
    const [exchange] = google.ofKind('token');
    expect(google.ofKind('token')).toHaveLength(1);
    expect(Object.fromEntries(exchange?.form ?? [])).toMatchObject({
      grant_type: 'authorization_code',
      code: CODE,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: url.searchParams.get('redirect_uri'),
    });
    const verifier = exchange?.form.get('code_verifier') ?? '';
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      url.searchParams.get('code_challenge'),
    );
    // The address came from Google, with the new access token.
    expect(google.ofKind('profile')[0]?.authorization).toBe(`Bearer ${ACCESS}`);
    expect(google.ofKind('revoke')).toEqual([]);

    // Sealed in the credential store: no plaintext anywhere in the table.
    expect(await storedFields()).toEqual(
      expect.arrayContaining([
        'oauthClientId',
        'oauthClientSecret',
        'oauthMailbox',
        'oauthRefreshToken',
      ]),
    );
    const sealed = await owner().query<{ value_sealed: string; dek_wrapped: string }>(
      `SELECT value_sealed, dek_wrapped FROM integration_credential WHERE integration = 'gmail'`,
    );
    for (const row of sealed.rows) {
      for (const marker of MARKERS) {
        expect(row.value_sealed).not.toContain(marker);
        expect(row.dek_wrapped).not.toContain(marker);
      }
    }

    // The mailbox exists, and a catch-up sync was queued for it.
    const account = await owner().query<{ id: string; name: string; email_address: string }>(
      `SELECT a.id, a.name, s.email_address FROM channel_account a JOIN gmail_account_state s ON s.channel_account_id = a.id WHERE a.type = 'gmail'`,
    );
    expect(account.rows).toHaveLength(1);
    expect(account.rows[0]?.email_address).toBe(MAILBOX);
    const jobs = await owner().query<{ payload: { channelAccountId: string; reason: string } }>(
      `SELECT payload FROM outbox WHERE queue = 'gmail'`,
    );
    expect(jobs.rows.map((row) => row.payload)).toContainEqual({
      channelAccountId: account.rows[0]?.id,
      reason: 'manual',
    });

    // Audited with field names, not values.
    const rows = await auditRows(AUDIT_ACTIONS.gmailOauthConnect);
    const success = rows.find((row) => row.outcome === 'success' && row.actor_id === who.userId);
    expect(success?.metadata).toMatchObject({ fields: ['oauthMailbox', 'oauthRefreshToken'] });

    // Status shows the connection without a value.
    const status = await call<GmailConnectionStatus>(who, 'GET', STATUS);
    expect(status.body).toMatchObject({
      oauthClientConfigured: true,
      oauthConnected: true,
      oauthMailbox: MAILBOX,
      serviceAccountConfigured: false,
      effectiveMethod: 'oauth',
      needsReconnect: false,
    });
    const list = await call<{ items: { key: string }[] }>(who, 'GET', '/v1/admin/integrations');
    expect(list.body.items.map((item) => item.key)).toContain('gmail');
  });

  it('works once: a second use of the same state is refused and Google is not asked again', async () => {
    google.reset();
    const who = await headWithClient();
    const { state } = await start(who);
    expect((await finish(who, state)).result).toBe('connected');
    const before = google.calls.length;
    expect((await finish(who, state)).result).toBe('state_invalid');
    expect(google.calls.length).toBe(before);
  });

  it('refuses an unknown, empty, missing or expired state without calling Google', async () => {
    google.reset();
    const who = await headWithClient();
    expect((await finish(who, 'never-issued')).result).toBe('state_invalid');
    expect((await call(who, 'GET', `${CALLBACK}?code=${CODE}`)).status).toBe(302);
    expect(resultOf(await call(who, 'GET', `${CALLBACK}?code=${CODE}`))).toBe('state_invalid');
    const { state } = await start(who);
    const redis = h.app.get<Redis>(REDIS);
    await redis.del(
      `${h.config.RATE_LIMIT_NAMESPACE}:gmail-oauth:${createHash('sha256').update(state).digest('hex')}`,
    );
    expect((await finish(who, state)).result).toBe('state_invalid');
    expect(google.calls).toEqual([]);
  });

  it('is bound to the session: another session of the same person, or another head, cannot finish it', async () => {
    google.reset();
    const who = await headWithClient();
    const { state } = await start(who);
    // The same person signed in elsewhere is a different session.
    const second = h.client();
    const secondSession = await second.devLogin(who.email, 'head');
    expect(secondSession.user.id).toBe(who.userId);
    const sameUser: Persona = {
      client: second,
      email: who.email,
      session: secondSession,
      userId: who.userId,
    };
    expect((await finish(sameUser, state)).result).toBe('state_invalid');
    // The state was spent by the failed attempt: the real session cannot reuse it either.
    expect((await finish(who, state)).result).toBe('state_invalid');

    const next = await start(who);
    const other = await head();
    expect((await finish(other, next.state)).result).toBe('state_invalid');
    expect(google.calls).toEqual([]);
    const refused = await auditRows(AUDIT_ACTIONS.gmailOauthConnect);
    expect(
      refused.filter((row) => row.outcome === 'failure').map((row) => row.metadata.reason),
    ).toContain('state_invalid');
  });

  it("treats Google's error parameter as denied and saves nothing", async () => {
    google.reset();
    await clearConnection();
    const who = await headWithClient();
    const { state } = await start(who);
    const { result } = await finish(who, state, { error: 'access_denied' });
    expect(result).toBe('denied');
    expect(google.calls).toEqual([]);
    expect(await storedFields()).not.toContain('oauthRefreshToken');
  });

  it.each([
    ['fewer scopes', READ_SCOPE],
    ['a wider scope', `${BOTH_SCOPES} https://www.googleapis.com/auth/gmail.modify`],
    ['a different scope', `${READ_SCOPE} https://mail.google.com/`],
    ['no scope field', undefined],
  ])('refuses a grant with %s: nothing is saved and the grant is revoked', async (_name, scope) => {
    google.reset();
    await clearConnection();
    google.token = () => FakeGoogle.json(FakeGoogle.grant({ scope }));
    const who = await headWithClient();
    const { state } = await start(who);
    const { result } = await finish(who, state);
    expect(result).toBe('scope_mismatch');
    expect(await storedFields()).not.toContain('oauthRefreshToken');
    expect(google.ofKind('revoke')[0]?.form.get('token')).toBe(REFRESH);
    // The profile was not even read with a token we do not accept.
    expect(google.ofKind('profile')).toEqual([]);
    const rows = await auditRows(AUDIT_ACTIONS.gmailOauthConnect);
    expect(rows.at(-1)).toMatchObject({
      outcome: 'failure',
      metadata: { reason: 'scope_mismatch' },
    });
  });

  it('refuses a callback whose account is not the mailbox asked for', async () => {
    google.reset();
    await clearConnection();
    google.profile = () => FakeGoogle.json({ emailAddress: 'someone.else@example.com' });
    const who = await headWithClient();
    const { state } = await start(who);
    const { result } = await finish(who, state);
    expect(result).toBe('mailbox_mismatch');
    expect(await storedFields()).not.toContain('oauthRefreshToken');
    expect(google.ofKind('revoke')[0]?.form.get('token')).toBe(REFRESH);
    // Nothing about the other address is kept.
    const accounts = await owner().query(
      `SELECT 1 FROM gmail_account_state WHERE email_address = 'someone.else@example.com'`,
    );
    expect(accounts.rowCount).toBe(0);
  });

  it('compares addresses without regard to case', async () => {
    google.reset();
    await clearConnection();
    google.profile = () => FakeGoogle.json({ emailAddress: MAILBOX.toUpperCase() });
    const who = await headWithClient();
    const { state } = await start(who, MAILBOX);
    expect((await finish(who, state)).result).toBe('connected');
  });

  it('refuses a grant without a refresh token', async () => {
    google.reset();
    await clearConnection();
    google.token = () => FakeGoogle.json(FakeGoogle.grant({ refresh_token: undefined }));
    const who = await headWithClient();
    const { state } = await start(who);
    expect((await finish(who, state)).result).toBe('no_refresh_token');
    expect(await storedFields()).not.toContain('oauthRefreshToken');
  });

  it.each([
    ['a 503 from the token endpoint', () => FakeGoogle.json({}, 503), 'unavailable'],
    ['invalid_grant on the code', () => FakeGoogle.json({ error: 'invalid_grant' }, 400), 'denied'],
  ])('reports %s without saving anything', async (_name, token, expected) => {
    google.reset();
    await clearConnection();
    google.token = token;
    const who = await headWithClient();
    const { state } = await start(who);
    expect((await finish(who, state)).result).toBe(expected);
    expect(await storedFields()).not.toContain('oauthRefreshToken');
  });

  it('reports an unreadable profile as unavailable and revokes the grant', async () => {
    google.reset();
    await clearConnection();
    google.profile = () => FakeGoogle.json({}, 500);
    const who = await headWithClient();
    const { state } = await start(who);
    expect((await finish(who, state)).result).toBe('unavailable');
    expect(google.ofKind('revoke')).toHaveLength(1);
    expect(await storedFields()).not.toContain('oauthRefreshToken');
  });

  it('on a reconnection clears "not connected" and replaces the token', async () => {
    google.reset();
    await clearConnection();
    const who = await headWithClient();
    expect((await finish(who, (await start(who)).state)).result).toBe('connected');
    await owner().query(
      `UPDATE gmail_account_state SET last_error_code = 'not_connected' WHERE email_address = $1`,
      [MAILBOX],
    );
    await owner().query(`UPDATE channel_account SET health = 'unhealthy' WHERE type = 'gmail'`);
    const before = await call<GmailConnectionStatus>(who, 'GET', STATUS);
    expect(before.body.needsReconnect).toBe(true);

    const rotated = 'PLAINTEXT-rotated-refresh-token-5c0d77';
    google.token = () => FakeGoogle.json(FakeGoogle.grant({ refresh_token: rotated }));
    expect((await finish(who, (await start(who)).state)).result).toBe('connected');
    const after = await call<GmailConnectionStatus>(who, 'GET', STATUS);
    expect(after.body.needsReconnect).toBe(false);
    const accounts = await owner().query(`SELECT 1 FROM channel_account WHERE type = 'gmail'`);
    expect(accounts.rowCount).toBe(1);
    MARKERS.push(rotated);
  });
});

describe('the grant, once stored', () => {
  const OTHER = 'other.mailbox@example.com';

  /** Runs the whole flow for `mailbox` and answers the result. The token Google issues is `token`. */
  async function connect(who: Persona, token: string, mailbox = MAILBOX) {
    google.token = () => FakeGoogle.json(FakeGoogle.grant({ refresh_token: token }));
    google.profile = () => FakeGoogle.json({ emailAddress: mailbox });
    return (await finish(who, (await start(who, mailbox)).state)).result;
  }

  async function lastAudit(action: string) {
    return (await auditRows(action)).at(-1);
  }

  it('cannot be saved or deleted through the generic credential routes, which would skip the scope and mailbox checks', async () => {
    google.reset();
    await clearConnection();
    const who = await headWithClient();
    const typed = 'TYPED-not-a-real-token';
    for (const fields of [
      { oauthRefreshToken: typed },
      { oauthMailbox: OTHER },
      { oauthMailbox: OTHER, oauthClientId: CLIENT_ID },
    ]) {
      const response = await call<ApiErrorBody>(who, 'PUT', '/v1/admin/integrations/gmail', {
        fields,
      });
      expect(response.status, JSON.stringify(Object.keys(fields))).toBe(400);
      expect(JSON.stringify(response.body)).not.toContain(typed);
    }
    expect(await storedFields()).not.toContain('oauthRefreshToken');
    expect(await storedFields()).not.toContain('oauthMailbox');

    expect(await connect(who, REFRESH)).toBe('connected');
    for (const field of ['oauthRefreshToken', 'oauthMailbox']) {
      const response = await call(who, 'DELETE', `/v1/admin/integrations/gmail/fields/${field}`);
      expect(response.status, field).toBe(400);
    }
    expect(await storedFields()).toEqual(
      expect.arrayContaining(['oauthMailbox', 'oauthRefreshToken']),
    );
    // The client fields stay editable the usual way.
    const client = await call(who, 'PUT', '/v1/admin/integrations/gmail', {
      fields: { oauthClientId: CLIENT_ID },
    });
    expect(client.status).toBe(200);
  });

  it('is not revoked by a rejected reconnect: the issued token is kept when a working grant may be the same', async () => {
    google.reset();
    await clearConnection();
    const who = await headWithClient();
    expect(await connect(who, REFRESH)).toBe('connected');
    google.calls.length = 0;

    // Fewer scopes, same mailbox: the account is the one in use, so nothing is revoked.
    google.token = () =>
      FakeGoogle.json(FakeGoogle.grant({ refresh_token: NEW_TOKEN, scope: READ_SCOPE }));
    expect((await finish(who, (await start(who)).state)).result).toBe('scope_mismatch');
    expect(google.ofKind('revoke')).toEqual([]);
    expect((await lastAudit(AUDIT_ACTIONS.gmailOauthConnect))?.metadata).toMatchObject({
      reason: 'scope_mismatch',
      revoke: 'skipped_working_grant',
    });

    // Another account granted: its token is not the one in use and is revoked (and says so).
    google.token = () => FakeGoogle.json(FakeGoogle.grant({ refresh_token: NEW_TOKEN }));
    google.profile = () => FakeGoogle.json({ emailAddress: OTHER });
    expect((await finish(who, (await start(who)).state)).result).toBe('mailbox_mismatch');
    expect(google.ofKind('revoke').map((entry) => entry.form.get('token'))).toEqual([NEW_TOKEN]);
    expect((await lastAudit(AUDIT_ACTIONS.gmailOauthConnect))?.metadata).toMatchObject({
      reason: 'mailbox_mismatch',
      revoke: 'revoked',
    });

    // The grant in use is untouched.
    const status = await call<GmailConnectionStatus>(who, 'GET', STATUS);
    expect(status.body).toMatchObject({ oauthConnected: true, oauthMailbox: MAILBOX });
  });

  it('audits a revoke that Google did not confirm', async () => {
    google.reset();
    await clearConnection();
    const who = await headWithClient();
    google.revoke = () => FakeGoogle.json({}, 500);
    google.token = () =>
      FakeGoogle.json(FakeGoogle.grant({ refresh_token: NEW_TOKEN, scope: READ_SCOPE }));
    expect((await finish(who, (await start(who)).state)).result).toBe('scope_mismatch');
    expect((await lastAudit(AUDIT_ACTIONS.gmailOauthConnect))?.metadata).toMatchObject({
      revoke: 'failed',
    });
  });

  it('is revoked when the mailbox changes, but not when the same mailbox reconnects', async () => {
    google.reset();
    await clearConnection();
    const who = await headWithClient();
    expect(await connect(who, REFRESH)).toBe('connected');

    google.calls.length = 0;
    expect(await connect(who, NEW_TOKEN)).toBe('connected'); // same mailbox
    expect(google.ofKind('revoke')).toEqual([]);

    expect(await connect(who, NEW_TOKEN_2, OTHER)).toBe('connected'); // another mailbox
    expect(google.ofKind('revoke').map((entry) => entry.form.get('token'))).toEqual([NEW_TOKEN]);
    expect(await lastAudit(AUDIT_ACTIONS.gmailOauthDisconnect)).toMatchObject({
      outcome: 'success',
      metadata: { reason: 'mailbox_changed', revoke: 'revoked' },
    });
    const status = await call<GmailConnectionStatus>(who, 'GET', STATUS);
    expect(status.body.oauthMailbox).toBe(OTHER);

    // And a revoke that fails is a failure entry, not silence.
    google.revoke = () => FakeGoogle.json({}, 503);
    expect(await connect(who, REFRESH, MAILBOX)).toBe('connected');
    expect(await lastAudit(AUDIT_ACTIONS.gmailOauthDisconnect)).toMatchObject({
      outcome: 'failure',
      metadata: { reason: 'mailbox_changed', revoke: 'failed' },
    });
  });

  it('disconnects: revokes at Google, deletes the grant, audits, and is a no-op the second time', async () => {
    google.reset();
    await clearConnection();
    const who = await headWithClient();
    expect(await connect(who, REFRESH)).toBe('connected');
    google.calls.length = 0;

    const done = await call<{ revoke: string }>(who, 'POST', DISCONNECT, {});
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ revoke: 'revoked' });
    expect(google.ofKind('revoke').map((entry) => entry.form.get('token'))).toEqual([REFRESH]);
    const stored = await storedFields();
    expect(stored).not.toContain('oauthRefreshToken');
    expect(stored).not.toContain('oauthMailbox');
    expect(stored).toContain('oauthClientSecret'); // the client stays
    expect(await lastAudit(AUDIT_ACTIONS.gmailOauthDisconnect)).toMatchObject({
      actor_id: who.userId,
      outcome: 'success',
      metadata: { reason: 'disconnect', revoke: 'revoked' },
    });
    const status = await call<GmailConnectionStatus>(who, 'GET', STATUS);
    expect(status.body).toMatchObject({ oauthConnected: false, effectiveMethod: null });

    google.calls.length = 0;
    expect((await call(who, 'POST', DISCONNECT, {})).body).toEqual({ revoke: 'none' });
    expect(google.calls).toEqual([]);
  });

  it('disconnects even when Google does not confirm the revoke, and says so', async () => {
    google.reset();
    await clearConnection();
    const who = await headWithClient();
    expect(await connect(who, REFRESH)).toBe('connected');
    google.revoke = () => FakeGoogle.json({}, 500);
    const done = await call<{ revoke: string }>(who, 'POST', DISCONNECT, {});
    expect(done.body).toEqual({ revoke: 'failed' });
    expect(await storedFields()).not.toContain('oauthRefreshToken');
    expect(await lastAudit(AUDIT_ACTIONS.gmailOauthDisconnect)).toMatchObject({
      outcome: 'failure',
      metadata: { revoke: 'failed' },
    });
  });
});

describe('what never appears', () => {
  it('has no secret in any response, redirect, log line, audit row, outbox row or sealed value', async () => {
    const rows = await owner().query(`SELECT to_jsonb(audit_log) AS row FROM audit_log`);
    const outbox = await owner().query(`SELECT to_jsonb(outbox) AS row FROM outbox`);
    const everything = [
      seen.join('\n'),
      logs.raw(),
      JSON.stringify(rows.rows),
      JSON.stringify(outbox.rows),
    ].join('\n');
    expect(everything.length).toBeGreaterThan(0);
    for (const marker of MARKERS) {
      expect(everything, marker).not.toContain(marker);
    }
    // Only Google's hosts were ever contacted.
    const hosts = new Set(google.calls.map((entry) => new URL(entry.url).host));
    for (const host of hosts) expect(gmail.GMAIL_OAUTH_HOSTS).toContain(host);
  });
});

describe('with the refresh token set by the environment', () => {
  it('refuses to start: the database could not hold it', async () => {
    const env = await startHarness({
      logs,
      env: { GMAIL_OAUTH_REFRESH_TOKEN: ENV_REFRESH, GMAIL_OAUTH_MAILBOX: MAILBOX },
      overrides: [{ token: GMAIL_OAUTH_FETCH, value: google.fetch }],
    });
    try {
      const who = await signIn(env, 'head');
      await who.client.request('PUT', '/v1/admin/integrations/gmail', {
        body: { fields: { oauthClientId: CLIENT_ID, oauthClientSecret: CLIENT_SECRET } },
      });
      const response = await who.client.post<ApiErrorBody>(START, { mailbox: MAILBOX });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('credential_env_locked');
      const status = await who.client.get<GmailConnectionStatus>(STATUS);
      expect(status.body).toMatchObject({
        oauthConnected: true,
        oauthMailbox: MAILBOX,
        effectiveMethod: 'oauth',
      });
      expect(JSON.stringify(status.body)).not.toContain(ENV_REFRESH);
      expect(logs.raw()).not.toContain(ENV_REFRESH);
    } finally {
      await env.close();
    }
  });

  it('refuses to start when a service account set entirely by the environment would be used instead', async () => {
    const env = await startHarness({
      logs,
      env: {
        GMAIL_SERVICE_ACCOUNT_JSON_PATH: '/nonexistent/service-account.json',
        GMAIL_IMPERSONATE_USER: MAILBOX,
      },
      overrides: [{ token: GMAIL_OAUTH_FETCH, value: google.fetch }],
    });
    try {
      const who = await signIn(env, 'head');
      await who.client.request('PUT', '/v1/admin/integrations/gmail', {
        body: { fields: { oauthClientId: CLIENT_ID, oauthClientSecret: CLIENT_SECRET } },
      });
      const response = await who.client.post<ApiErrorBody>(START, { mailbox: MAILBOX });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('credential_env_locked');
    } finally {
      await env.close();
    }
  });

  it('lets OAuth connect when only one stray variable of the service account is in the environment', async () => {
    google.reset();
    const env = await startHarness({
      logs,
      env: { GMAIL_IMPERSONATE_USER: MAILBOX },
      overrides: [{ token: GMAIL_OAUTH_FETCH, value: google.fetch }],
    });
    try {
      const who = await signIn(env, 'head');
      await who.client.request('PUT', '/v1/admin/integrations/gmail', {
        body: { fields: { oauthClientId: CLIENT_ID, oauthClientSecret: CLIENT_SECRET } },
      });
      const response = await who.client.post<GmailOauthStartResult>(START, { mailbox: MAILBOX });
      expect(response.status).toBe(200);
    } finally {
      await env.close();
    }
  });
});
