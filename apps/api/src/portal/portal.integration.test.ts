import { createHash, randomBytes } from 'node:crypto';

import { seedIntents } from '@watchtower/db';
import {
  emailJobSchema,
  type EmailJob,
  type HumanChallenge,
  type PortalReplyResult,
  type PortalSubmitted,
  type PortalTicketView,
  type TicketDetail,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, uniqueEmail, type Harness, type TestClient } from '../testing/harness.js';
import { captureLogs } from '../testing/support.js';
import {
  apiOrg,
  apiPolicy,
  fileTicket,
  signIn,
  timelineOf,
  type ApiErrorBody,
  type Persona,
} from '../testing/ticketing.js';
import { solveChallenge } from './pow.js';
import { PortalTrackingService } from './portal-tracking.service.js';
import { UNMATCHED_ORG_ID } from './portal-submission.service.js';

// The portal channel on the real application: Postgres, Redis and BullMQ from docker compose, the
// restricted application role, the real audit interceptor. The worker side (render and SMTP into
// Mailpit) is covered in apps/worker; here the email is checked as the outbox row and the job the
// relay hands to BullMQ. Difficulty 8 and no minimum fill time keep the proof-of-work instant.

type JobOf<K extends EmailJob['kind']> = Extract<EmailJob, { kind: K }>;

let h: Harness;
const logs = captureLogs();
let head: Persona;
let lead: Persona;
let agent: Persona;
let orgA: string;
let orgB: string;
const DOMAIN_A = 'portal-acme.example';
const DOMAIN_B = 'portal-beta.example';

const pool = () => h.db.owner.pool;

beforeAll(async () => {
  h = await startHarness({
    logs,
    env: { LOG_LEVEL: 'debug', PORTAL_POW_DIFFICULTY_BITS: '8', PORTAL_MIN_FILL_SECONDS: '0' },
  });
  await seedIntents(h.db.owner.db);
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent', undefined, 'Somchai Jaidee');
  const policy = await apiPolicy(head, {
    name: `Portal always on ${randomBytes(3).toString('hex')}`,
    targets: {
      P1: { first_response_min: 15, resolution_min: 240, calendar: '24x7' },
      P2: { first_response_min: 60, resolution_min: 480, calendar: '24x7' },
      P3: { first_response_min: 120, resolution_min: 960, calendar: '24x7' },
    },
  });
  const created = await lead.client.post<{ id: string }>('/v1/orgs', {
    name: 'Portal Acme',
    domains: [DOMAIN_A],
    slaPolicyId: policy.id,
  });
  expect(created.status).toBe(201);
  orgA = created.body.id;
  orgB = (await apiOrg(lead, { name: 'Portal Beta', domains: [DOMAIN_B] })).id;
});

afterAll(async () => {
  await h.close();
});

// --- helpers ---

async function proof(client: TestClient, harness: Harness = h) {
  const response = await client.get<HumanChallenge>('/v1/portal/challenge');
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(harness.config.PORTAL_POW_DIFFICULTY_BITS).toBe(response.body.difficultyBits);
  return {
    provider: 'pow-sha256' as const,
    challenge: response.body.challenge,
    nonce: solveChallenge(response.body.challenge, response.body.difficultyBits),
  };
}

interface FormFields {
  email?: string;
  name?: string;
  category?: string;
  description?: string;
  [key: string]: unknown;
}

async function form(client: TestClient, fields: FormFields = {}, harness: Harness = h) {
  return {
    email: uniqueEmail('customer', DOMAIN_A),
    name: 'Nok Customer',
    category: 'api_error',
    description: 'Webhook deliveries stopped at 09:00.',
    verification: await proof(client, harness),
    ...fields,
  };
}

async function submit(client: TestClient, fields: FormFields = {}, harness: Harness = h) {
  return client.post<PortalSubmitted & ApiErrorBody>(
    '/v1/portal/tickets',
    await form(client, fields, harness),
  );
}

/** Email jobs for an address, oldest first, after the relay moved the outbox rows to BullMQ. */
async function jobsFor(to: string, harness: Harness = h): Promise<EmailJob[]> {
  await harness.relayOutbox();
  const jobs = await harness.emailQueue.getJobs([
    'waiting',
    'delayed',
    'active',
    'completed',
    'failed',
  ]);
  return jobs
    .filter((job) => (job.data as { to?: string }).to === to)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((job) => emailJobSchema.parse(job.data));
}

function tokenOf(url: string): string {
  const parsed = new URL(url);
  expect(parsed.search).toBe('');
  const match = /^#token=(wtp1\.[A-Za-z0-9._-]+)$/.exec(parsed.hash);
  expect(match, 'the token is in the fragment').not.toBeNull();
  return match?.[1] ?? '';
}

function lastTokenOf(jobs: readonly EmailJob[]): string {
  const job = jobs.at(-1);
  if (!job || !('trackingUrl' in job)) throw new Error('no portal email');
  return tokenOf(job.trackingUrl);
}

const asToken = (token: string) => ({ headers: { 'x-portal-token': token } });

async function view(client: TestClient, key: string, token: string) {
  return client.get<PortalTicketView & ApiErrorBody>(`/v1/portal/tickets/${key}`, asToken(token));
}

