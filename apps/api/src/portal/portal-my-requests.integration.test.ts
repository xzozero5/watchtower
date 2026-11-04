import { randomBytes } from 'node:crypto';

import { seedIntents } from '@watchtower/db';
import {
  type EmailJob,
  type HumanChallenge,
  type PortalMyRequestsView,
  type PortalSubmitted,
  type PortalTicketView,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, uniqueEmail, type Harness, type TestClient } from '../testing/harness.js';
import { apiOrg, signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';
import { PortalMyRequestsService } from './portal-my-requests.service.js';
import { solveChallenge } from './pow.js';

// "Email me a link to my requests" (T-152) on the real application: Postgres, Redis, the outbox and
// the audit interceptor. The email is checked as the job the relay hands to BullMQ (the worker side
// is rendered in apps/worker). Difficulty 8 and no minimum fill time keep the proof instant.

type MyRequestsJob = Extract<EmailJob, { kind: 'portal_my_requests' }>;

let h: Harness;
let lead: Persona;
let agent: Persona;
const DOMAIN = 'mine-acme.example';
const pool = () => h.db.owner.pool;

beforeAll(async () => {
  h = await startHarness({
    env: { PORTAL_POW_DIFFICULTY_BITS: '8', PORTAL_MIN_FILL_SECONDS: '0' },
  });
  await seedIntents(h.db.owner.db);
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  await apiOrg(lead, { name: 'Mine Acme', domains: [DOMAIN] });
});

afterAll(async () => {
  await h.close();
});

async function proof(client: TestClient) {
  const response = await client.get<HumanChallenge>('/v1/portal/challenge');
  expect(response.status).toBe(200);
  return {
    provider: 'pow-sha256' as const,
    challenge: response.body.challenge,
    nonce: solveChallenge(response.body.challenge, response.body.difficultyBits),
  };
}

async function ask(client: TestClient, email: string, extra: Record<string, unknown> = {}) {
  return client.post<{ status?: string } & ApiErrorBody>('/v1/portal/my-requests', {
    email,
    verification: await proof(client),
    ...extra,
  });
}

async function settle() {
  await h.app.get(PortalMyRequestsService).whenIdle();
}

async function jobsFor(to: string): Promise<MyRequestsJob[]> {
  await h.relayOutbox();
  const jobs = await h.emailQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
  return jobs
    .filter((job) => (job.data as { to?: string }).to === to)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((job) => h.openEmail(job))
    .filter((job): job is MyRequestsJob => job.kind === 'portal_my_requests');
}

function tokenOf(job: MyRequestsJob): string {
  const url = new URL(job.trackingUrl);
  expect(url.pathname).toBe('/portal/my-requests');
  expect(url.search).toBe('');
  const match = /^#token=(wtl1\.[A-Za-z0-9_-]{43})$/.exec(url.hash);
  expect(match, 'the token is in the fragment').not.toBeNull();
  return match?.[1] ?? '';
}

const asToken = (token: string) => ({ headers: { 'x-portal-token': token } });

function open(client: TestClient, token: string | undefined) {
  return client.post<PortalMyRequestsView & ApiErrorBody>(
    '/v1/portal/my-requests/open',
    undefined,
    token === undefined ? undefined : asToken(token),
  );
}

/** A contact (made by a portal submission) with its first ticket. */
async function customer(domain = DOMAIN) {
  const client = h.client();
  const email = uniqueEmail('mine', domain);
  const response = await client.post<PortalSubmitted>('/v1/portal/tickets', {
    email,
    name: 'Mine Customer',
    category: 'api_error',
    description: 'Webhook deliveries stopped.',
    verification: await proof(client),
  });
  expect(response.status).toBe(201);
  return { email, key: response.body.ticketKey, client };
}

async function counts() {
  const { rows } = await pool().query<{ contacts: number; users: number }>(
    `SELECT (SELECT count(*) FROM contact)::int AS contacts, (SELECT count(*) FROM users)::int AS users`,
  );
  return rows[0];
}

/** Asks for a link and returns its token (the contact must exist). */
async function linkFor(email: string): Promise<string> {
  const before = (await jobsFor(email)).length;
  expect((await ask(h.client(), email)).status).toBe(202);
  await settle();
  const jobs = await jobsFor(email);
  expect(jobs).toHaveLength(before + 1);
  return tokenOf(jobs.at(-1) as MyRequestsJob);
}

describe('POST /v1/portal/my-requests', () => {
  it('answers 202 with one body for a contact, a stranger and a malformed-but-valid address, and mails only the contact', async () => {
    const known = await customer();
    const stranger = uniqueEmail('nobody', DOMAIN);
    const before = await counts();

    const a = await ask(h.client(), known.email);
    const b = await ask(h.client(), stranger);
    const c = await ask(h.client(), uniqueEmail('x', 'unknown-domain.example'), { locale: 'th' });
    await settle();
    for (const response of [a, b, c]) {
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: 'accepted' });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.setCookies).toEqual([]);
    }
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));

    const jobs = await jobsFor(known.email);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: 'portal_my_requests', expiresInMinutes: 30 });
    tokenOf(jobs[0] as MyRequestsJob);
    expect(await jobsFor(stranger)).toHaveLength(0);
    // No account and no contact is created by asking.
    expect(await counts()).toEqual(before);
  });

  it('does the work after the answer, so a known and an unknown address take the same time', async () => {
    const known = await customer();
    const sample = async (email: string) => {
      const client = h.client();
      const verification = await proof(client);
      const started = performance.now();
      const response = await client.post('/v1/portal/my-requests', { email, verification });
      const took = performance.now() - started;
      expect(response.status).toBe(202);
      return took;
    };
    const known1: number[] = [];
    const unknown1: number[] = [];
    // The per-address limit silently drops the 4th+ request for the known one: that must not show either.
    for (let i = 0; i < 5; i += 1) {
      known1.push(await sample(known.email));
      unknown1.push(await sample(uniqueEmail('nobody', DOMAIN)));
    }
    await settle();
    const median = (values: number[]) => [...values].sort((x, y) => x - y)[2] ?? 0;
    expect(Math.abs(median(known1) - median(unknown1))).toBeLessThan(150);
  });

  it('limits per address silently: the fourth request in an hour is still 202 and sends nothing', async () => {
    const { email } = await customer();
    for (let i = 0; i < 3; i += 1) await linkFor(email);
    const fourth = await ask(h.client(), email);
    await settle();
    expect(fourth.status).toBe(202);
    expect(fourth.body).toEqual({ status: 'accepted' });
    expect(await jobsFor(email)).toHaveLength(3);
    const { rows } = await pool().query<{ metadata: { scope?: string } }>(
      `SELECT metadata FROM audit_log WHERE action = 'portal.rate_limited' AND metadata->>'flow' = 'my_requests'
         AND metadata->>'scope' = 'mine-email'`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('limits per domain silently and counts it in the audit log', async () => {
    const domain = `crowd-${randomBytes(3).toString('hex')}.example`;
    let last: Awaited<ReturnType<typeof ask>> | undefined;
    for (let i = 0; i < 61; i += 1) last = await ask(h.client(), uniqueEmail('p', domain));
    await settle();
    expect(last?.status).toBe(202);
    const { rows } = await pool().query(
      `SELECT 1 FROM audit_log WHERE action = 'portal.rate_limited' AND metadata->>'scope' = 'mine-domain'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('limits per client address with 429 and Retry-After (an IPv6 /64 counts as one client)', async () => {
    const client = h.client();
    let limited: Awaited<ReturnType<typeof ask>> | undefined;
    for (let i = 0; i < 11; i += 1) limited = await ask(client, uniqueEmail('ip', DOMAIN));
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('refuses a bad or reused proof with 400, and treats the honeypot as a silent 202 without an email', async () => {
    const known = await customer();
    const client = h.client();
    const bad = await client.post<ApiErrorBody>('/v1/portal/my-requests', {
      email: known.email,
      verification: { provider: 'pow-sha256', challenge: 'nope', nonce: '1' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('verification_failed');

    const used = await proof(client);
    const first = await client.post('/v1/portal/my-requests', {
      email: uniqueEmail('r', DOMAIN),
      verification: used,
    });
    expect(first.status).toBe(202);
    const replay = await client.post<ApiErrorBody>('/v1/portal/my-requests', {
      email: known.email,
      verification: used,
    });
    expect(replay.status).toBe(400);

    const trap = await ask(h.client(), known.email, { website: 'http://spam.example' });
    await settle();
    expect(trap.status).toBe(202);
    expect(trap.body).toEqual({ status: 'accepted' });
    expect(await jobsFor(known.email)).toHaveLength(0);

    const missing = await client.post('/v1/portal/my-requests', { email: known.email });
    expect(missing.status).toBe(400);
  });

  it('audits with a keyed tag only, never the address', async () => {
    const known = await customer();
    const token = await linkFor(known.email);
    expect((await open(h.client(), token)).status).toBe(200);
    const { rows } = await pool().query<{ action: string }>(
      `SELECT action FROM audit_log WHERE action LIKE 'portal.my_requests.%' ORDER BY created_at, id`,
    );
    expect(new Set(rows.map((row) => row.action))).toEqual(
      new Set([
        'portal.my_requests.request',
        'portal.my_requests.issued',
        'portal.my_requests.opened',
      ]),
    );
    const leaked = await pool().query(
      `SELECT 1 FROM audit_log WHERE target_id = $1 OR before::text LIKE $2 OR after::text LIKE $2 OR metadata::text LIKE $2`,
      [known.email, `%${known.email}%`],
    );
    expect(leaked.rowCount).toBe(0);
    // The database holds the hash of the token, not the token.
    const stored = await pool().query(`SELECT 1 FROM portal_list_link WHERE token_hash = $1`, [
      token,
    ]);
    expect(stored.rowCount).toBe(0);
  });
});

describe('POST /v1/portal/my-requests/open', () => {
  it('lists the requests of the contact, read-only, each open one with a working tracking token', async () => {
    const mine = await customer();
    // A second request of the same contact, one closed, and a colleague's request that must not show.
    const second = await mine.client.post<PortalSubmitted>('/v1/portal/tickets', {
      email: mine.email,
      name: 'Mine Customer',
      category: 'billing',
      description: 'Invoice question.',
      verification: await proof(mine.client),
    });
    expect(second.status).toBe(201);
    const closed = await customer();
    // Close one of the contact's own tickets: make it theirs through a second submission.
    const third = await closed.client.post<PortalSubmitted>('/v1/portal/tickets', {
      email: closed.email,
      name: 'Mine Customer',
      category: 'question',
      description: 'Done soon.',
      verification: await proof(closed.client),
    });
    await agent.client.post(`/v1/tickets/${third.body.ticketKey}/status`, { status: 'closed' });
    // An internal note that the list must never carry.
    await agent.client.post(`/v1/tickets/${mine.key}/notes`, { body: 'INTERNAL-NOTE-SECRET' });
    const colleague = await customer();

    const token = await linkFor(mine.email);
    const opened = await open(h.client(), token);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.headers.get('cache-control')).toBe('no-store');
    expect(opened.setCookies).toEqual([]);
    expect(opened.body.maskedEmail).toBe(`${mine.email.charAt(0)}***@${DOMAIN}`);
    const keys = opened.body.items.map((item) => item.key).sort();
    expect(keys).toEqual([mine.key, second.body.ticketKey].sort());
    expect(keys).not.toContain(colleague.key);
    expect(opened.body.truncated).toBe(false);
    for (const item of opened.body.items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          'createdAt',
          'key',
          'status',
          'statusLabel',
          'subject',
          'trackingToken',
          'updatedAt',
        ].sort(),
      );
      expect(item.trackingToken).toMatch(/^wtp1\./);
      const page = await h
        .client()
        .get<PortalTicketView>(`/v1/portal/tickets/${item.key}`, asToken(item.trackingToken ?? ''));
      expect(page.status).toBe(200);
    }
    expect(JSON.stringify(opened.body)).not.toContain('INTERNAL-NOTE-SECRET');

    // The closed contact: listed without a token (closing revoked its links on purpose).
    const closedToken = await linkFor(closed.email);
    const closedList = await open(h.client(), closedToken);
    const closedItem = closedList.body.items.find((item) => item.key === third.body.ticketKey);
    expect(closedItem).toMatchObject({ status: 'closed', trackingToken: null });
  });

  it('works once: the second use, a forged, a missing and a malformed token all answer the same 401', async () => {
    const { email } = await customer();
    const token = await linkFor(email);
    expect((await open(h.client(), token)).status).toBe(200);
    const again = await open(h.client(), token);
    const forged = await open(h.client(), `wtl1.${randomBytes(32).toString('base64url')}`);
    const missing = await open(h.client(), undefined);
    const junk = await open(h.client(), 'x'.repeat(600));
    for (const response of [again, forged, missing, junk]) {
      expect(response.status).toBe(401);
      expect(response.body.code).toBe('invalid_or_expired_link');
    }
    expect(JSON.stringify(again.body)).toBe(JSON.stringify(forged.body));
    expect(JSON.stringify(again.body)).toBe(JSON.stringify(missing.body));
    // A tracking token of a ticket does not open the list, and the list link opens no ticket.
    const mine = await customer();
    const mineToken = await linkFor(mine.email);
    const list = await open(h.client(), mineToken);
    const ticketToken = list.body.items[0]?.trackingToken ?? '';
    expect((await open(h.client(), ticketToken)).status).toBe(401);
    const asTicket = await h.client().get(`/v1/portal/tickets/${mine.key}`, asToken(mineToken));
    expect(asTicket.status).toBe(401);
  });

  it('stops working after 30 minutes, and when a newer link was asked for', async () => {
    const { email } = await customer();
    const old = await linkFor(email);
    const newer = await linkFor(email);
    expect((await open(h.client(), old)).status).toBe(401);
    expect((await open(h.client(), newer)).status).toBe(200);

    const late = await linkFor(email);
    await pool().query(
      `UPDATE portal_list_link
          SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'
        WHERE consumed_at IS NULL`,
    );
    expect((await open(h.client(), late)).status).toBe(401);

    // The lifetime is 30 minutes from the request.
    const fresh = await customer();
    await linkFor(fresh.email);
    const { rows } = await pool().query<{ minutes: number }>(
      `SELECT (extract(epoch FROM l.expires_at - l.created_at) / 60)::float8 AS minutes
         FROM portal_list_link l JOIN contact c ON c.id = l.contact_id WHERE $1 = ANY (c.emails)`,
      [fresh.email],
    );
    expect(rows[0]?.minutes).toBeGreaterThan(29.9);
    expect(rows[0]?.minutes).toBeLessThan(30.1);
  });

  it('is bound to the address: a contact that no longer owns it gets nothing', async () => {
    const { email } = await customer();
    const token = await linkFor(email);
    await pool().query(`UPDATE contact SET emails = ARRAY[$2]::text[] WHERE $1 = ANY (emails)`, [
      email,
      uniqueEmail('moved', DOMAIN),
    ]);
    expect((await open(h.client(), token)).status).toBe(401);
  });

  it('spends the link at most once under concurrent use', async () => {
    const { email } = await customer();
    const token = await linkFor(email);
    const results = await Promise.all(Array.from({ length: 6 }, () => open(h.client(), token)));
    expect(results.filter((response) => response.status === 200)).toHaveLength(1);
    expect(results.filter((response) => response.status === 401)).toHaveLength(5);
  });

  it('limits attempts per client address with 429', async () => {
    const client = h.client();
    let last: Awaited<ReturnType<typeof open>> | undefined;
    for (let i = 0; i < 31; i += 1) last = await open(client, 'wtl1.nope');
    expect(last?.status).toBe(429);
  });
});
