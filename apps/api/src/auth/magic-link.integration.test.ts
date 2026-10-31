import { createHash } from 'node:crypto';

import { emailJobSchema, type SessionInfo } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOrg, startHarness, uniqueEmail, type Harness } from '../testing/harness.js';
import { CLIENT_ORG_RESOLVER, MagicLinkService, emailTag } from './magic-link.service.js';

// Client magic-link sign-in: the real application, Postgres, Redis and the BullMQ email queue from
// docker compose. The worker side (SMTP into Mailpit) is covered by apps/worker.

let h: Harness;
let orgId: string;
let domainOrgId: string;

const resolver = {
  resolveOrgId: (email: string) =>
    Promise.resolve(email.endsWith('@acme-customer.example') ? domainOrgId : null),
};

beforeAll(async () => {
  h = await startHarness({ overrides: [{ token: CLIENT_ORG_RESOLVER, value: resolver }] });
  orgId = await createOrg(h.db.owner.pool);
  domainOrgId = await createOrg(h.db.owner.pool);
});

afterAll(async () => {
  await h.close();
});

const pool = () => h.db.owner.pool;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function createClient(
  email = uniqueEmail('client'),
  status: 'active' | 'disabled' = 'active',
) {
  await pool().query(
    `INSERT INTO users (email, name, role, org_id, status) VALUES ($1, 'Client', 'client', $2, $3)`,
    [email, orgId, status],
  );
  return email;
}

async function settle(): Promise<void> {
  await h.app.get(MagicLinkService).whenIdle();
}

