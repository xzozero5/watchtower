import { randomUUID } from 'node:crypto';

import { mintStatusLink } from '@watchtower/domain';
import {
  QUEUE_NAMES,
  STATUSPAGE_AUDIT_ACTIONS,
  STATUSPAGE_JOBS,
  type HumanChallenge,
  type IncidentDetail,
  type PublicHistory,
  type PublicStatus,
  type StatusComponent,
  type StatusMaintenanceStaff,
  type StatusPostStaff,
} from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { solveChallenge } from '../portal/pow.js';
import { startHarness, uniqueEmail, type Harness } from '../testing/harness.js';
import { apiOrg, signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';

// T-204a and c on the real application module: the public page is closed unless the owner opened it, it
// shows only what is allowed, and a post becomes public only when a person presses publish (N3).
const net = disableNetConnect();

let h: Harness;
let closed: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let client: Persona;
let orgId: string;
const owner = () => h.db.owner.pool;
const anonymous = () => h.client();
const get = <T>(path: string) => anonymous().request<T>('GET', path);
const post = <T>(path: string, body: unknown, who = anonymous()) =>
  who.request<T>('POST', path, { body, csrf: false });
const linkKey = () => deriveSubkey(h.config.APP_ENCRYPTION_KEY, KEY_LABELS.statusLink);

beforeAll(async () => {
  h = await startHarness({
    env: {
      STATUS_PAGE_PUBLIC: 'true',
      PORTAL_POW_DIFFICULTY_BITS: '8',
      PORTAL_MIN_FILL_SECONDS: '0',
    },
  });
  closed = await startHarness();
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  orgId = (await apiOrg(lead, { name: 'Secret Customer Org' })).id;
  client = await signIn(h, 'client', orgId);
});
afterAll(async () => {
  await h.close();
  await closed.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const call = <T>(
  who: Persona,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
) => who.client.request<T>(method, path, body === undefined ? {} : { body });

async function component(slug: string, isPublic: boolean): Promise<StatusComponent> {
  const response = await call<StatusComponent>(lead, 'POST', '/v1/status-page/components', {
    slug,
    name: `Name of ${slug}`,
    description: `About ${slug}`,
    public: isPublic,
  });
  expect(response.status).toBe(201);
  return response.body;
}

describe('closed by default', () => {
  it('answers 404 on every public route when STATUS_PAGE_PUBLIC is false, and staff can still prepare', async () => {
    const lead2 = await signIn(closed, 'lead');
    for (const [method, path, body] of [
      ['GET', '/v1/status', undefined],
      ['GET', '/v1/status/history', undefined],
      ['POST', '/v1/status/subscriptions', { email: 'someone@example.test' }],
      ['POST', '/v1/status/subscriptions/confirm', { token: 'x'.repeat(40) }],
      ['POST', '/v1/status/subscriptions/unsubscribe', { token: 'x'.repeat(40) }],
    ] as const) {
      const response = await closed
        .client()
        .request<ApiErrorBody>(method, path, body === undefined ? {} : { body, csrf: false });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    const prepared = await lead2.client.request('POST', '/v1/status-page/components', {
      body: { slug: 'prepared', name: 'Prepared', public: true },
    });
    expect(prepared.status).toBe(201);
    expect((await closed.client().request('GET', '/v1/status')).status).toBe(404);
  });

  it('subscribing while closed records nothing', async () => {
    await closed.client().request('POST', '/v1/status/subscriptions', {
      body: { email: 'closed@example.test' },
      csrf: false,
    });
    const rows = await closed.db.owner.pool.query(`SELECT 1 FROM status_subscription`);
    expect(rows.rowCount).toBe(0);
  });
});

describe('access (RBAC)', () => {
  const someId = randomUUID();
  const ROUTES: readonly [string, string, unknown, 'agent' | 'lead' | 'head'][] = [
    ['GET', '/v1/status-page/components', undefined, 'agent'],
    ['POST', '/v1/status-page/components', { slug: 'rbac-probe', name: 'Probe' }, 'lead'],
    ['PATCH', `/v1/status-page/components/${someId}`, { name: 'x' }, 'lead'],
    ['DELETE', `/v1/status-page/components/${someId}`, undefined, 'lead'],
    ['GET', '/v1/status-page/posts', undefined, 'agent'],
    ['GET', `/v1/status-page/posts/${someId}`, undefined, 'agent'],
    ['POST', '/v1/status-page/posts', { title: 'rbac', body: 'rbac probe' }, 'agent'],
    [
      'POST',
      '/v1/status-page/posts/from-incident',
      { incidentId: someId, componentIds: [someId] },
      'agent',
    ],
    ['PATCH', `/v1/status-page/posts/${someId}`, { title: 'x' }, 'agent'],
    ['POST', `/v1/status-page/posts/${someId}/publish`, {}, 'lead'],
    ['DELETE', `/v1/status-page/posts/${someId}`, undefined, 'agent'],
    ['GET', '/v1/status-page/maintenance', undefined, 'agent'],
    [
      'POST',
      '/v1/status-page/maintenance',
      {
        title: 'rbac',
        body: 'probe',
        startsAt: '2031-01-01T00:00:00Z',
        endsAt: '2031-01-01T01:00:00Z',
      },
      'agent',
    ],
    ['PATCH', `/v1/status-page/maintenance/${someId}`, { title: 'x' }, 'agent'],
    ['POST', `/v1/status-page/maintenance/${someId}/publish`, {}, 'lead'],
    ['POST', `/v1/status-page/maintenance/${someId}/cancel`, {}, 'lead'],
    ['GET', '/v1/status-page/subscribers', undefined, 'lead'],
  ];
  const personas = () => ({ agent, lead, head });
  const order = ['agent', 'lead', 'head'] as const;

  it.each(ROUTES)(
    '%s %s: allowed from the stated role up, refused below it, a customer and a visitor are refused',
    async (method, path, body, minimum) => {
      for (const role of order) {
        const response = await call(personas()[role], method as 'GET', path, body);
        if (order.indexOf(role) < order.indexOf(minimum)) {
          expect(response.status, `${role} ${method} ${path}`).toBe(403);
        } else {
          expect([200, 201, 400, 404, 409], `${role} ${method} ${path}`).toContain(response.status);
        }
      }
      expect((await call(client, method as 'GET', path, body)).status, `client ${path}`).toBe(403);
      const visitor = await h
        .client()
        .request(method, path, body === undefined ? {} : { body, csrf: false });
      expect(visitor.status, `anonymous ${method} ${path}`).toBe(401);
    },
  );
});

describe('the public page is an allow-list', () => {
  it('shows public components and what a person published, and nothing of the incident behind it', async () => {
    const shown = await component('checkout', true);
    const hidden = await component('internal-batch', false);

    // An incident full of things the public must never read.
    const incident = await call<IncidentDetail>(lead, 'POST', '/v1/incidents', {
      title: 'Primary database failover in region xyz-internal',
      severity: 'SEV1',
      orgIds: [orgId],
      commanderId: lead.userId,
    });
    expect(incident.status).toBe(201);
    await call(lead, 'PATCH', `/v1/incidents/${incident.body.id}`, {
      rootCause: 'Bad migration of the orders table',
    });

    const draft = await call<StatusPostStaff>(
      agent,
      'POST',
      '/v1/status-page/posts/from-incident',
      {
        incidentId: incident.body.id,
        componentIds: [shown.id, hidden.id],
        phase: 'investigating',
        impact: 'major',
        locale: 'en',
      },
    );
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({
      state: 'draft',
      origin: 'human',
      incidentId: incident.body.id,
    });

    // A draft is invisible, however it looks to staff.
    const before = await get<PublicStatus>('/v1/status');
    expect(before.status).toBe(200);
    expect(before.body.activePosts).toHaveLength(0);

    // Only a person with permission publishes: an agent cannot.
    expect(
      (await call(agent, 'POST', `/v1/status-page/posts/${draft.body.id}/publish`, {})).status,
    ).toBe(403);
    const published = await call<{ post: StatusPostStaff; subscribers: number }>(
      lead,
      'POST',
      `/v1/status-page/posts/${draft.body.id}/publish`,
      {},
    );
    expect(published.status).toBe(200);
    expect(published.body.post).toMatchObject({ state: 'published', publishedBy: lead.userId });

    const page = await get<PublicStatus>('/v1/status');
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toContain('public');
    expect(page.body.components.map((c) => c.slug)).toContain('checkout');
    expect(page.body.components.map((c) => c.slug)).not.toContain('internal-batch');
    expect(page.body.activePosts).toHaveLength(1);
    const publicPost = page.body.activePosts[0];
    expect(publicPost?.components).toEqual([{ slug: 'checkout', name: 'Name of checkout' }]);
    expect(Object.keys(publicPost ?? {}).toSorted()).toEqual([
      'body',
      'components',
      'id',
      'impact',
      'phase',
      'publishedAt',
      'title',
      'updatedAt',
    ]);
    expect(Object.keys(page.body.components[0] ?? {}).toSorted()).toEqual([
      'description',
      'name',
      'slug',
      'status',
    ]);

    // Nothing of the incident or its people reaches the page, in any field.
    const text = JSON.stringify(page.body);
    for (const secret of [
      'failover',
      'xyz-internal',
      'migration',
      'SEV1',
      incident.body.id,
      lead.userId,
      lead.email,
      orgId,
      'Secret Customer Org',
      'Name of internal-batch',
      'internal-batch',
    ]) {
      expect(text, `the page must not contain ${secret}`).not.toContain(secret);
    }
    // The wording came from the template, naming only the public components.
    expect(publicPost?.body).toContain('Name of checkout');
  });

  it('moves a resolved post from the active list to the history, and closes a published window out of "ongoing"', async () => {
    const [existing] = (
      await call<{ items: StatusPostStaff[] }>(lead, 'GET', '/v1/status-page/posts?state=published')
    ).body.items;
    expect(existing).toBeDefined();
    const resolved = await call<StatusPostStaff>(
      lead,
      'PATCH',
      `/v1/status-page/posts/${existing?.id ?? ''}`,
      {
        phase: 'resolved',
      },
    );
    expect(resolved.status).toBe(200);
    const page = await get<PublicStatus>('/v1/status');
    expect(page.body.activePosts).toHaveLength(0);
    const history = await get<PublicHistory>('/v1/status/history');
    expect(history.body.days).toBe(90);
    expect(history.body.posts.map((p) => p.id)).toContain(existing?.id);
    expect(history.body.posts.find((p) => p.id === existing?.id)?.phase).toBe('resolved');
  });

  it('lists a window only once a person published it, as ongoing or upcoming by the database clock', async () => {
    const day = 86_400_000;
    const draftWindow = async (startOffset: number, endOffset: number) =>
      (
        await call<StatusMaintenanceStaff>(agent, 'POST', '/v1/status-page/maintenance', {
          title: 'Database upgrade',
          body: 'A short interruption.',
          startsAt: new Date(Date.now() + startOffset).toISOString(),
          endsAt: new Date(Date.now() + endOffset).toISOString(),
        })
      ).body;
    const upcoming = await draftWindow(day, day + 3_600_000);
    const ongoing = await draftWindow(-3_600_000, day);
    expect((await get<PublicStatus>('/v1/status')).body.upcomingMaintenance).toHaveLength(0);
    for (const window of [upcoming, ongoing]) {
      expect(
        (await call(agent, 'POST', `/v1/status-page/maintenance/${window.id}/publish`, {})).status,
      ).toBe(403);
      expect(
        (await call(lead, 'POST', `/v1/status-page/maintenance/${window.id}/publish`, {})).status,
      ).toBe(200);
    }
    const page = await get<PublicStatus>('/v1/status');
    expect(page.body.upcomingMaintenance.map((w) => w.id)).toEqual([upcoming.id]);
    expect(page.body.ongoingMaintenance.map((w) => w.id)).toEqual([ongoing.id]);
    expect(
      (await call(lead, 'POST', `/v1/status-page/maintenance/${upcoming.id}/cancel`, {})).status,
    ).toBe(200);
    expect((await get<PublicStatus>('/v1/status')).body.upcomingMaintenance).toHaveLength(0);
  });

  it('keeps who published in the audit log', async () => {
    const rows = await owner().query<{ actor_id: string }>(
      `SELECT actor_id FROM audit_log WHERE action = $1`,
      [STATUSPAGE_AUDIT_ACTIONS.postPublish],
    );
    expect(rows.rows.map((r) => r.actor_id)).toContain(lead.userId);
  });
});

/** A solved challenge for the subscribe form (ADR-007): the caller's own, as a browser would. */
async function proof(who: ReturnType<typeof anonymous>) {
  const response = await who.request<HumanChallenge>('GET', '/v1/status/subscriptions/challenge');
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return {
    provider: 'pow-sha256' as const,
    challenge: response.body.challenge,
    nonce: solveChallenge(response.body.challenge, response.body.difficultyBits),
  };
}

describe('email subscriptions (double opt-in)', () => {
  const subscribe = async (email: string, who = anonymous()) =>
    post<{ status: string }>(
      '/v1/status/subscriptions',
      { email, locale: 'en', verification: await proof(who) },
      who,
    );
  const rowOf = async (email: string) =>
    (
      await owner().query<{
        id: string;
        state: string;
        confirm_nonce: string;
        unsubscribe_nonce: string;
      }>(
        `SELECT id, state, confirm_nonce, unsubscribe_nonce FROM status_subscription WHERE email = $1`,
        [email],
      )
    ).rows[0];

  it('answers the same for every address and sends one confirmation job; nobody is subscribed yet', async () => {
    const email = uniqueEmail('reader');
    const first = await subscribe(email);
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ status: 'check_your_email' });
    const second = await subscribe(email);
    expect(second.status).toBe(202);
    expect(second.body).toEqual(first.body);
    const row = await rowOf(email);
    expect(row?.state).toBe('pending');
    const jobs = await owner().query(
      `SELECT 1 FROM outbox WHERE queue = $1 AND job_name = $2 AND job_id LIKE $3`,
      [QUEUE_NAMES.statuspage, STATUSPAGE_JOBS.confirm, `%${row?.id ?? ''}%`],
    );
    expect(jobs.rowCount).toBe(1);
    // The audit rows name the subscription, not the address.
    const audit = await owner().query<{ m: string }>(
      `SELECT metadata::text AS m FROM audit_log WHERE action = $1`,
      [STATUSPAGE_AUDIT_ACTIONS.subscriptionRequest],
    );
    expect(audit.rows.map((r) => r.m).join('')).not.toContain(email);
  });

  it('T-207a C-3: needs a proof of work, once, and a honeypot nobody fills; nothing is recorded or mailed without it', async () => {
    const email = uniqueEmail('nopow');
    const who = anonymous();
    const none = await post<ApiErrorBody>('/v1/status/subscriptions', { email }, who);
    expect(none.status).toBe(400);
    const wrong = await post<ApiErrorBody>(
      '/v1/status/subscriptions',
      {
        email,
        verification: { provider: 'pow-sha256', challenge: 'x'.repeat(60), nonce: '1' },
      },
      who,
    );
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('verification_failed');
    const good = await proof(who);
    const honey = await post<ApiErrorBody>(
      '/v1/status/subscriptions',
      { email: uniqueEmail('honey'), verification: good, website: 'http://spam.example' },
      who,
    );
    expect(honey.status).toBe(400);
    expect(honey.body.code).toBe('verification_failed');
    expect(
      (await owner().query('SELECT 1 FROM status_subscription WHERE email = $1', [email])).rowCount,
    ).toBe(0);
    // A challenge works once.
    const used = await proof(who);
    const first = await post(
      '/v1/status/subscriptions',
      { email: uniqueEmail('once'), verification: used },
      who,
    );
    expect(first.status).toBe(202);
    const again = await post<ApiErrorBody>(
      '/v1/status/subscriptions',
      { email: uniqueEmail('twice'), verification: used },
      who,
    );
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('verification_failed');
    const reasons = await owner().query<{ metadata: { reason: string } }>(
      `SELECT metadata FROM audit_log WHERE action = $1 AND outcome = 'denied'`,
      [STATUSPAGE_AUDIT_ACTIONS.subscriptionVerificationFailed],
    );
    expect(reasons.rows.map((r) => r.metadata.reason)).toEqual(
      expect.arrayContaining(['honeypot', 'replayed']),
    );
  });

  it('T-207a C-3: one receiving domain gets at most 30 confirmations an hour whoever asks', async () => {
    const domain = `bulk-${randomUUID().slice(0, 8)}.example.test`;
    for (let i = 0; i < 30; i += 1) {
      const response = await subscribe(`person${String(i)}@${domain}`, h.client());
      expect(response.status, String(i)).toBe(202);
    }
    const over = await subscribe(`one-too-many@${domain}`, h.client());
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    const denied = await owner().query<{ metadata: { scope: string } }>(
      `SELECT metadata FROM audit_log WHERE action = $1 AND outcome = 'denied'`,
      [STATUSPAGE_AUDIT_ACTIONS.subscriptionRateLimited],
    );
    expect(denied.rows.map((r) => r.metadata.scope)).toContain('subscribe-domain');
  });

  it('rejects a body that is not an address or has other fields', async () => {
    expect((await subscribe('not-an-address')).status).toBe(400);
    expect(
      (await post('/v1/status/subscriptions', { email: 'a@b.test', admin: true })).status,
    ).toBe(400);
  });

  it('refuses a display-name form or a list, which would mail someone else', async () => {
    for (const email of [
      'foo1<victim@example.test>',
      'Name <victim@example.test>',
      'a@example.test, b@example.test',
      '"quoted name"@example.test',
      'victim@example.test (comment)',
      'no-domain@localhost',
    ]) {
      expect((await subscribe(email)).status, email).toBe(400);
    }
    const stored = await owner().query('SELECT 1 FROM status_subscription WHERE email LIKE $1', [
      '%<%',
    ]);
    expect(stored.rowCount).toBe(0);
  });

  it('counts name+tag@ and name@ as one address for the per-address limit', async () => {
    const [local = '', domain = ''] = uniqueEmail('tagged').split('@');
    const caller = h.client();
    for (const tag of ['a', 'b', 'c']) {
      expect((await subscribe(`${local}+${tag}@${domain}`, caller)).status).toBe(202);
    }
    expect((await subscribe(`${local}@${domain}`, caller)).status).toBe(429);
  });

  it('confirms with the signed link in the body, once or twice, and refuses a wrong one', async () => {
    const email = uniqueEmail('reader');
    await subscribe(email);
    const row = await rowOf(email);
    if (row === undefined) throw new Error('no row');
    const token = mintStatusLink(linkKey(), 'confirm', row.id, row.confirm_nonce);
    const bad = await post<ApiErrorBody>('/v1/status/subscriptions/confirm', {
      token: mintStatusLink(linkKey(), 'confirm', row.id, '0000000000000000'),
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_or_expired_link');
    expect((await post('/v1/status/subscriptions/confirm', { token })).status).toBe(200);
    expect((await post('/v1/status/subscriptions/confirm', { token })).status).toBe(200);
    expect((await rowOf(email))?.state).toBe('confirmed');
    // A GET on the link does nothing: a mail scanner that opens links confirms nobody.
    expect((await get('/v1/status/subscriptions/confirm')).status).toBe(404);
  });

  it('unsubscribes with the link every email carries, and refuses a confirm link there', async () => {
    const email = uniqueEmail('reader');
    await subscribe(email);
    const row = await rowOf(email);
    if (row === undefined) throw new Error('no row');
    await post('/v1/status/subscriptions/confirm', {
      token: mintStatusLink(linkKey(), 'confirm', row.id, row.confirm_nonce),
    });
    const confirmLink = mintStatusLink(linkKey(), 'confirm', row.id, row.confirm_nonce);
    expect(
      (await post('/v1/status/subscriptions/unsubscribe', { token: confirmLink })).status,
    ).toBe(400);
    const token = mintStatusLink(linkKey(), 'unsubscribe', row.id, row.unsubscribe_nonce);
    expect((await post('/v1/status/subscriptions/unsubscribe', { token })).status).toBe(200);
    expect((await post('/v1/status/subscriptions/unsubscribe', { token })).status).toBe(200);
    expect((await rowOf(email))?.state).toBe('unsubscribed');
  });

  it('T-207a C-7: unsubscribes in one click the way a mail client does (RFC 8058): form post, no cookie, token in the link', async () => {
    const email = uniqueEmail('oneclick');
    await subscribe(email);
    const row = await rowOf(email);
    if (row === undefined) throw new Error('no row');
    await post('/v1/status/subscriptions/confirm', {
      token: mintStatusLink(linkKey(), 'confirm', row.id, row.confirm_nonce),
    });
    const token = mintStatusLink(linkKey(), 'unsubscribe', row.id, row.unsubscribe_nonce);
    const click = (query: string, body: string) =>
      fetch(`${h.base}/v1/status/subscriptions/unsubscribe/one-click${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
    // Not a one-click post, or a confirm link: refused, nothing changes.
    expect((await click(`?token=${encodeURIComponent(token)}`, 'hello=world')).status).toBe(400);
    const confirmToken = mintStatusLink(linkKey(), 'confirm', row.id, row.confirm_nonce);
    expect(
      (await click(`?token=${encodeURIComponent(confirmToken)}`, 'List-Unsubscribe=One-Click'))
        .status,
    ).toBe(400);
    expect((await rowOf(email))?.state).toBe('confirmed');
    const done = await click(`?token=${encodeURIComponent(token)}`, 'List-Unsubscribe=One-Click');
    expect(done.status).toBe(200);
    expect((await rowOf(email))?.state).toBe('unsubscribed');
  });

  it('T-207a C-7: an address the worker suppressed after repeated hard bounces gets no new confirmation', async () => {
    const email = uniqueEmail('suppressed');
    await subscribe(email);
    const row = await rowOf(email);
    if (row === undefined) throw new Error('no row');
    await owner().query(
      `UPDATE status_subscription SET state = 'unsubscribed', unsubscribed_at = now(), suppressed_at = now(), bounce_count = 3 WHERE id = $1`,
      [row.id],
    );
    const before = await owner().query(`SELECT 1 FROM outbox WHERE job_id LIKE $1`, [
      `%${row.id}%`,
    ]);
    const again = await subscribe(email);
    // The caller sees the same answer, and nothing is sent.
    expect(again.status).toBe(202);
    expect(again.body).toEqual({ status: 'check_your_email' });
    const after = await owner().query(`SELECT 1 FROM outbox WHERE job_id LIKE $1`, [`%${row.id}%`]);
    expect(after.rowCount).toBe(before.rowCount);
    expect((await rowOf(email))?.state).toBe('unsubscribed');
  });

  it('limits an address to three requests an hour and a caller to five, answering 429 with Retry-After and auditing it', async () => {
    const email = uniqueEmail('flood');
    const caller = h.client();
    for (let i = 0; i < 3; i += 1) expect((await subscribe(email, caller)).status).toBe(202);
    const limited = await subscribe(email, caller);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);

    // Another address from the same caller: the caller has used 4 of 5 (the refused one counts).
    expect((await subscribe(uniqueEmail('other'), caller)).status).toBe(202);
    expect((await subscribe(uniqueEmail('other'), caller)).status).toBe(429);

    const denied = await owner().query<{ metadata: { scope: string } }>(
      `SELECT metadata FROM audit_log WHERE action = $1 AND outcome = 'denied'`,
      [STATUSPAGE_AUDIT_ACTIONS.subscriptionRateLimited],
    );
    // Other tests of this file may have been limited too; both scopes of this one are there.
    expect(denied.rows.map((r) => r.metadata.scope)).toEqual(
      expect.arrayContaining(['subscribe-email', 'subscribe-ip']),
    );
    expect(JSON.stringify(denied.rows)).not.toContain(email);
    // Nobody got a second confirmation from the flood.
    const sent = await owner().query(
      `SELECT 1 FROM outbox o JOIN status_subscription s ON o.job_id LIKE '%' || s.id::text || '%'
       WHERE s.email = $1 AND o.queue = $2`,
      [email, QUEUE_NAMES.statuspage],
    );
    expect(sent.rowCount).toBe(1);
  });
});