/** A fresh portal ticket and the token from its confirmation email. */
async function portalTicket(
  fields: FormFields = {},
): Promise<{ key: string; email: string; token: string; client: TestClient }> {
  const client = h.client();
  const email = fields.email ?? uniqueEmail('customer', DOMAIN_A);
  const response = await submit(client, { ...fields, email });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const jobs = await jobsFor(email);
  return { key: response.body.ticketKey, email, token: lastTokenOf(jobs), client };
}

const numberOf = (key: string) => Number(key.split('-')[1]);

async function ticketRow(key: string) {
  const { rows } = await pool().query<{
    id: string;
    org_id: string;
    channel: string;
    status: string;
    priority: string;
    intent_key: string | null;
    first_response_due_at: Date | null;
    custom_fields: { portal?: Record<string, unknown> };
    reopen_count: number;
    requester_contact_id: string;
  }>(
    `SELECT t.id, t.org_id, t.channel, t.status, t.priority, i.key AS intent_key,
            t.first_response_due_at, t.custom_fields, t.reopen_count, t.requester_contact_id
     FROM ticket t LEFT JOIN intent i ON i.id = t.intent_id WHERE t.number = $1`,
    [numberOf(key)],
  );
  const row = rows[0];
  if (!row) throw new Error(`no ticket ${key}`);
  return row;
}

async function auditActions(targetId: string): Promise<string[]> {
  const { rows } = await pool().query<{ action: string }>(
    'SELECT action FROM audit_log WHERE target_id = $1 ORDER BY created_at, id',
    [targetId],
  );
  return rows.map((row) => row.action);
}

// --- challenge ---

describe('GET /v1/portal/challenge', () => {
  it('is public, signed, and answers with the privacy headers of the portal', async () => {
    const response = await h.client().get<HumanChallenge>('/v1/portal/challenge');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ provider: 'pow-sha256', difficultyBits: 8 });
    expect(response.body.challenge).toMatch(/^[A-Za-z0-9_-]{22}\.\d+\.\d+\.8\.[A-Za-z0-9_-]{43}$/);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.setCookies).toEqual([]);
  });

  it('allows the portal token header in a CORS preflight from the web app only', async () => {
    const ask = (origin: string) =>
      fetch(`${h.base}/v1/portal/tickets/OPS-1`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'x-portal-token',
        },
      });
    const allowed = await ask('http://localhost:3000');
    expect(allowed.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'x-portal-token',
    );
    const foreign = await ask('https://evil.example');
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
  });
});

// --- submit ---

