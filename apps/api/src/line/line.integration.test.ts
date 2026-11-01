import { randomBytes, randomUUID } from 'node:crypto';

import { line } from '@watchtower/channels';
import type { CredentialStore } from '@watchtower/db';
import { AUDIT_ACTIONS, INBOUND_QUEUES, INGEST_JOBS, type LineQuota } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CREDENTIAL_STORE } from '../credentials/credentials.service.js';
import { startHarness, uniqueEmail, type Harness } from '../testing/harness.js';
import { captureLogs } from '../testing/support.js';
import { clientOfNewOrg, signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';
import { LINE_LOGIN_PROVIDER } from './line-login.js';

// The LINE webhook, the link code and LINE Login on the real application: Postgres through the
// restricted application role, Redis for the rate limiter. The channel secret is generated here at
// runtime and goes through the credential store like a real one. disableNetConnect allows loopback
// only: nothing can reach LINE, and the fake Login provider never dials out (N1).
const net = disableNetConnect();
const logs = captureLogs();
const loginProvider = new line.FakeLineLoginProvider();
const channelSecret = randomBytes(24).toString('base64');

let h: Harness;
let agent: Persona;
let lineAccountId: string;
const pool = () => h.db.owner.pool;
let ipCounter = 0;
const freshIp = (): string => `198.51.100.${String(++ipCounter % 250)}`;

beforeAll(async () => {
  h = await startHarness({
    logs,
    // Debug, so that "nothing secret is logged" is a statement about the most talkative setting.
    env: { LOG_LEVEL: 'debug' },
    overrides: [{ token: LINE_LOGIN_PROVIDER, value: loginProvider }],
  });
  agent = await signIn(h, 'agent');
  const account = await pool().query<{ id: string }>(
    `INSERT INTO channel_account (type, name) VALUES ('line', 'Support LINE OA') RETURNING id`,
  );
  lineAccountId = account.rows[0]?.id ?? '';
});

afterAll(async () => {
  await h.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

function event(overrides: Record<string, unknown> = {}) {
  return {
    type: 'message',
    mode: 'active',
    timestamp: Date.now(),
    webhookEventId: `01${randomBytes(12).toString('hex').toUpperCase()}`,
    deliveryContext: { isRedelivery: false },
    source: { type: 'user', userId: `Ufake${randomBytes(12).toString('hex')}` },
    replyToken: randomBytes(16).toString('hex'),
    message: { type: 'text', id: randomBytes(6).toString('hex'), text: 'ระบบล่มครับ' },
    ...overrides,
  };
}

const sign = (raw: string, secret = channelSecret): string =>
  line.computeLineSignature(raw, secret);

interface WebhookOptions {
  readonly accountId?: string;
  readonly signature?: string | null;
  readonly ip?: string;
}

/** What LINE does: POST the exact bytes it signed. */
async function postWebhook(raw: string, options: WebhookOptions = {}) {
  const signature = options.signature === undefined ? sign(raw) : options.signature;
  const response = await fetch(`${h.base}/v1/inbound/line/${options.accountId ?? lineAccountId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': options.ip ?? freshIp(),
      ...(signature === null ? {} : { 'x-line-signature': signature }),
    },
    body: raw,
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

async function counts(): Promise<{ events: number; jobs: number }> {
  const events = await pool().query<{ count: string }>('SELECT count(*) FROM inbound_event');
  const jobs = await pool().query<{ count: string }>(
    `SELECT count(*) FROM outbox WHERE queue = $1`,
    [INBOUND_QUEUES.ingest],
  );
  return { events: Number(events.rows[0]?.count), jobs: Number(jobs.rows[0]?.count) };
}

async function putSecret(): Promise<void> {
  await h.app.get<CredentialStore>(CREDENTIAL_STORE).put('line', { channelSecret }, null);
}

describe('LINE webhook: before any secret is configured', () => {
  it('answers 401 and stores nothing, and says so in the log without the body', async () => {
    const raw = JSON.stringify({ destination: 'Ubot', events: [event()] });
    const before = await counts();
    const result = await postWebhook(raw);
    expect(result.status).toBe(401);
    expect(await counts()).toEqual(before);
    expect(logs.raw()).toContain('no channel secret is configured');
    expect(logs.raw()).not.toContain('ระบบล่มครับ');
  });
});

describe('LINE webhook (T-103b)', () => {
  beforeAll(putSecret);

  it('stores each event once with an ingest job in the same transaction, and answers 200', async () => {
    const first = event();
    const second = event({ message: { type: 'text', id: 'second', text: 'อีกข้อความ' } });
    const raw = JSON.stringify({ destination: 'Ubot', events: [first, second] });
    const before = await counts();
    const startedAt = Date.now();
    const result = await postWebhook(raw);
    // "Respond fast": nothing is processed in the request. The bound is generous; it catches a
    // request that waits for the worker, a provider or a model.
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(result).toEqual({ status: 200, body: { accepted: 2, duplicates: 0, rejected: 0 } });
    expect(await counts()).toEqual({ events: before.events + 2, jobs: before.jobs + 2 });

    const rows = await pool().query<{ id: string; provider_event_id: string; payload: unknown }>(
      `SELECT id, provider_event_id, payload FROM inbound_event WHERE provider_event_id = $1`,
      [first.webhookEventId],
    );
    expect(rows.rows).toHaveLength(1);
    const stored = rows.rows[0];
    expect(stored?.payload).toMatchObject({ webhookEventId: first.webhookEventId });
    const job = await pool().query<{ job_name: string; job_id: string; payload: unknown }>(
      `SELECT job_name, job_id, payload FROM outbox WHERE job_id = $1`,
      [stored?.id],
    );
    expect(job.rows[0]).toMatchObject({
      job_name: INGEST_JOBS.process,
      payload: { inboundEventId: stored?.id },
    });
  });

  it('ignores a redelivery of an event it already has, with the same 200', async () => {
    const original = event();
    const raw = JSON.stringify({ destination: 'Ubot', events: [original] });
    expect((await postWebhook(raw)).body).toMatchObject({ accepted: 1 });
    const before = await counts();
    // LINE redelivers when it did not hear back in time: same webhookEventId, flagged as a redelivery.
    const again = JSON.stringify({
      destination: 'Ubot',
      events: [{ ...original, deliveryContext: { isRedelivery: true } }],
    });
    expect(await postWebhook(again)).toEqual({
      status: 200,
      body: { accepted: 0, duplicates: 1, rejected: 0 },
    });
    expect(await counts()).toEqual(before);
  });

  it('accepts what the LINE console "Verify" button sends (no events)', async () => {
    const raw = JSON.stringify({ destination: 'Ubot', events: [] });
    expect(await postWebhook(raw)).toEqual({
      status: 200,
      body: { accepted: 0, duplicates: 0, rejected: 0 },
    });
  });

  it('counts an event that does not fit the schema without failing the others', async () => {
    const good = event();
    const raw = JSON.stringify({
      events: [{ type: 'message', timestamp: 'yesterday' }, good, { nothing: true }],
    });
    expect((await postWebhook(raw)).body).toEqual({ accepted: 1, duplicates: 0, rejected: 2 });
  });

  it('verifies the exact bytes received, not a re-serialisation of them', async () => {
    const original = event();
    // Valid JSON that no JSON.stringify would produce: extra spaces and a newline.
    const spaced = `{ "events" : [ ${JSON.stringify(original)} ]\n}`;
    expect((await postWebhook(spaced)).status).toBe(200);
    // A signature computed over the compact form does not cover the spaced bytes.
    const other = event();
    const compact = JSON.stringify({ events: [other] });
    const respaced = `{ "events" : [ ${JSON.stringify(other)} ]\n}`;
    const before = await counts();
    expect((await postWebhook(respaced, { signature: sign(compact) })).status).toBe(401);
    expect(await counts()).toEqual(before);
  });

  it.each([
    ['a signature made with another secret', (raw: string) => sign(raw, 'another-secret-entirely')],
    ['a signature over another body', () => sign('{"events":[]}')],
    ['a malformed signature', () => 'not-base64!!'],
    ['an empty signature', () => ''],
    ['no signature header', () => null],
  ])('refuses %s with 401 and writes nothing', async (_name, makeSignature) => {
    const raw = JSON.stringify({ events: [event()] });
    const before = await counts();
    const result = await postWebhook(raw, { signature: makeSignature(raw) });
    expect(result.status).toBe(401);
    expect(await counts()).toEqual(before);
  });

  it('gives an unknown or non-LINE account the same 401 as a wrong signature', async () => {
    const raw = JSON.stringify({ events: [event()] });
    const unknown = await postWebhook(raw, { accountId: randomUUID() });
    const gmail = await pool().query<{ id: string }>(
      `INSERT INTO channel_account (type, name) VALUES ('gmail', 'Mailbox') RETURNING id`,
    );
    const notLine = await postWebhook(raw, { accountId: gmail.rows[0]?.id ?? '' });
    const wrong = await postWebhook(raw, { signature: sign(raw, 'x') });
    expect([unknown.status, notLine.status, wrong.status]).toEqual([401, 401, 401]);
    expect(unknown.body).toEqual(wrong.body);
    expect(notLine.body).toEqual(wrong.body);
    expect((wrong.body as ApiErrorBody).message).not.toMatch(/account|secret/i);
  });

  it('answers 400 to a signed body that is not a webhook payload', async () => {
    expect((await postWebhook('not json at all')).status).toBe(400);
    expect((await postWebhook('{"hello":"world"}')).status).toBe(400);
    const tooMany = JSON.stringify({ events: Array.from({ length: 101 }, () => event()) });
    expect((await postWebhook(tooMany)).status).toBe(400);
  });

  it('throttles an address that keeps failing the signature, but never valid traffic', async () => {
    const ip = freshIp();
    const raw = JSON.stringify({ events: [] });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 32; attempt += 1) {
      statuses.push((await postWebhook(raw, { signature: sign(raw, 'bad'), ip })).status);
    }
    expect(statuses.slice(0, 30).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // The same address with a good signature still gets through: only failures count.
    expect((await postWebhook(raw, { ip })).status).toBe(200);
  });

  it('never logs the secret, a signature or a message body', async () => {
    const raw = JSON.stringify({
      events: [event({ message: { type: 'text', id: 'x', text: 'ข้อความลับ-ห้ามขึ้น-log' } })],
    });
    const badSignature = sign(raw, 'wrong');
    await postWebhook(raw, { signature: badSignature });
    await postWebhook(raw);
    const written = logs.raw();
    expect(written).not.toContain(channelSecret);
    expect(written).not.toContain(badSignature);
    expect(written).not.toContain(sign(raw));
    expect(written).not.toContain('ข้อความลับ-ห้ามขึ้น-log');
  });
});

describe('LINE webhook: the secret from the environment', () => {
  it('takes the channel secret from LINE_CHANNEL_SECRET before the database', async () => {
    const envSecret = randomBytes(24).toString('base64');
    const envHarness = await startHarness({ env: { LINE_CHANNEL_SECRET: envSecret } });
    try {
      const account = await envHarness.db.owner.pool.query<{ id: string }>(
        `INSERT INTO channel_account (type, name) VALUES ('line', 'OA') RETURNING id`,
      );
      const raw = JSON.stringify({ events: [event()] });
      const send = (secret: string) =>
        fetch(`${envHarness.base}/v1/inbound/line/${account.rows[0]?.id ?? ''}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-line-signature': line.computeLineSignature(raw, secret),
          },
          body: raw,
        });
      expect((await send(envSecret)).status).toBe(200);
      expect((await send(channelSecret)).status).toBe(401);
    } finally {
      await envHarness.close();
    }
  });
});