/** Every email job addressed to `email`, oldest first. */
async function jobsFor(email: string) {
  await h.relayOutbox();
  const jobs = await h.emailQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
  return jobs
    .filter((job) => (job.data as { to?: string }).to === email)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function tokenFrom(link: string): string {
  const url = new URL(link);
  expect(url.search).toBe('');
  const match = /^#token=([A-Za-z0-9_-]{43})$/.exec(url.hash);
  expect(match, 'the token travels in the fragment').not.toBeNull();
  return match?.[1] ?? '';
}

/** Requests a link for `email` and returns its token, read from the queued email job. */
async function requestToken(email: string, ip?: string): Promise<string> {
  const before = (await jobsFor(email)).length;
  const client = h.client();
  const response = await client.post(
    '/v1/auth/magic-link/request',
    { email },
    {
      headers: ip === undefined ? {} : { 'x-forwarded-for': ip },
    },
  );
  expect(response.status).toBe(202);
  await settle();
  const jobs = await jobsFor(email);
  expect(jobs.length).toBe(before + 1);
  const payload = emailJobSchema.parse(jobs.at(-1)?.data);
  if (payload.kind !== 'magic_link') throw new Error('expected a magic link email');
  return tokenFrom(payload.link);
}

describe('requesting a link', () => {
  it('answers the same to an unknown address and to a client, and queues mail only for the client', async () => {
    const known = await createClient();
    const unknown = uniqueEmail('stranger');
    const a = h.client();
    const b = h.client();
    const forKnown = await a.post<Record<string, unknown>>('/v1/auth/magic-link/request', {
      email: known,
    });
    const forUnknown = await b.post<Record<string, unknown>>('/v1/auth/magic-link/request', {
      email: unknown,
    });
    await settle();

    expect(forKnown.status).toBe(202);
    expect(forUnknown.status).toBe(202);
    expect(forKnown.body).toEqual({ status: 'accepted' });
    expect(forUnknown.body).toEqual(forKnown.body);
    expect([...forKnown.headers.keys()].sort()).toEqual([...forUnknown.headers.keys()].sort());
    expect(forKnown.setCookies).toEqual([]);
    expect(forUnknown.setCookies).toEqual([]);

    expect(await jobsFor(known)).toHaveLength(1);
    expect(await jobsFor(unknown)).toHaveLength(0);
    const tokens = await pool().query('SELECT 1 FROM magic_link_tokens');
    expect(tokens.rowCount).toBe(1);
  });

  it('queues a mail whose link carries the token in the fragment of the web app url', async () => {
    const email = await createClient();
    const token = await requestToken(email);
    const [job] = await jobsFor(email);
    const payload = emailJobSchema.parse(job?.data);
    expect(payload).toMatchObject({ kind: 'magic_link', to: email, expiresInMinutes: 15 });
    if (payload.kind !== 'magic_link') throw new Error('expected a magic link email');
    expect(payload.link.startsWith('http://localhost:3000/login/magic#token=')).toBe(true);
    expect(token).toHaveLength(43);
    // Idempotency key is derived from the hash, not the token.
    expect(job?.id).toBe(`magic-link-${sha256(token).slice(0, 32)}`);
    expect(job?.id).not.toContain(token);
  });

  it('keeps only a hash of the token in the database', async () => {
    const email = await createClient();
    const token = await requestToken(email);
    const rows = await pool().query<{ token_hash: string }>(
      `SELECT m.token_hash FROM magic_link_tokens m JOIN users u ON u.id = m.user_id WHERE u.email = $1`,
      [email],
    );
    expect(rows.rows).toEqual([{ token_hash: sha256(token) }]);
    const dump = await pool().query(`SELECT to_jsonb(m)::text AS row FROM magic_link_tokens m`);
    expect(JSON.stringify(dump.rows)).not.toContain(token);
  });

  it('normalizes the address', async () => {
    const email = await createClient();
    const response = await h
      .client()
      .post('/v1/auth/magic-link/request', { email: `  ${email.toUpperCase()} ` });
    expect(response.status).toBe(202);
    await settle();
    expect(await jobsFor(email)).toHaveLength(1);
  });

  it('sends nothing to a disabled client, a staff address or a system identity', async () => {
    const disabled = await createClient(uniqueEmail('off'), 'disabled');
    const staff = uniqueEmail('staff');
    const robot = uniqueEmail('robot');
    await pool().query(`INSERT INTO users (email, name, role) VALUES ($1, 'S', 'agent')`, [staff]);
    await pool().query(`INSERT INTO users (email, name, role) VALUES ($1, 'R', 'system')`, [robot]);
    for (const email of [disabled, staff, robot]) {
      expect((await h.client().post('/v1/auth/magic-link/request', { email })).status).toBe(202);
    }
    await settle();
    for (const email of [disabled, staff, robot]) expect(await jobsFor(email)).toHaveLength(0);
  });

  it('creates an account for an unknown address only when the organization resolver knows its domain', async () => {
    const matching = uniqueEmail('new-user', 'acme-customer.example');
    const other = uniqueEmail('new-user', 'unrelated.example');
    for (const email of [matching, other]) {
      expect((await h.client().post('/v1/auth/magic-link/request', { email })).status).toBe(202);
    }
    await settle();
    expect(await jobsFor(matching)).toHaveLength(1);
    expect(await jobsFor(other)).toHaveLength(0);
    const created = await pool().query<{ role: string; org_id: string }>(
      'SELECT role, org_id FROM users WHERE email = $1',
      [matching],
    );
    expect(created.rows).toEqual([{ role: 'client', org_id: domainOrgId }]);
    expect((await pool().query('SELECT 1 FROM users WHERE email = $1', [other])).rowCount).toBe(0);
  });

  it('rejects a malformed address with 400', async () => {
    const client = h.client();
    expect((await client.post('/v1/auth/magic-link/request', { email: 'nope' })).status).toBe(400);
    expect((await client.post('/v1/auth/magic-link/request', {})).status).toBe(400);
    expect((await client.post('/v1/auth/magic-link/request', { email: 42 })).status).toBe(400);
  });
});

describe('signing in with a link', () => {
  it('starts a client session limited to their organization', async () => {
    const email = await createClient();
    const token = await requestToken(email);
    const client = h.client();
    const response = await client.post<SessionInfo>('/v1/auth/magic-link/verify', { token });
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ email, role: 'client', orgId });
    expect(response.body.authMethod).toBe('magic_link');
    expect(response.body.permissions).toContain('ticket.read.org');
    expect(response.body.permissions).not.toContain('ticket.read');
    expect(response.setCookies.some((cookie) => cookie.startsWith('wt_at='))).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain(token);

    client.csrfToken = response.body.csrfToken;
    expect((await client.get('/v1/auth/session')).status).toBe(200);
    expect((await client.get('/v1/audit-logs')).status).toBe(403);
    expect((await client.get('/v1/users')).status).toBe(403);
  });

  it('works once: the same link a second time is refused, and starts no session', async () => {
    const email = await createClient();
    const token = await requestToken(email);
    expect((await h.client().post('/v1/auth/magic-link/verify', { token })).status).toBe(200);

    const second = h.client();
    const replay = await second.post<{ code: string }>('/v1/auth/magic-link/verify', { token });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('invalid_or_expired_link');
    expect(second.cookie('wt_at')).toBeUndefined();
    const sessions = await pool().query(
      `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1`,
      [email],
    );
    expect(sessions.rowCount).toBe(1);
  });

  it('works once even when submitted twice at the same moment', async () => {
    const email = await createClient();
    const token = await requestToken(email);
    const results = await Promise.all([
      h.client().post('/v1/auth/magic-link/verify', { token }),
      h.client().post('/v1/auth/magic-link/verify', { token }),
      h.client().post('/v1/auth/magic-link/verify', { token }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 401, 401]);
  });

  it('refuses an expired link', async () => {
    const email = await createClient();
    const token = await requestToken(email);
    await pool().query(
      `UPDATE magic_link_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1`,
      [sha256(token)],
    );
    const response = await h
      .client()
      .post<{ code: string }>('/v1/auth/magic-link/verify', { token });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('invalid_or_expired_link');
  });

  it('gives a link a short life: MAGIC_LINK_TTL_SECONDS from the request', async () => {
    const email = await createClient();
    const token = await requestToken(email);
    const row = await pool().query<{ seconds: number }>(
      `SELECT extract(epoch FROM (expires_at - created_at))::int AS seconds FROM magic_link_tokens WHERE token_hash = $1`,
      [sha256(token)],
    );
    expect(row.rows[0]?.seconds).toBe(h.config.MAGIC_LINK_TTL_SECONDS);
    expect(h.config.MAGIC_LINK_TTL_SECONDS).toBeLessThanOrEqual(3600);
  });

  it('refuses a guessed, altered or malformed token, all with the same answer', async () => {
    const email = await createClient();
    const token = await requestToken(email);
    const altered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    const bodies: unknown[] = [];
    for (const attempt of [altered, 'A'.repeat(43), 'x'.repeat(100), `${token} `]) {
      const response = await h.client().post('/v1/auth/magic-link/verify', { token: attempt });
      expect(response.status, attempt).toBe(401);
      bodies.push(response.body);
    }
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
    expect((await h.client().post('/v1/auth/magic-link/verify', { token: 'short' })).status).toBe(
      400,
    );
    expect((await h.client().post('/v1/auth/magic-link/verify', {})).status).toBe(400);
    // The real token still works after all those failures.
    expect((await h.client().post('/v1/auth/magic-link/verify', { token })).status).toBe(200);
  });

  it('voids the earlier link when another one is requested', async () => {
    const email = await createClient();
    const first = await requestToken(email);
    const second = await requestToken(email);
    expect(second).not.toBe(first);
    expect((await h.client().post('/v1/auth/magic-link/verify', { token: first })).status).toBe(
      401,
    );
    expect((await h.client().post('/v1/auth/magic-link/verify', { token: second })).status).toBe(
      200,
    );
  });

  it('refuses a valid link once the account is disabled', async () => {
    const email = await createClient();
    const token = await requestToken(email);
    await pool().query(`UPDATE users SET status = 'disabled' WHERE email = $1`, [email]);
    expect((await h.client().post('/v1/auth/magic-link/verify', { token })).status).toBe(401);
  });
});

