import { randomUUID } from 'node:crypto';

import { schema, type Database } from '@watchtower/db';
import { mintCsatToken, type Domain } from '@watchtower/domain';
import {
  CSAT_TOKEN_HEADER,
  type CsatResponsesPage,
  type CsatSettings,
  type CsatSummary,
  type CsatSurveyView,
  type EmailJob,
} from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DATABASE } from '../database/database.module.js';
import { DOMAIN } from '../domain/domain.module.js';
import { startHarness, uniqueEmail, type Harness, type TestClient } from '../testing/harness.js';
import { captureLogs } from '../testing/support.js';
import { apiOrg, signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';

// The CSAT survey page and the staff results on the real application: Postgres, Redis, the restricted
// application role, the real audit interceptor. The scheduler is run directly (the worker owns its
// timer), and the email is read as the outbox row the relay hands to BullMQ (the worker renders it).

type SurveyEmail = Extract<EmailJob, { kind: 'csat_survey' }>;

let h: Harness;
const logs = captureLogs();
let domain: Domain;
let head: Persona;
let lead: Persona;
let agent: Persona;
let client: Persona;
let orgId: string;

const pool = () => h.db.owner.pool;
const asToken = (token: string) => ({ headers: { [CSAT_TOKEN_HEADER]: token } });

beforeAll(async () => {
  h = await startHarness({ logs, env: { LOG_LEVEL: 'debug' } });
  domain = h.app.get<Domain>(DOMAIN);
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  orgId = (await apiOrg(lead, { name: 'Csat Acme' })).id;
  client = await signIn(h, 'client', orgId);
});

afterAll(async () => {
  await h.close();
});

const database = () => h.app.get<Database>(DATABASE);

interface Survey {
  readonly ticketId: string;
  readonly surveyId: string;
  readonly email: string;
  readonly token: string;
}

/** A resolved ticket whose survey was sent: returns the link the customer got. */
async function sentSurvey(
  options: { orgId?: string; email?: string; channel?: string } = {},
): Promise<Survey> {
  const email = options.email ?? uniqueEmail('survey', 'customer.example');
  const ctx = domain.context({ actor: { type: 'user', id: null } });
  const { value } = await database().db.transaction((tx) =>
    domain.tickets.create(tx, ctx, {
      orgId: options.orgId ?? orgId,
      subject: 'Reports are empty',
      body: 'Nothing shows up.',
      requester: { email, name: 'Nok Customer' },
    }),
  );
  const ticketId = value.ticket.id;
  for (const status of ['open', 'resolved'] as const) {
    await database().db.transaction((tx) =>
      domain.tickets.changeStatus(tx, ctx, { ref: ticketId, status }),
    );
  }
  // Skip the one-hour wait; the scheduler decides everything else.
  await pool().query(
    `UPDATE csat_survey SET send_after = now() - interval '1 minute' WHERE ticket_id = $1`,
    [ticketId],
  );
  await domain.csat.sweep(database().db, ctx);
  const { rows } = await pool().query<{ id: string; status: string }>(
    `SELECT id, status FROM csat_survey WHERE ticket_id = $1`,
    [ticketId],
  );
  expect(rows[0]?.status).toBe('sent');
  const surveyId = rows[0]?.id ?? '';

  await h.relayOutbox();
  const jobs = await h.emailQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
  const job = jobs.find((j) => j.id === `csat-survey-${surveyId}`);
  if (!job) throw new Error('no survey email was queued');
  const opened = h.openEmail(job) as SurveyEmail;
  expect(opened).toMatchObject({ kind: 'csat_survey', to: email, reminder: false });
  const url = new URL(opened.surveyUrl);
  expect(url.search).toBe('');
  const match = /^#token=(wtc1\.[A-Za-z0-9._-]+)$/.exec(url.hash);
  expect(match, 'the token is in the fragment').not.toBeNull();
  return { ticketId, surveyId, email, token: match?.[1] ?? '' };
}

const answer = (who: TestClient, token: string, body: unknown) =>
  who.post<{ recorded?: boolean } & Partial<ApiErrorBody>>(
    '/v1/csat/responses',
    body,
    asToken(token),
  );
const view = (who: TestClient, token: string) =>
  who.get<CsatSurveyView & Partial<ApiErrorBody>>('/v1/csat/survey', asToken(token));

const ticketRow = async (id: string) => {
  const { rows } = await pool().query<{
    status: string;
    csat_score: number | null;
    reopen_count: number;
  }>(`SELECT status, csat_score, reopen_count FROM ticket WHERE id = $1`, [id]);
  return rows[0];
};
const surveyRow = async (id: string) => {
  const { rows } = await pool().query<{
    status: string;
    score: number | null;
    comment: string | null;
    resolved: boolean | null;
    reopened: boolean;
  }>(`SELECT status, score, comment, resolved, reopened FROM csat_survey WHERE id = $1`, [id]);
  return rows[0];
};
const auditCount = async (action: string) =>
  (
    await pool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = $1`,
      [action],
    )
  ).rows[0]?.n ?? 0;

describe('the survey page', () => {
  it('shows which request the link is about, with no-store and no-referrer headers', async () => {
    const s = await sentSurvey();
    const response = await view(h.client(), s.token);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ticketKey: expect.stringMatching(/^[A-Z]+-\d+$/) as string,
      locale: 'en',
    });
    expect(Date.parse(response.body.expiresAt)).toBeGreaterThan(Date.now());
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('records the answer once, copies the score to the ticket and audits it without the comment', async () => {
    const s = await sentSurvey();
    const response = await answer(h.client(), s.token, {
      score: 4,
      resolved: true,
      comment: 'Fast, thanks. My number is 0812345678',
    });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ recorded: true });
    expect(await surveyRow(s.surveyId)).toMatchObject({
      status: 'answered',
      score: 4,
      resolved: true,
      reopened: false,
    });
    expect(await ticketRow(s.ticketId)).toMatchObject({ status: 'resolved', csat_score: 4 });
    const { rows } = await pool().query<{
      actor_type: string;
      actor_id: string | null;
      metadata: unknown;
    }>(
      `SELECT actor_type, actor_id, metadata FROM audit_log WHERE action = 'csat.response' AND target_id = $1`,
      [s.surveyId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_type).toBe('anonymous');
    expect(rows[0]?.actor_id).not.toBeNull();
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain('0812345678');
  });

  it('a link works once: the second answer and a later look answer 409 and change nothing', async () => {
    const s = await sentSurvey();
    expect((await answer(h.client(), s.token, { score: 5 })).status).toBe(201);
    const again = await answer(h.client(), s.token, { score: 1, comment: 'changed my mind' });
    expect(again.status).toBe(409);
    expect(await surveyRow(s.surveyId)).toMatchObject({ score: 5, comment: null, reopened: false });
    expect(await ticketRow(s.ticketId)).toMatchObject({
      status: 'resolved',
      csat_score: 5,
      reopen_count: 0,
    });
    expect((await view(h.client(), s.token)).status).toBe(409);
  });

  it('a simultaneous double click records one answer', async () => {
    const s = await sentSurvey();
    const statuses = await Promise.all(
      [5, 5, 5].map(async () => (await answer(h.client(), s.token, { score: 5 })).status),
    );
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(2);
  });

  it.each([1, 2])(
    'a score of %i reopens the ticket, and the reply does not say so',
    async (score) => {
      const s = await sentSurvey();
      const response = await answer(h.client(), s.token, { score, comment: 'Not fixed' });
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ recorded: true });
      expect(await ticketRow(s.ticketId)).toMatchObject({
        status: 'open',
        reopen_count: 1,
        csat_score: score,
      });
      expect(await surveyRow(s.surveyId)).toMatchObject({ status: 'answered', reopened: true });
    },
  );

  it('"not resolved" reopens even with a good score; "resolved" and a score of 3 do not', async () => {
    const no = await sentSurvey();
    await answer(h.client(), no.token, { score: 5, resolved: false });
    expect((await ticketRow(no.ticketId))?.status).toBe('open');
    const three = await sentSurvey();
    await answer(h.client(), three.token, { score: 3, resolved: true });
    expect((await ticketRow(three.ticketId))?.status).toBe('resolved');
  });

  it('does not reopen a ticket resolved more than 7 days ago', async () => {
    const s = await sentSurvey();
    await pool().query(`UPDATE ticket SET resolved_at = now() - interval '8 days' WHERE id = $1`, [
      s.ticketId,
    ]);
    expect((await answer(h.client(), s.token, { score: 1 })).status).toBe(201);
    expect(await ticketRow(s.ticketId)).toMatchObject({ status: 'resolved', csat_score: 1 });
  });
});

describe('a link that does not work', () => {
  const key = () => deriveSubkey(h.config.APP_ENCRYPTION_KEY, KEY_LABELS.csatLink);
  const inAnHour = () => new Date(Date.now() + 3_600_000);

  it('answers every failure the same 401: missing, garbled, forged, expired, voided, unknown survey', async () => {
    const real = await sentSurvey();
    const expired = await sentSurvey();
    await pool().query(
      `UPDATE csat_survey SET token_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [expired.surveyId],
    );
    const voided = await sentSurvey();
    const ctx = domain.context({ actor: { type: 'user', id: null } });
    await database().db.transaction((tx) =>
      domain.tickets.changeStatus(tx, ctx, { ref: voided.ticketId, status: 'open' }),
    );
    expect((await surveyRow(voided.surveyId))?.status).toBe('voided');
    const unsent = mintCsatToken(key(), randomUUID(), inAnHour());
    const forged = mintCsatToken(
      deriveSubkey('x'.repeat(40), KEY_LABELS.csatLink),
      real.surveyId,
      inAnHour(),
    );
    const pastSignedExpiry = mintCsatToken(key(), real.surveyId, new Date(Date.now() - 1000));
    const tokens = [
      '',
      'not-a-token',
      `${real.token}x`,
      forged,
      pastSignedExpiry,
      unsent,
      expired.token,
      voided.token,
    ];

    const bodies = new Set<string>();
    for (const token of tokens) {
      const who = h.client();
      const get = await view(who, token);
      const post = await answer(who, token, { score: 5 });
      expect([get.status, post.status], token).toEqual([401, 401]);
      expect(get.body.code).toBe('invalid_or_expired_link');
      bodies.add(JSON.stringify(get.body));
      bodies.add(JSON.stringify(post.body));
    }
    // One message for every reason: nothing tells a caller which of these exist.
    expect(bodies.size).toBe(1);
    // None of that answered anything.
    expect((await surveyRow(real.surveyId))?.status).toBe('sent');
    expect((await surveyRow(expired.surveyId))?.status).not.toBe('answered');
    expect((await surveyRow(voided.surveyId))?.status).toBe('voided');
    expect(await auditCount('csat.access_denied')).toBeGreaterThanOrEqual(tokens.length);
  });

  it('does not accept the header as a query parameter or the token in the body', async () => {
    const s = await sentSurvey();
    const who = h.client();
    expect((await who.get(`/v1/csat/survey?token=${s.token}`)).status).toBe(401);
    expect((await who.post('/v1/csat/responses', { score: 5, token: s.token })).status).toBe(400);
    expect((await surveyRow(s.surveyId))?.status).toBe('sent');
  });

  it('rejects an invalid body before it looks at the link', async () => {
    const s = await sentSurvey();
    for (const body of [
      {},
      { score: 0 },
      { score: 6 },
      { score: 2.5 },
      { score: '5' },
      { score: 5, comment: 'x'.repeat(2001) },
      { score: 5, resolved: 'yes' },
      { score: 5, extra: true },
    ]) {
      expect((await answer(h.client(), s.token, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await surveyRow(s.surveyId))?.status).toBe('sent');
  });

  it('limits attempts per address (429 with Retry-After) and audits the refusal', async () => {
    const who = h.client();
    const statuses: number[] = [];
    for (let i = 0; i < 22; i += 1) {
      statuses.push((await answer(who, 'wtc1.guess', { score: 5 })).status);
    }
    expect(statuses.slice(0, 20).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
    const limited = await answer(who, 'wtc1.guess', { score: 5 });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await auditCount('csat.rate_limited')).toBeGreaterThanOrEqual(1);
    // Another address is not affected.
    expect((await answer(h.client(), 'wtc1.guess', { score: 5 })).status).toBe(401);
  });

  it('never writes a survey link to the log', async () => {
    const s = await sentSurvey();
    await view(h.client(), s.token);
    await answer(h.client(), s.token, { score: 5, comment: 'private words' });
    await answer(h.client(), s.token, { score: 5 });
    const raw = logs.raw();
    expect(raw).not.toContain(s.token);
    expect(raw).not.toContain(s.token.split('.')[2] ?? 'unreachable');
    expect(raw).not.toContain('private words');
  });
});