describe('LINE link code (T-103d)', () => {
  async function addContact(): Promise<{ id: string; orgId: string }> {
    const org = await pool().query<{ id: string }>(
      `INSERT INTO organization (name) VALUES ($1) RETURNING id`,
      [`Acme ${randomUUID()}`],
    );
    const orgId = org.rows[0]?.id ?? '';
    const contact = await pool().query<{ id: string }>(
      `INSERT INTO contact (org_id, name, emails) VALUES ($1, 'Somchai', $2) RETURNING id`,
      [orgId, [uniqueEmail('somchai', 'acme.example.test')]],
    );
    return { id: contact.rows[0]?.id ?? '', orgId };
  }

  it('lets staff generate a code, once, uncached, and keeps only a hash', async () => {
    const contact = await addContact();
    const response = await agent.client.post<{
      code: string;
      expiresAt: string;
      contactId: string;
    }>('/v1/line/link-codes', { contactId: contact.id });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.body.code).toMatch(/^WT-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(response.body.contactId).toBe(contact.id);
    expect(Date.parse(response.body.expiresAt) - Date.now()).toBeGreaterThan(14 * 60 * 1000);
    const stored = await pool().query(`SELECT * FROM line_link_code WHERE contact_id = $1`, [
      contact.id,
    ]);
    expect(JSON.stringify(stored.rows)).not.toContain(response.body.code);
    const audit = await pool().query<{ metadata: unknown }>(
      `SELECT metadata FROM audit_log WHERE action = $1 AND target_id = $2`,
      [AUDIT_ACTIONS.lineLinkCodeIssued, contact.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toContain(response.body.code);
  });

  it('refuses a client, an anonymous caller, an unknown contact and a bad body', async () => {
    const contact = await addContact();
    const { persona: client } = await clientOfNewOrg(h);
    expect(
      (await client.client.post('/v1/line/link-codes', { contactId: contact.id })).status,
    ).toBe(403);
    expect(
      (await h.client().post('/v1/line/link-codes', { contactId: contact.id }, { csrf: false }))
        .status,
    ).toBe(401);
    expect(
      (await agent.client.post('/v1/line/link-codes', { contactId: randomUUID() })).status,
    ).toBe(404);
    expect((await agent.client.post('/v1/line/link-codes', { contactId: 'nope' })).status).toBe(
      400,
    );
  });
});

describe('LINE Login with a fake IdP (T-103d)', () => {
  async function login(client: Persona) {
    const start = await client.client.post<{ authorizeUrl: string }>('/v1/line/login/start');
    expect(start.status).toBe(200);
    const url = new URL(start.body.authorizeUrl);
    // The fake's consent screen: never fetched.
    expect(url.hostname).toBe('login.line.fake.example.test');
    return { state: url.searchParams.get('state') ?? '' };
  }
  const callback = (client: Persona, code: string, state: string) =>
    client.client.get(
      `/v1/line/login/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    );
  const approve = (state: string, userId: string) =>
    loginProvider.consent(state, { userId, displayName: 'Somchai' });
  const newUserId = () => `Ufake${randomBytes(12).toString('hex')}`;

  it('links the LINE account of the signed-in client to their own contact and verifies it', async () => {
    const { orgId, persona } = await clientOfNewOrg(h, 'Somchai');
    const userId = newUserId();
    const { state } = await login(persona);
    const response = await callback(persona, approve(state, userId), state);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe('/portal');
    expect(location.searchParams.get('line_login')).toBe('linked');

    const contact = await pool().query<{
      line_user_id: string;
      verified_at: Date | null;
      org_id: string;
      emails: string[];
    }>(`SELECT line_user_id, verified_at, org_id, emails FROM contact WHERE line_user_id = $1`, [
      userId,
    ]);
    expect(contact.rows).toHaveLength(1);
    expect(contact.rows[0]).toMatchObject({ org_id: orgId });
    expect(contact.rows[0]?.emails).toEqual([persona.email.toLowerCase()]);
    expect(contact.rows[0]?.verified_at).not.toBeNull();
    const audit = await pool().query<{ metadata: unknown }>(
      `SELECT metadata FROM audit_log WHERE action = $1 AND actor_id = $2`,
      [AUDIT_ACTIONS.lineLinked, persona.userId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toContain(userId);
  });

  it('refuses a callback whose state belongs to another session, and a replayed code', async () => {
    const { persona: owner } = await clientOfNewOrg(h);
    const { persona: stranger } = await clientOfNewOrg(h);
    const { state } = await login(owner);
    const userId = newUserId();
    const code = approve(state, userId);
    // Login CSRF: the stranger is made to open the callback of somebody else's flow.
    const hijacked = await callback(stranger, code, state);
    expect(new URL(hijacked.headers.get('location') ?? '').searchParams.get('reason')).toBe(
      'state_invalid',
    );
    const linked = await pool().query(`SELECT 1 FROM contact WHERE line_user_id = $1`, [userId]);
    expect(linked.rows).toHaveLength(0);
    // The real owner finishes; the same code does not work again.
    expect(
      new URL((await callback(owner, code, state)).headers.get('location') ?? '').searchParams.get(
        'line_login',
      ),
    ).toBe('linked');
    const replay = await callback(owner, code, state);
    expect(new URL(replay.headers.get('location') ?? '').searchParams.get('reason')).toBe(
      'exchange_failed',
    );
  });

  it('refuses a forged state, a denied consent and a LINE account that belongs to someone verified', async () => {
    const { persona } = await clientOfNewOrg(h);
    const forged = await callback(persona, 'whatever', 'not.a.signed.state');
    expect(new URL(forged.headers.get('location') ?? '').searchParams.get('reason')).toBe(
      'state_invalid',
    );

    const { state } = await login(persona);
    const denied = await persona.client.get(
      `/v1/line/login/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );
    expect(new URL(denied.headers.get('location') ?? '').searchParams.get('reason')).toBe('denied');

    const taken = newUserId();
    const { persona: first } = await clientOfNewOrg(h);
    const one = await login(first);
    await callback(first, approve(one.state, taken), one.state);
    const second = await login(persona);
    const result = await callback(persona, approve(second.state, taken), second.state);
    expect(new URL(result.headers.get('location') ?? '').searchParams.get('reason')).toBe(
      'already_linked',
    );
  });

  it('is for clients: staff and anonymous callers get 403 and 401', async () => {
    expect((await agent.client.post('/v1/line/login/start')).status).toBe(403);
    expect((await h.client().post('/v1/line/login/start', undefined, { csrf: false })).status).toBe(
      401,
    );
  });
});