describe('rate limits', () => {
  it('limits one address to 3 mails per window without telling the caller', async () => {
    const email = await createClient();
    const sent: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const response = await h.client().post('/v1/auth/magic-link/request', { email });
      expect(response.status).toBe(202);
      await settle();
      sent.push((await jobsFor(email)).length);
    }
    expect(sent).toEqual([1, 2, 3, 3, 3]);
  });

  it('limits one IP address to 10 requests per window with 429 and Retry-After', async () => {
    const client = h.client();
    const statuses: number[] = [];
    let last: { headers: Headers; body: unknown } | undefined;
    for (let i = 0; i < 12; i += 1) {
      const response = await client.post<{ code: string }>('/v1/auth/magic-link/request', {
        email: uniqueEmail('flood'),
      });
      statuses.push(response.status);
      last = response;
    }
    expect(statuses.slice(0, 10)).toEqual(Array<number>(10).fill(202));
    expect(statuses.slice(10)).toEqual([429, 429]);
    expect(Number(last?.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(last?.body).toMatchObject({ code: 'rate_limited' });
    const audit = await pool().query(
      `SELECT 1 FROM audit_log WHERE action = 'auth.magic_link.rate_limited'`,
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(2);
  });

  it('limits guesses at the verify endpoint per IP address', async () => {
    const client = h.client();
    const statuses: number[] = [];
    for (let i = 0; i < 22; i += 1) {
      statuses.push(
        (await client.post('/v1/auth/magic-link/verify', { token: 'g'.repeat(43) })).status,
      );
    }
    expect(statuses.slice(0, 20)).toEqual(Array<number>(20).fill(401));
    expect(statuses.slice(20)).toEqual([429, 429]);
  });
});

describe('audit trail', () => {
  it('records the request without the address, and the sign-in without the token', async () => {
    const email = await createClient();
    const token = await requestToken(email);
    const client = h.client();
    const login = await client.post<SessionInfo>('/v1/auth/magic-link/verify', { token });
    await h.client().post('/v1/auth/magic-link/verify', { token });

    const rows = await pool().query<{
      action: string;
      outcome: string;
      actor_id: string | null;
      actor_type: string;
      target_id: string | null;
    }>(
      `SELECT action, outcome, actor_id, actor_type, target_id FROM audit_log WHERE action LIKE 'auth.%magic_link%' OR action = 'auth.login.magic_link'`,
    );
    const byAction = (action: string) => rows.rows.filter((row) => row.action === action);

    expect(
      byAction('auth.magic_link.requested').some((row) => row.target_id === emailTag(email)),
    ).toBe(true);
    expect(byAction('auth.login.magic_link')).toContainEqual(
      expect.objectContaining({
        outcome: 'success',
        actor_type: 'user',
        actor_id: login.body.user.id,
      }),
    );
    expect(byAction('auth.magic_link.failed')).toContainEqual(
      expect.objectContaining({ outcome: 'failure', actor_type: 'anonymous' }),
    );

    const everything = await pool().query<{ dump: string }>(
      `SELECT string_agg(to_jsonb(a)::text, ' ') AS dump FROM audit_log a`,
    );
    expect(everything.rows[0]?.dump).not.toContain(token);
    expect(everything.rows[0]?.dump).not.toContain(email);
  });
});