describe('results for staff (R-10.5)', () => {
  let rated: Survey;

  beforeAll(async () => {
    rated = await sentSurvey();
    await answer(h.client(), rated.token, { score: 2, resolved: false, comment: 'Still broken' });
  });

  it('is closed to anonymous callers, clients and agents; open to a lead with csat.read', async () => {
    for (const path of ['/v1/csat/responses', '/v1/csat/summary', '/v1/csat/settings']) {
      expect((await h.client().get(path)).status, path).toBe(401);
      expect((await client.client.get(path)).status, path).toBe(403);
      expect((await agent.client.get(path)).status, path).toBe(403);
      expect((await lead.client.get(path)).status, path).toBe(200);
    }
  });

  it('lists answers newest first with the facts metrics group by, and audits the read', async () => {
    const before = await auditCount('pii.read');
    const response = await lead.client.get<CsatResponsesPage>('/v1/csat/responses?limit=200');
    expect(response.status).toBe(200);
    const item = response.body.items.find((entry) => entry.ticketId === rated.ticketId);
    expect(item).toMatchObject({
      id: rated.surveyId,
      score: 2,
      resolved: false,
      comment: 'Still broken',
      reopened: true,
      aiHandled: false,
    });
    const times = response.body.items.map((entry) => Date.parse(entry.answeredAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(await auditCount('pii.read')).toBeGreaterThan(before);
  });

  it('pages and filters by maxScore', async () => {
    const first = await lead.client.get<CsatResponsesPage>('/v1/csat/responses?limit=1');
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await lead.client.get<CsatResponsesPage>(
      `/v1/csat/responses?limit=1&cursor=${first.body.nextCursor ?? ''}`,
    );
    expect(second.body.items[0]?.id).not.toBe(first.body.items[0]?.id);
    const unhappy = await lead.client.get<CsatResponsesPage>(
      '/v1/csat/responses?maxScore=2&limit=200',
    );
    expect(unhappy.body.items.length).toBeGreaterThan(0);
    expect(unhappy.body.items.every((entry) => entry.score <= 2)).toBe(true);
    expect((await lead.client.get('/v1/csat/responses?maxScore=9')).status).toBe(400);
    expect((await lead.client.get('/v1/csat/responses?cursor=garbage')).status).toBe(400);
  });

  it('summarises overall, by agent, by intent and AI-handled against human', async () => {
    const response = await lead.client.get<CsatSummary>('/v1/csat/summary');
    expect(response.status).toBe(200);
    const summary = response.body;
    const counted = Object.values(summary.distribution).reduce((a, b) => a + b, 0);
    expect(summary.responses).toBe(counted);
    expect(summary.responses).toBeGreaterThan(0);
    expect(summary.surveysSent).toBeGreaterThanOrEqual(summary.responses);
    expect(summary.responseRate).toBeGreaterThan(0);
    expect(summary.responseRate).toBeLessThanOrEqual(1);
    expect(summary.average).toBeGreaterThanOrEqual(1);
    expect(summary.average).toBeLessThanOrEqual(5);
    expect(summary.reopened).toBeGreaterThanOrEqual(1);
    expect(summary.human.count + summary.aiHandled.count).toBe(summary.responses);
    expect(summary.byAgent.reduce((n, row) => n + row.count, 0)).toBe(summary.responses);
    expect(summary.byIntent.reduce((n, row) => n + row.count, 0)).toBe(summary.responses);
    // A period with nothing in it is empty, not an error.
    const empty = await lead.client.get<CsatSummary>(
      '/v1/csat/summary?from=2001-01-01T00:00:00.000Z&to=2001-01-02T00:00:00.000Z',
    );
    expect(empty.body).toMatchObject({ responses: 0, average: null, responseRate: null });
  });

  it('only a head changes the settings, partially, and each change is audited', async () => {
    expect((await lead.client.put('/v1/csat/settings', { delayMinutes: 5 })).status).toBe(403);
    const set = await head.client.put<CsatSettings>('/v1/csat/settings', { delayMinutes: 5 });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({
      enabled: true,
      delayMinutes: 5,
      reminderHours: 48,
      cooldownDays: 7,
    });
    expect((await lead.client.get<CsatSettings>('/v1/csat/settings')).body).toEqual(set.body);
    expect(await auditCount('csat.setting_set')).toBe(1);

    // The new settings (T-174): on/off, the reminder wait (0 = none) and the per-contact quiet period.
    const more = await head.client.put<CsatSettings>('/v1/csat/settings', {
      enabled: false,
      reminderHours: 0,
      cooldownDays: 14,
    });
    expect(more.body).toEqual({
      enabled: false,
      delayMinutes: 5,
      reminderHours: 0,
      cooldownDays: 14,
    });
    expect(await auditCount('csat.setting_set')).toBe(2);

    const bads = [
      { delayMinutes: -1 },
      { delayMinutes: 10_081 },
      { delayMinutes: 1.5 },
      { reminderHours: 721 },
      { cooldownDays: 91 },
      { enabled: 'yes' },
      { unknown: 1 },
      {},
    ];
    for (const bad of bads) {
      expect((await head.client.put('/v1/csat/settings', bad)).status).toBe(400);
    }
    await head.client.put('/v1/csat/settings', {
      enabled: true,
      delayMinutes: 60,
      reminderHours: 48,
      cooldownDays: 7,
    });
  });

  it('opts an organization out, so its next resolve is skipped, and back in', async () => {
    const other = (await apiOrg(lead, { name: 'Csat Opt Out' })).id;
    expect((await agent.client.put(`/v1/csat/opt-outs/${other}`, { optedOut: true })).status).toBe(
      403,
    );
    const out = await lead.client.put<{ orgId: string; optedOut: boolean }>(
      `/v1/csat/opt-outs/${other}`,
      {
        optedOut: true,
      },
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ orgId: other, optedOut: true });
    expect(
      (await lead.client.put(`/v1/csat/opt-outs/${randomUUID()}`, { optedOut: true })).status,
    ).toBe(404);
    expect((await lead.client.put(`/v1/csat/opt-outs/not-a-uuid`, { optedOut: true })).status).toBe(
      400,
    );

    const ctx = domain.context({ actor: { type: 'user', id: null } });
    const { value } = await database().db.transaction((tx) =>
      domain.tickets.create(tx, ctx, {
        orgId: other,
        subject: 's',
        body: 'b',
        requester: { email: uniqueEmail('x', 'optout.example'), name: 'X' },
      }),
    );
    for (const status of ['open', 'resolved'] as const) {
      await database().db.transaction((tx) =>
        domain.tickets.changeStatus(tx, ctx, { ref: value.ticket.id, status }),
      );
    }
    const [row] = await database()
      .db.select()
      .from(schema.csatSurvey)
      .where(eq(schema.csatSurvey.ticketId, value.ticket.id));
    expect(row).toMatchObject({ status: 'skipped', reason: 'org_opt_out' });
    const back = await lead.client.put<{ optedOut: boolean }>(`/v1/csat/opt-outs/${other}`, {
      optedOut: false,
    });
    expect(back.body.optedOut).toBe(false);
    expect(await auditCount('csat.opt_out_set')).toBeGreaterThanOrEqual(2);
  });
});
