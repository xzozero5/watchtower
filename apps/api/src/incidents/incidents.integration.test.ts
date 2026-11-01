import { randomBytes, randomUUID } from 'node:crypto';

import { alerts } from '@watchtower/connectors';
import {
  ALERT_WEBHOOK_SIGNATURE_HEADER,
  INCIDENTS_AUDIT_ACTIONS,
  INCIDENTS_JOBS,
  QUEUE_NAMES,
  type Deploy,
  type IncidentChanges,
  type IncidentDetail,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { FakeRepoChanges, REPO_CHANGES } from './changes.js';
import {
  apiOrg,
  fileTicket,
  signIn,
  type ApiErrorBody,
  type Persona,
} from '../testing/ticketing.js';

// T-202a on the real application module: incidents (open, change, link, note, resolve), RBAC on every
// route, and the signed deploy feed. disableNetConnect allows loopback only.
const SECRET = randomBytes(24).toString('hex');
const net = disableNetConnect();
const repo = new FakeRepoChanges();

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let client: Persona;
let orgId: string;
let counter = 12_000;
let ipCounter = 0;
const owner = () => h.db.owner.pool;
const freshIp = (): string => `192.0.2.${String(++ipCounter % 250)}`;

beforeAll(async () => {
  h = await startHarness({
    env: { ALERT_WEBHOOK_SECRET: SECRET },
    overrides: [{ token: REPO_CHANGES, value: repo }],
  });
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  orgId = (await apiOrg(lead, { name: 'Incident Org' })).id;
  client = await signIn(h, 'client', orgId);
});
afterAll(async () => {
  await h.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const call = <T>(
  who: Persona,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
) => who.client.request<T>(method, path, body === undefined ? {} : { body });

async function addService(): Promise<{ id: string; slug: string }> {
  const slug = `svc-${randomUUID().slice(0, 8)}`;
  const row = await owner().query<{ id: string }>(
    `INSERT INTO service (slug, name) VALUES ($1, $1) RETURNING id`,
    [slug],
  );
  return { id: row.rows[0]?.id ?? '', slug };
}

async function addAlert(): Promise<string> {
  counter += 1;
  const row = await owner().query<{ id: string }>(
    `INSERT INTO alert (fingerprint, source, title) VALUES ($1, 'alertmanager', 'High error rate') RETURNING id`,
    [counter.toString(16).padStart(64, '0')],
  );
  return row.rows[0]?.id ?? '';
}

const open = (who: Persona, body: Record<string, unknown> = {}) =>
  call<IncidentDetail>(who, 'POST', '/v1/incidents', {
    title: 'Checkout errors',
    severity: 'SEV2',
    ...body,
  });

describe('access (RBAC)', () => {
  const someId = randomUUID();
  const ROUTES: readonly [string, string, unknown, readonly ('agent' | 'lead' | 'head')[]][] = [
    ['GET', '/v1/incidents', undefined, ['agent', 'lead', 'head']],
    ['GET', `/v1/incidents/${someId}`, undefined, ['agent', 'lead', 'head']],
    ['GET', '/v1/deploys', undefined, ['agent', 'lead', 'head']],
    ['POST', '/v1/incidents', { title: 'rbac probe', severity: 'SEV4' }, ['agent', 'lead', 'head']],
    ['PATCH', `/v1/incidents/${someId}`, { title: 'x' }, ['agent', 'lead', 'head']],
    [
      'POST',
      `/v1/incidents/${someId}/tickets`,
      { ticketId: randomUUID() },
      ['agent', 'lead', 'head'],
    ],
    [
      'DELETE',
      `/v1/incidents/${someId}/tickets/${randomUUID()}`,
      undefined,
      ['agent', 'lead', 'head'],
    ],
    [
      'POST',
      `/v1/incidents/${someId}/alerts`,
      { alertId: randomUUID() },
      ['agent', 'lead', 'head'],
    ],
    ['POST', `/v1/incidents/${someId}/notes`, { text: 'rbac probe' }, ['agent', 'lead', 'head']],
  ];

  it.each(ROUTES)(
    '%s %s: staff only, a customer and a visitor are refused',
    async (method, path, body) => {
      for (const who of [agent, lead, head]) {
        const response = await call(who, method as 'GET', path, body);
        expect([200, 201, 404, 409], `${who.email} ${method} ${path}`).toContain(response.status);
      }
      expect((await call(client, method as 'GET', path, body)).status, `client ${path}`).toBe(403);
      const anonymous = await h
        .client()
        .request(method, path, body === undefined ? {} : { body, csrf: false });
      expect(anonymous.status, `anonymous ${method} ${path}`).toBe(401);
    },
  );
});

describe('opening and changing an incident', () => {
  it('opens one with services, an alert and a ticket, and shows them with the timeline', async () => {
    const service = await addService();
    const alertId = await addAlert();
    const ticket = await fileTicket(agent, orgId);
    const response = await open(agent, {
      serviceIds: [service.id],
      alertIds: [alertId],
      ticketIds: [ticket.id],
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      severity: 'SEV2',
      status: 'investigating',
      commanderId: agent.userId,
      serviceIds: [service.id],
      orgIds: [orgId],
      tickets: 1,
      alerts: 1,
      ticketIds: [ticket.id],
      alertIds: [alertId],
      discordThreadState: 'pending',
    });
    expect(response.body.key).toBe(`INC-${String(response.body.number)}`);
    expect(response.body.timeline.map((entry) => entry.type).toSorted()).toEqual(
      ['alert_linked', 'created', 'ticket_linked'].toSorted(),
    );
    // The thread is queued through the outbox, with ids only.
    const jobs = await owner().query<{ job_name: string; payload: Record<string, unknown> }>(
      `SELECT job_name, payload FROM outbox WHERE queue = $1 AND payload->>'incidentId' = $2`,
      [QUEUE_NAMES.incidents, response.body.id],
    );
    expect(jobs.rows.map((row) => row.job_name)).toContain(INCIDENTS_JOBS.thread);
    expect(JSON.stringify(jobs.rows)).not.toContain('Checkout errors');
    // The ticket now shows its incident.
    const linked = await owner().query<{ incident_id: string }>(
      `SELECT incident_id FROM ticket WHERE id = $1`,
      [ticket.id],
    );
    expect(linked.rows[0]?.incident_id).toBe(response.body.id);
  });

  it('refuses nonsense and an alert that belongs to another incident', async () => {
    expect((await open(agent, { severity: 'SEV9' })).status).toBe(400);
    expect((await open(agent, { title: '  ' })).status).toBe(400);
    expect((await open(agent, { serviceIds: [randomUUID()] })).status).toBe(400);
    expect((await open(agent, { commanderId: randomUUID() })).status).toBe(400);
    const alertId = await addAlert();
    expect((await open(agent, { alertIds: [alertId] })).status).toBe(201);
    expect((await open(agent, { alertIds: [alertId] })).status).toBe(409);
  });

  it('moves the status, and only incident.manage resolves; resolved is final', async () => {
    const created = (await open(agent)).body;
    const path = `/v1/incidents/${created.id}`;
    expect(
      (await call<IncidentDetail>(agent, 'PATCH', path, { status: 'identified' })).body.status,
    ).toBe('identified');
    expect((await call(agent, 'PATCH', path, { status: 'identified' })).status).toBe(409);
    expect((await call(agent, 'PATCH', path, { status: 'resolved' })).status).toBe(400);
    const resolved = await call<IncidentDetail>(lead, 'PATCH', path, {
      status: 'resolved',
      rootCause: 'A bad deploy',
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ status: 'resolved', rootCause: 'A bad deploy' });
    expect(resolved.body.resolvedAt).not.toBeNull();
    expect((await call(lead, 'PATCH', path, { title: 'again' })).status).toBe(409);
    expect((await call(lead, 'POST', `${path}/notes`, { text: 'late' })).status).toBe(409);

    const audited = await owner().query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM audit_log WHERE target_id = $1 AND outcome = 'success' ORDER BY created_at`,
      [created.id],
    );
    expect(audited.rows.map((row) => row.action)).toEqual([
      INCIDENTS_AUDIT_ACTIONS.incidentCreate,
      INCIDENTS_AUDIT_ACTIONS.incidentUpdate,
      INCIDENTS_AUDIT_ACTIONS.incidentResolve,
    ]);
    expect(audited.rows[2]?.actor_id).toBe(lead.userId);
  });

  it('links a ticket and an alert, unlinks the ticket, takes a note, and lists newest first', async () => {
    const created = (await open(agent)).body;
    const base = `/v1/incidents/${created.id}`;
    const ticket = await fileTicket(agent, orgId);
    const alertId = await addAlert();
    expect(
      (await call<{ changed: boolean }>(agent, 'POST', `${base}/tickets`, { ticketId: ticket.id }))
        .body,
    ).toEqual({ changed: true });
    expect(
      (await call<{ changed: boolean }>(agent, 'POST', `${base}/tickets`, { ticketId: ticket.id }))
        .body,
    ).toEqual({ changed: false });
    expect(
      (await call<{ changed: boolean }>(agent, 'POST', `${base}/alerts`, { alertId })).body,
    ).toEqual({ changed: true });
    expect(
      (await call(agent, 'POST', `${base}/notes`, { text: 'Rolled back checkout' })).status,
    ).toBe(201);
    expect(
      (await call<{ changed: boolean }>(agent, 'DELETE', `${base}/tickets/${ticket.id}`)).body,
    ).toEqual({ changed: true });

    const detail = (await call<IncidentDetail>(agent, 'GET', base)).body;
    expect(detail.tickets).toBe(0);
    expect(detail.alerts).toBe(1);
    expect(detail.timeline.find((entry) => entry.type === 'note')?.payload).toEqual({
      text: 'Rolled back checkout',
    });

    const another = (await open(agent)).body;
    const list = await call<{ items: { id: string }[]; nextCursor: string | null }>(
      agent,
      'GET',
      '/v1/incidents?limit=1',
    );
    expect(list.body.items.map((item) => item.id)).toEqual([another.id]);
    expect(list.body.nextCursor).not.toBeNull();
    const openOnly = await call<{ items: { status: string }[] }>(
      agent,
      'GET',
      '/v1/incidents?open=true&limit=100',
    );
    expect(openOnly.body.items.every((item) => item.status !== 'resolved')).toBe(true);
  });
});

describe('the deploy feed (R-5.4)', () => {
  async function post(raw: string, header: string | undefined) {
    const response = await fetch(`${h.base}/v1/inbound/deploys`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': freshIp(),
        ...(header === undefined ? {} : { [ALERT_WEBHOOK_SIGNATURE_HEADER]: header }),
      },
      body: raw,
    });
    return { status: response.status, body: await response.json().catch((): unknown => null) };
  }
  const sign = (raw: string, offsetSeconds = 0) =>
    alerts.signAlertWebhook({
      rawBody: raw,
      secret: SECRET,
      timestampSeconds: Math.floor(Date.now() / 1000) + offsetSeconds,
    });
  const event = (service: string, overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: `run-${randomUUID()}`,
      service,
      version: 'v2026.11.2',
      env: 'production',
      source: 'ci',
      actor: 'ci-bot',
      startedAt: '2026-11-02T03:00:00Z',
      finishedAt: '2026-11-02T03:04:00Z',
      url: 'https://ci.example.invalid/run/1',
      ...overrides,
    });

  it('records a signed deploy once, and lists it for staff', async () => {
    const service = await addService();
    const raw = event(service.slug);
    expect(await post(raw, sign(raw))).toEqual({ status: 200, body: { recorded: true } });
    expect(await post(raw, sign(raw))).toEqual({ status: 200, body: { recorded: false } });
    const list = await call<{ items: Deploy[] }>(
      agent,
      'GET',
      `/v1/deploys?serviceId=${service.id}`,
    );
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      serviceSlug: service.slug,
      version: 'v2026.11.2',
      env: 'production',
      actor: 'ci-bot',
      source: 'ci',
      occurredAt: '2026-11-02T03:04:00.000Z',
    });
  });

  it('refuses a missing, wrong or old signature with one answer, before reading the body', async () => {
    const service = await addService();
    const raw = event(service.slug);
    const unsigned = await post(raw, undefined);
    const wrong = await post(raw, sign('{"other":1}'));
    const old = await post(raw, sign(raw, -3600));
    expect([unsigned.status, wrong.status, old.status]).toEqual([401, 401, 401]);
    expect(unsigned.body).toEqual(wrong.body);
    const rows = await owner().query(`SELECT 1 FROM deploy WHERE service_slug = $1`, [
      service.slug,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('answers 404 for a service nobody catalogued and 400 for a body that is not a deploy', async () => {
    const unknown = event('no-such-service');
    expect((await post(unknown, sign(unknown))).status).toBe(404);
    const notJson = 'not json';
    expect((await post(notJson, sign(notJson))).status).toBe(400);
    const wrongShape = JSON.stringify({ service: 'x' });
    expect((await post(wrongShape, sign(wrongShape))).status).toBe(400);
    const service = await addService();
    const backwards = event(service.slug, {
      startedAt: '2026-11-02T04:00:00Z',
      finishedAt: '2026-11-02T03:00:00Z',
    });
    expect((await post(backwards, sign(backwards))).status).toBe(400);
  });
});

describe('mass communication (R-3.14, N3)', () => {
  interface Comm {
    id: string;
    origin: string;
    status: string;
    sentBy: string | null;
    confirmedRecipients: number | null;
  }

  async function incidentWithTickets(count: number) {
    const created = (await open(agent)).body;
    const ticketIds: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const ticket = await fileTicket(agent, orgId);
      await call(agent, 'POST', `/v1/incidents/${created.id}/tickets`, { ticketId: ticket.id });
      ticketIds.push(ticket.id);
    }
    return { id: created.id, ticketIds };
  }

  it('access: staff read, agents draft, only incident.manage sends; a customer and a visitor get nothing', async () => {
    const { id } = await incidentWithTickets(1);
    const comm = (await call<Comm>(agent, 'POST', `/v1/incidents/${id}/comms`, { body: 'Hello' }))
      .body;
    const send = { confirmRecipients: 1 };
    expect(
      (await call(agent, 'POST', `/v1/incidents/${id}/comms/${comm.id}/send`, send)).status,
    ).toBe(403);
    for (const path of [`/v1/incidents/${id}/comms`, `/v1/incidents/${id}/comms/preview`]) {
      expect((await call(agent, 'GET', path)).status).toBe(200);
      expect((await call(client, 'GET', path)).status).toBe(403);
      expect((await h.client().get(path)).status).toBe(401);
    }
    expect((await call(client, 'POST', `/v1/incidents/${id}/comms`, { body: 'x' })).status).toBe(
      403,
    );
    expect(
      (await call(client, 'POST', `/v1/incidents/${id}/comms/${comm.id}/send`, send)).status,
    ).toBe(403);
    expect((await call(head, 'POST', `/v1/incidents/${id}/comms`, { body: '  ' })).status).toBe(
      400,
    );
  });

  it('drafts, previews, refuses a wrong count, and a lead sends once to every linked ticket', async () => {
    const { id, ticketIds } = await incidentWithTickets(2);
    const drafted = await call<Comm>(agent, 'POST', `/v1/incidents/${id}/comms`, {
      body: 'Checkout is back. Sorry for the trouble.',
    });
    expect(drafted.status).toBe(201);
    expect(drafted.body).toMatchObject({ origin: 'human', status: 'draft', sentBy: null });

    const preview = await call(agent, 'GET', `/v1/incidents/${id}/comms/preview`);
    expect(preview.body).toEqual({ recipients: 2, skippedChannel: 0, skippedClosed: 0 });

    const path = `/v1/incidents/${id}/comms/${drafted.body.id}/send`;
    const mismatch = await call<ApiErrorBody>(lead, 'POST', path, { confirmRecipients: 7 });
    expect(mismatch.status).toBe(409);
    for (const ticketId of ticketIds) {
      const sent = await owner().query(
        `SELECT 1 FROM message WHERE ticket_id = $1 AND direction = 'outbound'`,
        [ticketId],
      );
      expect(sent.rowCount).toBe(0);
    }

    const sent = await call(lead, 'POST', path, { confirmRecipients: 2 });
    expect(sent).toMatchObject({ status: 200, body: { recipients: 2, sent: 2, failed: 0 } });
    for (const ticketId of ticketIds) {
      const rows = await owner().query<{ body_text: string; sender_user_id: string }>(
        `SELECT body_text, sender_user_id FROM message WHERE ticket_id = $1 AND direction = 'outbound'`,
        [ticketId],
      );
      expect(rows.rows).toEqual([
        { body_text: 'Checkout is back. Sorry for the trouble.', sender_user_id: lead.userId },
      ]);
    }
    expect((await call(lead, 'POST', path, { confirmRecipients: 2 })).status).toBe(409);

    const list = await call<{ items: Comm[] }>(agent, 'GET', `/v1/incidents/${id}/comms`);
    expect(list.body.items[0]).toMatchObject({
      status: 'sent',
      sentBy: lead.userId,
      confirmedRecipients: 2,
    });
    const audited = await owner().query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM audit_log WHERE target_id = $1 AND action LIKE 'incident.comm.%' ORDER BY created_at`,
      [id],
    );
    expect(audited.rows).toEqual([
      { action: INCIDENTS_AUDIT_ACTIONS.incidentCommDraft, actor_id: agent.userId },
      { action: INCIDENTS_AUDIT_ACTIONS.incidentCommSend, actor_id: lead.userId },
    ]);
  });

  it('an update drafted by the AI waits for a person: it is listed as origin ai and a lead sends it', async () => {
    const { id } = await incidentWithTickets(1);
    const inserted = await owner().query<{ id: string }>(
      `INSERT INTO incident_comm (incident_id, body, origin) VALUES ($1, 'Drafted by the AI', 'ai') RETURNING id`,
      [id],
    );
    const commId = inserted.rows[0]?.id ?? '';
    const list = await call<{ items: Comm[] }>(agent, 'GET', `/v1/incidents/${id}/comms`);
    expect(list.body.items[0]).toMatchObject({ origin: 'ai', status: 'draft' });
    const sent = await call(lead, 'POST', `/v1/incidents/${id}/comms/${commId}/send`, {
      confirmRecipients: 1,
    });
    expect(sent.status).toBe(200);
    const row = await owner().query<{ sent_by: string }>(
      `SELECT sent_by FROM incident_comm WHERE id = $1`,
      [commId],
    );
    expect(row.rows[0]?.sent_by).toBe(lead.userId);
  });
});

describe('what changed (R-3.15)', () => {
  const MINUTE = 60_000;

  async function serviceWithRepo(): Promise<{ id: string; slug: string; repo: string }> {
    const slug = `svc-${randomUUID().slice(0, 8)}`;
    const repoName = `example-org/${slug}`;
    const row = await owner().query<{ id: string }>(
      `INSERT INTO service (slug, name, repos) VALUES ($1, $1, ARRAY[$2]) RETURNING id`,
      [slug, repoName],
    );
    return { id: row.rows[0]?.id ?? '', slug, repo: repoName };
  }

  async function deployAt(serviceId: string, slug: string, at: Date, version: string) {
    await owner().query(
      `INSERT INTO deploy (service_id, service_slug, version, env, source, external_id, finished_at)
       VALUES ($1, $2, $3, 'production', 'ci', $4, $5)`,
      [serviceId, slug, version, randomUUID(), at],
    );
  }

  /** An incident on `serviceId` whose first alert opened at `firstAlertAt` (a database timestamp). */
  async function incidentWithAlert(serviceId: string, firstAlertAt: Date | null) {
    const created = (await open(agent, { serviceIds: [serviceId] })).body;
    if (firstAlertAt !== null) {
      const alertId = await addAlert();
      await call(agent, 'POST', `/v1/incidents/${created.id}/alerts`, { alertId });
      await owner().query(`UPDATE alert SET first_seen_at = $2 WHERE id = $1`, [
        alertId,
        firstAlertAt,
      ]);
    }
    return created;
  }

  const changes = (who: Persona, id: string, query = '') =>
    call<IncidentChanges>(who, 'GET', `/v1/incidents/${id}/changes${query}`);

  it('lists the deploys of the incident’s services in the window before the first alert, and no others', async () => {
    const service = await serviceWithRepo();
    const other = await serviceWithRepo();
    const alertAt = new Date('2026-11-02T03:00:00.000Z');
    const incident = await incidentWithAlert(service.id, alertAt);
    await deployAt(service.id, service.slug, new Date(alertAt.getTime() - 10 * MINUTE), 'inside');
    await deployAt(
      service.id,
      service.slug,
      new Date(alertAt.getTime() - 180 * MINUTE),
      'three-hours-before',
    );
    await deployAt(
      service.id,
      service.slug,
      new Date(alertAt.getTime() + 5 * MINUTE),
      'after-the-alert',
    );
    await deployAt(
      other.id,
      other.slug,
      new Date(alertAt.getTime() - 10 * MINUTE),
      'other-service',
    );

    const narrow = await changes(agent, incident.id);
    expect(narrow.status).toBe(200);
    expect(narrow.body.window).toEqual({
      from: '2026-11-02T02:00:00.000Z',
      to: '2026-11-02T03:00:00.000Z',
      minutes: 60,
      endsAt: 'alert',
    });
    expect(narrow.body.deploys.map((deploy) => deploy.version)).toEqual(['inside']);

    const wide = await changes(agent, incident.id, '?windowMinutes=240');
    expect(wide.body.deploys.map((deploy) => deploy.version)).toEqual([
      'inside',
      'three-hours-before',
    ]);
    expect(wide.body.repoSource).toBe('fake');
  });

  it('without an alert the window ends where the incident started', async () => {
    const service = await serviceWithRepo();
    const incident = await incidentWithAlert(service.id, null);
    const response = await changes(agent, incident.id);
    expect(response.body.window.endsAt).toBe('incident');
    expect(response.body.window.to).toBe(incident.startedAt);
    expect(response.body.deploys).toEqual([]);
  });

  it('adds commits, pull requests and releases of the service repositories, newest first, from the read-only port', async () => {
    const service = await serviceWithRepo();
    const alertAt = new Date('2026-11-02T05:00:00.000Z');
    const incident = await incidentWithAlert(service.id, alertAt);
    const at = (minutesBefore: number) =>
      new Date(alertAt.getTime() - minutesBefore * MINUTE).toISOString();
    repo.add({
      repo: service.repo,
      kind: 'commit',
      ref: 'abc1234',
      title: 'Fix rounding',
      author: 'dev-a',
      at: at(30),
      url: null,
    });
    repo.add({
      repo: service.repo,
      kind: 'pull_request',
      ref: '#42',
      title: 'Retry payments',
      author: 'dev-b',
      at: at(20),
      url: 'https://git.example.invalid/pull/42',
    });
    repo.add({
      repo: service.repo,
      kind: 'release',
      ref: 'v1.2.0',
      title: null,
      author: null,
      at: at(500),
      url: null,
    });
    repo.add({
      repo: 'example-org/unrelated',
      kind: 'commit',
      ref: 'ffff',
      title: 'x',
      author: null,
      at: at(10),
      url: null,
    });

    const response = await changes(agent, incident.id);
    expect(response.body.repoChanges.map((change) => change.ref)).toEqual(['#42', 'abc1234']);
    expect(response.body.repoUnavailable).toBe(false);
    const call = repo.calls.at(-1);
    expect(call).toMatchObject({ repo: service.repo, limit: 30 });
    expect(call?.until.toISOString()).toBe(alertAt.toISOString());
  });

  it('shows the deploys alone, and says so, when the repository cannot be read', async () => {
    const service = await serviceWithRepo();
    const alertAt = new Date('2026-11-02T06:00:00.000Z');
    const incident = await incidentWithAlert(service.id, alertAt);
    await deployAt(
      service.id,
      service.slug,
      new Date(alertAt.getTime() - 5 * MINUTE),
      'v-still-there',
    );
    repo.failNext(new Error('repository unreachable'));
    const response = await changes(agent, incident.id);
    expect(response.status).toBe(200);
    expect(response.body.repoUnavailable).toBe(true);
    expect(response.body.repoChanges).toEqual([]);
    expect(response.body.deploys.map((deploy) => deploy.version)).toEqual(['v-still-there']);
  });

  it('validates the window, and is staff only', async () => {
    const service = await serviceWithRepo();
    const incident = await incidentWithAlert(service.id, null);
    expect((await changes(agent, incident.id, '?windowMinutes=1')).status).toBe(400);
    expect((await changes(agent, incident.id, '?windowMinutes=5000')).status).toBe(400);
    expect((await changes(agent, randomUUID())).status).toBe(404);
    expect((await changes(client, incident.id)).status).toBe(403);
    expect((await h.client().get(`/v1/incidents/${incident.id}/changes`)).status).toBe(401);
  });
});