describe('LINE Login without a provider', () => {
  it('answers 503 instead of pretending (no live provider is implemented)', async () => {
    const off = await startHarness({ overrides: [{ token: LINE_LOGIN_PROVIDER, value: null }] });
    try {
      const { persona } = await clientOfNewOrg(off);
      const response = await persona.client.post<ApiErrorBody>('/v1/line/login/start');
      expect(response.status).toBe(503);
    } finally {
      await off.close();
    }
  });
});

describe('LINE quota (R-2.10)', () => {
  it('shows used and remaining push messages per account, with the 80% warning', async () => {
    const period = line.quotaPeriod(new Date());
    const insert = async (name: string, used: number, limit: number | null): Promise<string> => {
      const account = await pool().query<{ id: string }>(
        `INSERT INTO channel_account (type, name) VALUES ('line', $1) RETURNING id`,
        [name],
      );
      const id = account.rows[0]?.id ?? '';
      if (used >= 0) {
        await pool().query(
          `INSERT INTO channel_quota_usage (channel_account_id, period, used, quota_limit) VALUES ($1, $2, $3, $4)`,
          [id, period, used, limit],
        );
      }
      return id;
    };
    const fresh = await insert('Fresh OA', -1, null);
    const warn = await insert('Warn OA', 240, 300);
    const full = await insert('Full OA', 300, 300);
    const unknown = await insert('Unknown OA', 5, null);

    const response = await agent.client.get<LineQuota>('/v1/line/quota');
    expect(response.status).toBe(200);
    const of = (id: string) =>
      response.body.accounts.find((account) => account.channelAccountId === id);
    expect(of(fresh)).toMatchObject({ used: 0, limit: 300, remaining: 300, level: 'ok', period });
    expect(of(warn)).toMatchObject({ used: 240, limit: 300, remaining: 60, level: 'warn' });
    expect(of(full)).toMatchObject({ used: 300, remaining: 0, level: 'exhausted' });
    expect(of(unknown)).toMatchObject({ used: 5, limit: null, level: 'unknown' });

    const { persona: client } = await clientOfNewOrg(h);
    expect((await client.client.get('/v1/line/quota')).status).toBe(403);
  });
});