describe('POST /v1/portal/tickets', () => {
  it('files a ticket for the organization that claimed the domain, with intent hint, priority and SLA', async () => {
    const client = h.client();
    const email = uniqueEmail('first', DOMAIN_A);
    const response = await submit(client, {
      email,
      name: 'Nok Customer',
      organization: 'Portal Acme Co.',
      category: 'api_error',
      urgency: 'something_broken',
      description: 'POST /v2/jobs returns 502.',
      affectedRequestIds: ['req_8a1f', 'sess:42'],
      locale: 'th',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({
      status: 'received',
      maskedEmail: `${email.charAt(0)}***@${DOMAIN_A}`,
    });
    expect(response.body.ticketKey).toMatch(/^OPS-\d+$/);
    expect(response.body.expectedFirstResponseAt).not.toBeNull();
    // The link goes to the mailbox only: nothing of it is in the response.
    expect(JSON.stringify(response.body)).not.toMatch(/wtp1|token/i);
    expect(response.setCookies).toEqual([]);

    const row = await ticketRow(response.body.ticketKey);
    expect(row).toMatchObject({
      org_id: orgA,
      channel: 'portal',
      status: 'new',
      priority: 'P2',
      intent_key: 'api_error',
    });
    expect(row.first_response_due_at?.toISOString()).toBe(response.body.expectedFirstResponseAt);
    expect(row.custom_fields.portal).toMatchObject({
      organization: 'Portal Acme Co.',
      organizationMatched: true,
      category: 'api_error',
      urgency: 'something_broken',
      affectedRequestIds: ['req_8a1f', 'sess:42'],
      locale: 'th',
    });
    const contact = await pool().query<{ org_id: string; emails: string[]; name: string }>(
      'SELECT org_id, emails, name FROM contact WHERE id = $1',
      [row.requester_contact_id],
    );
    expect(contact.rows[0]).toMatchObject({ org_id: orgA, emails: [email], name: 'Nok Customer' });
    const message = await pool().query<{
      body_text: string;
      direction: string;
      visibility: string;
    }>('SELECT body_text, direction, visibility FROM message WHERE ticket_id = $1', [row.id]);
    expect(message.rows).toHaveLength(1);
    expect(message.rows[0]?.direction).toBe('inbound');
    expect(message.rows[0]?.body_text).toContain('POST /v2/jobs returns 502.');
    expect(message.rows[0]?.body_text).toContain('- req_8a1f');

    // One confirmation, in the language of the form, with a working link.
    const jobs = await jobsFor(email);
    expect(jobs).toHaveLength(1);
    const confirmation = jobs[0] as JobOf<'portal_confirmation'>;
    expect(confirmation).toMatchObject({
      kind: 'portal_confirmation',
      locale: 'th',
      ticketKey: response.body.ticketKey,
      expectedFirstResponseAt: response.body.expectedFirstResponseAt,
    });
    expect(confirmation.trackingUrl.startsWith('http://localhost:3000/portal/tickets/')).toBe(true);
    const token = tokenOf(confirmation.trackingUrl);
    expect((await view(h.client(), response.body.ticketKey, token)).status).toBe(200);
  });

  it('writes anonymous audit rows for the contact, the ticket and the submission, without the address', async () => {
    const email = uniqueEmail('audited', DOMAIN_A);
    const response = await submit(h.client(), { email });
    const row = await ticketRow(response.body.ticketKey);
    // Rows of one transaction share a timestamp, so their order is not defined: compare sorted.
    expect((await auditActions(row.id)).sort()).toEqual(['portal.ticket.submit', 'ticket.create']);
    expect(await auditActions(row.requester_contact_id)).toEqual(['contact.create']);
    const { rows } = await pool().query<{ actor_type: string; actor_id: string | null; n: number }>(
      `SELECT actor_type, actor_id, count(*)::int AS n FROM audit_log
       WHERE target_id = ANY($1::text[]) GROUP BY actor_type, actor_id`,
      [[row.id, row.requester_contact_id]],
    );
    expect(rows).toEqual([{ actor_type: 'anonymous', actor_id: null, n: 3 }]);
    const leaked = await pool().query(
      `SELECT 1 FROM audit_log WHERE before::text LIKE $1 OR after::text LIKE $1 OR metadata::text LIKE $1`,
      [`%${email}%`],
    );
    expect(leaked.rowCount).toBe(0);
  });

  it('keeps the typed organization as free text for triage when no domain matches, and caps the priority', async () => {
    const email = uniqueEmail('stranger', `unknown-${randomBytes(4).toString('hex')}.example`);
    const response = await submit(h.client(), {
      email,
      organization: 'Some Company Ltd',
      category: 'outage',
      urgency: 'everything_down',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const row = await ticketRow(response.body.ticketKey);
    expect(row.org_id).toBe(UNMATCHED_ORG_ID);
    expect(row.custom_fields.portal).toMatchObject({
      organization: 'Some Company Ltd',
      organizationMatched: false,
    });
    expect(row.intent_key).toBe('incident_inquiry');
    // "Everything is down" asks for P1; an unplaced submitter gets at most P2 [ASSUMED].
    expect(row.priority).toBe('P2');
    expect(await jobsFor(email)).toHaveLength(1);
  });

  it('files a known contact under its own organization even when the domain is not allow-listed', async () => {
    const email = uniqueEmail('regular', 'gmail.com');
    const staffTicket = await fileTicket(agent, orgB, { requester: { email, name: 'Regular' } });
    const response = await submit(h.client(), { email });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect((await ticketRow(response.body.ticketKey)).org_id).toBe(orgB);
    expect(staffTicket.org.id).toBe(orgB);
  });

  it('files the ticket unclassified when the instance has no intent for the category', async () => {
    await pool().query(`UPDATE intent SET is_active = false WHERE key = 'billing_report'`);
    try {
      const response = await submit(h.client(), { category: 'billing' });
      expect(response.status).toBe(201);
      expect((await ticketRow(response.body.ticketKey)).intent_key).toBeNull();
    } finally {
      await pool().query(`UPDATE intent SET is_active = true WHERE key = 'billing_report'`);
    }
  });

  it('refuses unknown fields (no attachments yet), over-long text and bad request ids with 400', async () => {
    const client = h.client();
    for (const extra of [
      { attachments: [{ name: 'a.png' }] },
      { description: 'x'.repeat(10_001) },
      { affectedRequestIds: ['has space'] },
      { email: 'not-an-email' },
      { category: 'made-up' },
      { urgency: 'whenever' },
    ]) {
      const response = await submit(client, extra);
      expect(response.status, JSON.stringify(extra).slice(0, 80)).toBe(400);
    }
    // A form that fails validation does not burn the challenge.
    const keep = await proof(client);
    const bad = await client.post('/v1/portal/tickets', {
      ...(await form(client)),
      email: 'nope',
      verification: keep,
    });
    expect(bad.status).toBe(400);
    const good = await client.post<PortalSubmitted>('/v1/portal/tickets', {
      ...(await form(client)),
      verification: keep,
    });
    expect(good.status).toBe(201);
  });
});

// --- human verification ---

describe('human verification', () => {
  it('refuses a replayed proof-of-work and audits why', async () => {
    const client = h.client();
    const same = await proof(client);
    const first = await client.post<PortalSubmitted>('/v1/portal/tickets', {
      ...(await form(client)),
      verification: same,
    });
    expect(first.status).toBe(201);
    const second = await client.post<ApiErrorBody>('/v1/portal/tickets', {
      ...(await form(client)),
      verification: same,
    });
    expect(second.status).toBe(400);
    expect(second.body.code).toBe('verification_failed');
    const { rows } = await pool().query<{ outcome: string; metadata: { reason: string } }>(
      `SELECT outcome, metadata FROM audit_log WHERE action = 'portal.verification_failed' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows[0]?.outcome).toBe('denied');
    expect(rows[0]?.metadata.reason).toBe('replayed');
  });

  it('keeps the used challenge id in Redis for single use', async () => {
    const client = h.client();
    const solved = await proof(client);
    const id = solved.challenge.split('.')[0];
    const response = await client.post('/v1/portal/tickets', {
      ...(await form(client)),
      verification: solved,
    });
    expect(response.status).toBe(201);
    const { Redis } = await import('ioredis');
    const redis = new Redis(h.config.REDIS_URL);
    try {
      expect(await redis.ttl(`wt:portal:pow:${id ?? ''}`)).toBeGreaterThan(0);
    } finally {
      redis.disconnect();
    }
  });

  it('refuses a missing, wrong, forged or filled-honeypot submission with the same 400', async () => {
    const client = h.client();
    const valid = await proof(client);
    const cases: Record<string, Record<string, unknown>> = {
      'wrong nonce': { verification: { ...valid, nonce: '99999999999' } },
      'forged challenge': {
        verification: {
          ...valid,
          challenge: `${randomBytes(16).toString('base64url')}.9999999999.1.1.${randomBytes(32).toString('base64url')}`,
        },
      },
      honeypot: { website: 'https://spam.example', verification: await proof(client) },
    };
    for (const [name, body] of Object.entries(cases)) {
      const response = await client.post<ApiErrorBody>('/v1/portal/tickets', {
        ...(await form(client)),
        ...body,
      });
      expect(response.status, name).toBe(400);
      expect(response.body.code, name).toBe('verification_failed');
    }
    const reasons = await pool().query<{ reason: string }>(
      `SELECT metadata->>'reason' AS reason FROM audit_log WHERE action = 'portal.verification_failed'`,
    );
    expect(reasons.rows.map((r) => r.reason)).toEqual(
      expect.arrayContaining(['honeypot', 'bad_signature']),
    );
  });
});

// --- tracking ---

describe('GET /v1/portal/tickets/:key', () => {
  it('shows the public side in customer words, never internal notes, AI or system events', async () => {
    const { key, token, client } = await portalTicket({ description: 'The reports are empty.' });
    // Staff work the ticket: internal note, assignment, a status move that reads the same.
    await agent.client.post(`/v1/tickets/${key}/notes`, {
      body: 'INTERNAL: customer is on a trial',
    });
    await agent.client.post(`/v1/tickets/${key}/assign`, { assigneeId: agent.userId });
    await agent.client.post(`/v1/tickets/${key}/status`, { status: 'triage' });
    await agent.client.post(`/v1/tickets/${key}/status`, { status: 'open' });
    const reply = await agent.client.post(`/v1/tickets/${key}/replies`, {
      body: 'We are looking at the reports job.',
    });
    expect(reply.status).toBe(201);

    const response = await view(client, key, token);
    expect(response.status).toBe(200);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.body).toMatchObject({
      key,
      status: 'in_progress',
      statusLabel: 'In progress',
      mergedIntoKey: null,
      canReply: true,
    });
    expect(response.body.maskedEmail).toMatch(/^.\*\*\*@portal-acme\.example$/);
    const kinds = response.body.timeline.map((entry) =>
      entry.kind === 'message' ? `${entry.from}:${entry.authorName ?? '-'}` : entry.status,
    );
    // received; the customer's own message; In progress (triage and open read the same: once);
    // the team's reply with the agent's first name.
    expect(kinds).toEqual(['received', 'customer:-', 'in_progress', 'support:Somchai']);
    const text = JSON.stringify(response.body);
    for (const secret of ['INTERNAL', 'Jaidee', agent.email, agent.userId, 'assigned', 'sla.']) {
      expect(text, secret).not.toContain(secret);
    }
    // After the first answer the SLA target is no longer "expected".
    expect(response.body.expectedFirstResponseAt).toBeNull();
  });

  it('gives one 401 for no token, a wrong token, an unknown ticket, and a token of another ticket', async () => {
    const a = await portalTicket();
    const b = await portalTicket({ email: uniqueEmail('other', DOMAIN_B) });
    const stranger = h.client();
    const attempts = await Promise.all([
      stranger.get<ApiErrorBody>(`/v1/portal/tickets/${a.key}`),
      view(stranger, a.key, `wtp1.${'0'.repeat(32)}.zzzzzz.${'A'.repeat(22)}.${'B'.repeat(43)}`),
      view(stranger, 'OPS-999999', a.token),
      view(stranger, 'NOPE-1', a.token),
      view(stranger, 'not a key', a.token),
      view(stranger, a.key, b.token),
      view(stranger, b.key, a.token),
    ]);
    const reference = attempts[0];
    const quiet = (headers: Headers) =>
      [...headers.keys()].filter((name) => name !== 'x-request-id' && name !== 'date');
    for (const attempt of attempts) {
      expect(attempt.status).toBe(401);
      expect(attempt.body).toEqual(reference.body);
      expect(attempt.body.code).toBe('invalid_or_expired_link');
      expect(quiet(attempt.headers)).toEqual(quiet(reference.headers));
    }
    // The right token still opens its own ticket, and the other organization's customer sees only theirs.
    expect((await view(stranger, a.key, a.token)).status).toBe(200);
    expect((await view(stranger, b.key, b.token)).body.key).toBe(b.key);
    expect((await view(stranger, b.key, b.token)).body.timeline.length).toBeLessThan(10);
  });

  it('does not let a signed-in staff session stand in for a token', async () => {
    const { key } = await portalTicket();
    const response = await agent.client.get<ApiErrorBody>(`/v1/portal/tickets/${key}`);
    expect(response.status).toBe(401);
  });

  it('refuses an expired token and a revoked one', async () => {
    const { key, token, client } = await portalTicket();
    expect((await view(client, key, token)).status).toBe(200);

    await pool().query(
      `UPDATE portal_access_token SET created_at = now() - interval '100 days',
         expires_at = now() - interval '1 day' WHERE ticket_id = (SELECT id FROM ticket WHERE number = $1)`,
      [numberOf(key)],
    );
    expect((await view(client, key, token)).status).toBe(401);

    const fresh = await portalTicket();
    expect((await view(fresh.client, fresh.key, fresh.token)).status).toBe(200);
    const revoke = await agent.client.post<{ revoked: number }>(
      `/v1/tickets/${fresh.key}/portal-links/revoke`,
    );
    expect(revoke.status).toBe(200);
    expect(revoke.body.revoked).toBeGreaterThanOrEqual(1);
    expect((await view(fresh.client, fresh.key, fresh.token)).status).toBe(401);
    const ticket = await ticketRow(fresh.key);
    expect(await auditActions(ticket.id)).toContain('portal.tracking_links.revoke');
  });

  it('stores only a hash of the token and never logs it or the address', async () => {
    const { key, token, email, client } = await portalTicket();
    await view(client, key, token);
    const stored = await pool().query(`SELECT 1 FROM portal_access_token WHERE token_hash = $1`, [
      createHash('sha256').update(token).digest('hex'),
    ]);
    expect(stored.rowCount).toBe(1);
    const anyToken = await pool().query(
      `SELECT 1 FROM portal_access_token WHERE token_hash LIKE 'wtp1%'`,
    );
    expect(anyToken.rowCount).toBe(0);
    expect(logs.raw()).not.toContain(token);
    expect(logs.raw()).not.toContain(email);
    expect(logs.raw()).not.toContain('wtp1.');
  });
});

// --- reply from the portal ---

describe('POST /v1/portal/tickets/:key/replies', () => {
  it('lands in the staff timeline as the customer, and in the portal timeline', async () => {
    const { key, token, client } = await portalTicket();
    const response = await client.post<PortalReplyResult>(
      `/v1/portal/tickets/${key}/replies`,
      { body: 'Here is the request id you asked for: req_77.' },
      asToken(token),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.message).toMatchObject({ from: 'customer', authorName: null });

    const staff = await timelineOf(agent, key);
    const entry = staff.entries.find((e) => e.kind === 'message' && e.bodyText.includes('req_77'));
    expect(entry).toMatchObject({ kind: 'message', direction: 'inbound', visibility: 'public' });
    expect(entry && entry.kind === 'message' ? entry.sender.type : null).toBe('contact');
    const seen = await view(client, key, token);
    expect(seen.body.timeline.at(-1)).toMatchObject({ kind: 'message', from: 'customer' });
  });

  it('restarts a ticket that waits on the customer and reopens one resolved in the last 7 days', async () => {
    const { key, token, client } = await portalTicket();
    await agent.client.post(`/v1/tickets/${key}/status`, { status: 'waiting_on_customer' });
    expect((await view(client, key, token)).body.status).toBe('waiting_for_you');
    await client.post(
      `/v1/portal/tickets/${key}/replies`,
      { body: 'Done, please retry.' },
      asToken(token),
    );
    expect((await view(client, key, token)).body.status).toBe('in_progress');

    await agent.client.post(`/v1/tickets/${key}/status`, { status: 'resolved' });
    const resolved = await view(client, key, token);
    expect(resolved.body).toMatchObject({ status: 'resolved', canReply: true });
    await client.post(
      `/v1/portal/tickets/${key}/replies`,
      { body: 'Still happening.' },
      asToken(token),
    );
    const reopened = await view(client, key, token);
    expect(reopened.body.status).toBe('in_progress');
    expect((await ticketRow(key)).reopen_count).toBe(1);
    const statuses = reopened.body.timeline.flatMap((e) => (e.kind === 'status' ? [e.status] : []));
    expect(statuses).toEqual([
      'received',
      'waiting_for_you',
      'in_progress',
      'resolved',
      'in_progress',
    ]);
  });

  it('is refused on a closed ticket and after the reopen window, and for a bad token', async () => {
    const closed = await portalTicket();
    await agent.client.post(`/v1/tickets/${closed.key}/status`, { status: 'closed' });
    const refused = await closed.client.post<ApiErrorBody>(
      `/v1/portal/tickets/${closed.key}/replies`,
      { body: 'Hello?' },
      asToken(closed.token),
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('ticket_not_open');
    expect((await view(closed.client, closed.key, closed.token)).body).toMatchObject({
      status: 'closed',
      canReply: false,
    });

    const old = await portalTicket();
    await agent.client.post(`/v1/tickets/${old.key}/status`, { status: 'resolved' });
    await pool().query(
      `UPDATE ticket SET resolved_at = now() - interval '9 days' WHERE number = $1`,
      [numberOf(old.key)],
    );
    expect((await view(old.client, old.key, old.token)).body.canReply).toBe(false);
    const late = await old.client.post<ApiErrorBody>(
      `/v1/portal/tickets/${old.key}/replies`,
      { body: 'Later.' },
      asToken(old.token),
    );
    expect(late.status).toBe(409);

    const noToken = await old.client.post<ApiErrorBody>(`/v1/portal/tickets/${old.key}/replies`, {
      body: 'No token',
    });
    expect(noToken.status).toBe(401);
    const empty = await closed.client.post(
      `/v1/portal/tickets/${closed.key}/replies`,
      { body: '   ' },
      asToken(closed.token),
    );
    expect(empty.status).toBe(400);
  });

  it('cannot answer another customer of the same organization', async () => {
    const a = await portalTicket();
    const b = await portalTicket({ email: uniqueEmail('colleague', DOMAIN_A) });
    const response = await a.client.post<ApiErrorBody>(
      `/v1/portal/tickets/${b.key}/replies`,
      { body: 'I should not be able to write here' },
      asToken(a.token),
    );
    expect(response.status).toBe(401);
    const staff = await timelineOf(agent, b.key);
    expect(JSON.stringify(staff.entries)).not.toContain('should not be able');
  });

  it('audits the reply as the contact, not as an account', async () => {
    const { key, token, client } = await portalTicket();
    await client.post(`/v1/portal/tickets/${key}/replies`, { body: 'Audit me' }, asToken(token));
    const ticket = await ticketRow(key);
    const { rows } = await pool().query<{ actor_type: string; actor_id: string }>(
      `SELECT actor_type, actor_id FROM audit_log WHERE action = 'ticket.reply' AND target_id = $1`,
      [ticket.id],
    );
    expect(rows).toEqual([{ actor_type: 'anonymous', actor_id: ticket.requester_contact_id }]);
  });
});

// --- emails to the customer ---

describe('customer emails', () => {
  it('sends one update per staff reply, with the agent first name and a link that works', async () => {
    const { key, email, client } = await portalTicket();
    const before = (await jobsFor(email)).length;
    const reply = await agent.client.post(`/v1/tickets/${key}/replies`, {
      body: 'Please try again.',
    });
    expect(reply.status).toBe(201);
    const jobs = await jobsFor(email);
    expect(jobs).toHaveLength(before + 1);
    const update = jobs.at(-1) as JobOf<'portal_update'>;
    expect(update).toMatchObject({
      kind: 'portal_update',
      reason: 'staff_reply',
      agentName: 'Somchai',
      ticketKey: key,
      locale: 'en',
    });
    expect(JSON.stringify(update)).not.toContain('Jaidee');
    expect((await view(client, key, tokenOf(update.trackingUrl))).status).toBe(200);
    // The outbox row is written with the reply; the relay marks it sent.
    const { rows } = await pool().query<{ status: string }>(
      `SELECT status FROM outbox WHERE job_id LIKE 'portal-reply-%' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows[0]?.status).toBe('sent');
  });

  it('does not email an internal note, a change between triage and open, or the customer own reply', async () => {
    const { key, email, token, client } = await portalTicket();
    // Leaving "Received" is visible to the customer and is emailed; what follows reads the same.
    await agent.client.post(`/v1/tickets/${key}/status`, { status: 'triage' });
    const before = (await jobsFor(email)).length;
    await agent.client.post(`/v1/tickets/${key}/notes`, { body: 'internal only' });
    await agent.client.post(`/v1/tickets/${key}/status`, { status: 'open' });
    await agent.client.post(`/v1/tickets/${key}/status`, { status: 'waiting_on_dev' });
    await client.post(`/v1/portal/tickets/${key}/replies`, { body: 'More detail' }, asToken(token));
    expect(await jobsFor(email)).toHaveLength(before);
  });

  it('emails a status change the customer can see, once, and a reply that also sets the status once', async () => {
    const { key, email } = await portalTicket();
    const before = (await jobsFor(email)).length;
    await agent.client.post(`/v1/tickets/${key}/status`, { status: 'waiting_on_customer' });
    let jobs = await jobsFor(email);
    expect(jobs).toHaveLength(before + 1);
    expect(jobs.at(-1)).toMatchObject({
      kind: 'portal_update',
      reason: 'status_change',
      status: 'waiting_for_you',
      agentName: null,
    });

    const both = await agent.client.post(`/v1/tickets/${key}/replies`, {
      body: 'Fixed on our side.',
      setStatus: 'resolved',
    });
    expect(both.status, JSON.stringify(both.body)).toBe(201);
    jobs = await jobsFor(email);
    expect(jobs).toHaveLength(before + 2);
    expect(jobs.at(-1)).toMatchObject({
      reason: 'staff_reply',
      status: 'resolved',
      agentName: 'Somchai',
    });
  });

  it('writes the email in the same transaction: a reply that fails sends nothing', async () => {
    const { key, email } = await portalTicket();
    await agent.client.post(`/v1/tickets/${key}/status`, { status: 'closed' });
    const before = (await jobsFor(email)).length;
    const refused = await agent.client.post(`/v1/tickets/${key}/replies`, { body: 'Too late' });
    expect(refused.status).toBe(409);
    expect(await jobsFor(email)).toHaveLength(before);
  });

  it('uses the contact preference for the language, English by default', async () => {
    const { key, email } = await portalTicket({ locale: 'th' });
    await pool().query(
      `UPDATE contact SET notification_prefs = '{"locale":"en"}'::jsonb WHERE emails @> ARRAY[$1]::text[]`,
      [email],
    );
    await agent.client.post(`/v1/tickets/${key}/replies`, { body: 'Hello' });
    const update = (await jobsFor(email)).at(-1);
    expect(update).toMatchObject({ kind: 'portal_update', locale: 'en' });
  });

  it('tells the customer of a merged ticket which ticket is primary (R-1.5) and shows it on the page', async () => {
    const primary = await portalTicket();
    const duplicate = await portalTicket({ email: uniqueEmail('duplicate', DOMAIN_A) });
    const before = (await jobsFor(duplicate.email)).length;
    const merged = await agent.client.post<{ source: TicketDetail }>(
      `/v1/tickets/${duplicate.key}/merge`,
      { intoTicketId: primary.key },
    );
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);

    const jobs = await jobsFor(duplicate.email);
    expect(jobs).toHaveLength(before + 1);
    const notice = jobs.at(-1) as JobOf<'portal_merged'>;
    expect(notice).toMatchObject({
      kind: 'portal_merged',
      ticketKey: duplicate.key,
      intoKey: primary.key,
    });
    // The primary's customer is not emailed about a merge.
    expect((await jobsFor(primary.email)).every((job) => job.kind !== 'portal_merged')).toBe(true);

    const page = await view(duplicate.client, duplicate.key, tokenOf(notice.trackingUrl));
    expect(page.body).toMatchObject({
      status: 'merged',
      statusLabel: 'Merged',
      mergedIntoKey: primary.key,
      canReply: false,
    });
    expect(page.body.timeline.at(-1)).toMatchObject({
      kind: 'status',
      status: 'merged',
      mergedIntoKey: primary.key,
    });
    const reply = await duplicate.client.post<ApiErrorBody>(
      `/v1/portal/tickets/${duplicate.key}/replies`,
      { body: 'Anyone?' },
      asToken(tokenOf(notice.trackingUrl)),
    );
    expect(reply.status).toBe(409);
    // The primary customer's page does not show the other customer's messages.
    const primaryPage = await view(primary.client, primary.key, primary.token);
    expect(JSON.stringify(primaryPage.body)).not.toContain(duplicate.email);
  });

  it('sends no portal email for a ticket that did not come through the portal channel', async () => {
    const email = uniqueEmail('gmail-customer', DOMAIN_A);
    const ticket = await fileTicket(agent, orgA, { requester: { email, name: 'By mail' } });
    await pool().query(`UPDATE ticket SET channel = 'gmail' WHERE id = $1`, [ticket.id]);
    await agent.client.post(`/v1/tickets/${ticket.key}/status`, { status: 'waiting_on_customer' });
    expect(await jobsFor(email)).toHaveLength(0);
  });
});

// --- new link ---

describe('POST /v1/portal/track/resend', () => {
  it('answers the same for every input and emails a new link only to the real requester', async () => {
    const { key, email, token, client } = await portalTicket();
    const before = (await jobsFor(email)).length;
    const unknown = h.client();
    const ask = (who: TestClient, body: { ticketKey: string; email: string }) =>
      who.post('/v1/portal/track/resend', body);
    const results = [
      await ask(client, { ticketKey: key, email }),
      await ask(unknown, { ticketKey: key, email: uniqueEmail('someone-else', DOMAIN_A) }),
      await ask(unknown, { ticketKey: 'OPS-999999', email }),
      await ask(unknown, { ticketKey: 'garbage', email }),
    ];
    await h.app.get(PortalTrackingService).whenIdle();
    for (const result of results) {
      expect(result.status).toBe(202);
      expect(result.body).toEqual({ status: 'accepted' });
      expect(result.headers.get('referrer-policy')).toBe('no-referrer');
    }
    const jobs = await jobsFor(email);
    expect(jobs).toHaveLength(before + 1);
    expect(jobs.at(-1)).toMatchObject({ kind: 'portal_link', ticketKey: key });
    const fresh = lastTokenOf(jobs);
    expect(fresh).not.toBe(token);
    expect((await view(client, key, fresh)).status).toBe(200);
    // The old link keeps working until it expires or staff revoke it.
    expect((await view(client, key, token)).status).toBe(200);
  });

  it('sends at most 3 emails per address per hour and still answers 202', async () => {
    const { key, email } = await portalTicket();
    const before = (await jobsFor(email)).length;
    for (let i = 0; i < 5; i += 1) {
      const response = await h.client().post('/v1/portal/track/resend', { ticketKey: key, email });
      expect(response.status).toBe(202);
    }
    await h.app.get(PortalTrackingService).whenIdle();
    expect((await jobsFor(email)).length - before).toBe(3);
  });
});

// --- rate limits ---

describe('rate limits', () => {
  let strict: Harness;

  beforeAll(async () => {
    strict = await startHarness({
      env: {
        PORTAL_POW_DIFFICULTY_BITS: '8',
        PORTAL_MIN_FILL_SECONDS: '0',
        PORTAL_RATE_IP_PER_HOUR: '4',
        PORTAL_RATE_EMAIL_PER_HOUR: '2',
        PORTAL_RATE_ORG_PER_HOUR: '5',
      },
    });
    const lead2 = await signIn(strict, 'lead');
    await apiOrg(lead2, { name: 'Strict Org', domains: ['strict-org.example'] });
  });

  afterAll(async () => {
    await strict.close();
  });

  const count = async (scope: string) => {
    const { rows } = await strict.db.owner.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log
       WHERE action = 'portal.rate_limited' AND outcome = 'denied' AND metadata->>'scope' = $1`,
      [scope],
    );
    return rows[0]?.n ?? 0;
  };

  it('answers 429 with Retry-After per email address, and audits it', async () => {
    const email = uniqueEmail('limited', 'strict-org.example');
    const client = strict.client();
    expect((await submit(client, { email }, strict)).status).toBe(201);
    expect((await submit(client, { email }, strict)).status).toBe(201);
    const third = await submit(client, { email }, strict);
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('rate_limited');
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(Number(third.headers.get('retry-after'))).toBeLessThanOrEqual(3600);
    expect(await count('submit-email')).toBe(1);
    const row = await strict.db.owner.pool.query<{ metadata: Record<string, unknown>; ip: string }>(
      `SELECT metadata, ip FROM audit_log WHERE action = 'portal.rate_limited' LIMIT 1`,
    );
    expect(JSON.stringify(row.rows[0]?.metadata)).not.toContain(email);
    expect(row.rows[0]?.ip).toBe(client.ip);
  });

  it('limits each IP address', async () => {
    // The counters live in Redis for an hour and outlive a test run: a domain of its own per run.
    const domain = `ip-${randomBytes(4).toString('hex')}.example`;
    const client = strict.client();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await submit(client, { email: uniqueEmail('ip', domain) }, strict)).status);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 429, 429]);
    expect(await count('submit-ip')).toBe(2);
  });

  it('limits each organization across addresses and IPs', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      statuses.push(
        (await submit(strict.client(), { email: uniqueEmail('org', 'strict-org.example') }, strict))
          .status,
      );
    }
    // Two of the five organization slots went to the first test.
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(3);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(2);
    expect(await count('submit-org')).toBeGreaterThanOrEqual(1);
  });

  it('limits reads per IP address as well', async () => {
    const reader = strict.client();
    const oneTicket = await submit(
      strict.client(),
      { email: uniqueEmail('r', `read-${randomBytes(4).toString('hex')}.example`) },
      strict,
    );
    expect(oneTicket.status).toBe(201);
    let last = 200;
    for (let i = 0; i < 245 && last !== 429; i += 1) {
      last = (await reader.get('/v1/portal/tickets/OPS-1', asToken('x'))).status;
    }
    expect(last).toBe(429);
  });
});

// --- slow submit ---

describe('minimum fill time', () => {
  let slow: Harness;

  beforeAll(async () => {
    slow = await startHarness({
      env: { PORTAL_POW_DIFFICULTY_BITS: '8', PORTAL_MIN_FILL_SECONDS: '2' },
    });
  });

  afterAll(async () => {
    await slow.close();
  });

  it('refuses a form sent right after the challenge, and accepts it two seconds later', async () => {
    const client = slow.client();
    const challenge = await proof(client, slow);
    const body = { ...(await form(client, {}, slow)), verification: challenge };
    const tooFast = await client.post<ApiErrorBody>('/v1/portal/tickets', body);
    expect(tooFast.status).toBe(400);
    expect(tooFast.body.code).toBe('verification_failed');
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const ok = await client.post<PortalSubmitted>('/v1/portal/tickets', body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });
});

// --- OpenAPI ---

describe('OpenAPI', () => {
  it('documents the portal endpoints, the token header and the 429', async () => {
    const response = await h.client().get<{
      paths: Record<string, Record<string, { parameters?: { name: string }[]; responses: object }>>;
    }>('/docs-json');
    expect(response.status).toBe(200);
    const paths = response.body.paths;
    for (const path of [
      '/v1/portal/challenge',
      '/v1/portal/tickets',
      '/v1/portal/tickets/{key}',
      '/v1/portal/tickets/{key}/replies',
      '/v1/portal/track/resend',
      '/v1/tickets/{id}/portal-links/revoke',
    ]) {
      expect(paths[path], path).toBeDefined();
    }
    const read = paths['/v1/portal/tickets/{key}']?.get;
    expect(read?.parameters?.map((p) => p.name)).toContain('x-portal-token');
    expect(Object.keys(paths['/v1/portal/tickets']?.post?.responses ?? {})).toEqual(
      expect.arrayContaining(['201', '400', '429']),
    );
  });
});
