import { randomBytes } from 'node:crypto';

import { FakeLogsClient } from '@watchtower/connectors';
import type { EvidenceCard, TicketTools, ToolTemplate } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { apiIntent, apiOrg, fileTicket, signIn, type Persona } from '../testing/ticketing.js';
import { TOOL_CLIENTS } from './tool-clients.js';

// T-137: a developer has `investigate.run` (the saved templates on a ticket) and not `investigate.adhoc`
// (a filter or a statement of their own). What comes back is what the tool already redacted (N4); this
// checks that the developer gets no more than an agent does, and cannot reach the unbounded queries.

let h: Harness;
let head: Persona;
let agent: Persona;
let dev: Persona;
let ticketRef: string;
let ticketId: string;
let template: ToolTemplate;
let orgId: string;
let otherOrgId: string;

const logs = new FakeLogsClient();
const call = <T>(who: Persona, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) =>
  who.client.request<T>(method, path, body === undefined ? {} : { body });
const minutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();
const EMAIL = 'private.person@customer.example';

beforeAll(async () => {
  h = await startHarness({
    overrides: [{ token: TOOL_CLIENTS, value: { logs, close: () => Promise.resolve() } }],
  });
  head = await signIn(h, 'head');
  agent = await signIn(h, 'agent');
  dev = await signIn(h, 'dev');
  const lead = await signIn(h, 'lead');
  orgId = (await apiOrg(lead, { name: 'Tools Dev Org' })).id;
  otherOrgId = (await apiOrg(lead, { name: 'Tools Other Org' })).id;
  const intentKey = `webhook_${randomBytes(2).toString('hex')}`;
  await apiIntent(lead, { key: intentKey, name: 'Webhook not received' });
  const ticket = await fileTicket(agent, orgId, { intentKey });
  ticketId = ticket.id;
  ticketRef = ticket.key;
  logs.add({
    insertId: 'dev-1',
    timestamp: minutesAgo(5),
    severity: 'ERROR',
    service: 'example-delivery',
    message: `webhook delivery failed for ${EMAIL}`,
    labels: { org_ref: orgId },
  });
  const created = await call<ToolTemplate>(head, 'POST', '/v1/tools/templates', {
    kind: 'logs',
    name: `dev-${randomBytes(2).toString('hex')}`,
    title: 'Delivery errors',
    intentKey,
    body: 'service="example-delivery" AND labels.org_ref={{org_id}} severity>=ERROR',
    runByAi: true,
  });
  template = created.body;
});

afterAll(async () => {
  await h.close();
});

describe('a developer and the investigation tools', () => {
  it('sees the templates and the buttons of a ticket', async () => {
    const list = await call<{ items: ToolTemplate[] }>(dev, 'GET', '/v1/tools/templates');
    expect(list.status).toBe(200);
    const buttons = await call<TicketTools>(dev, 'GET', `/v1/tickets/${ticketRef}/tools`);
    expect(buttons.status).toBe(200);
    expect(buttons.body.buttons.map((button) => button.templateId)).toContain(template.id);
  });

  it('runs a template and gets a card with no address in it, the same as an agent', async () => {
    const run = await call<EvidenceCard>(dev, 'POST', `/v1/tickets/${ticketRef}/tools/run`, {
      templateId: template.id,
    });
    expect(run.status).toBe(201);
    expect(run.body.createdBy).toBe(dev.userId);
    expect(JSON.stringify(run.body)).not.toContain(EMAIL);
    expect(run.body.excerpt).toMatch(/\[EMAIL_\d+\]/);

    const unpinned = await call(dev, 'DELETE', `/v1/tickets/${ticketRef}/evidence/${run.body.id}`);
    expect(unpinned.status).toBe(204);
  });

  it('cannot read the pinned cards of a ticket, ask a question of its own, or change a template', async () => {
    const refused: [string, string, unknown?][] = [
      ['GET', `/v1/tickets/${ticketId}/evidence`],
      ['POST', '/v1/investigate/adhoc/logs', { filter: 'severity>=ERROR', ticketId }],
      ['POST', '/v1/investigate/adhoc/data', { sql: 'select 1', ticketId }],
      [
        'POST',
        '/v1/tools/templates',
        { kind: 'logs', name: 'x', title: 'x', body: 'severity>=ERROR' },
      ],
    ];
    for (const [method, path, body] of refused) {
      const response = await call(dev, method as 'GET' | 'POST', path, body);
      expect([path, response.status]).toEqual([path, 403]);
    }
  });
});

describe('a developer and the tools of an incident (review)', () => {
  const SECRET_NAME = 'Quentin Incidentperson';
  let incidentId: string;
  let twoOrgIncidentId: string;
  const owner = () => h.db.owner.pool;

  beforeAll(async () => {
    await owner().query(`INSERT INTO contact (org_id, name, emails) VALUES ($1, $2, $3)`, [
      orgId,
      SECRET_NAME,
      ['quentin@customer.example'],
    ]);
    const incident = async (orgs: string[]): Promise<string> => {
      const made = await owner().query<{ id: string }>(
        `INSERT INTO incident (title, severity) VALUES ('Outage', 'SEV2') RETURNING id`,
      );
      const id = made.rows[0]?.id ?? '';
      for (const org of orgs) {
        await owner().query(`INSERT INTO incident_org (incident_id, org_id) VALUES ($1, $2)`, [
          id,
          org,
        ]);
      }
      return id;
    };
    incidentId = await incident([orgId]);
    twoOrgIncidentId = await incident([orgId, otherOrgId]);
    logs.add({
      insertId: 'dev-incident-1',
      timestamp: minutesAgo(4),
      severity: 'ERROR',
      service: 'example-delivery',
      message: `delivery failed, the customer ${SECRET_NAME} was told`,
      labels: { org_ref: orgId },
    });
  });

  const run = (who: Persona, id: string, params: Record<string, string> = {}) =>
    call<EvidenceCard & ApiErrorLike>(who, 'POST', `/v1/incidents/${id}/tools/run`, {
      templateId: template.id,
      params,
    });
  interface ApiErrorLike {
    message?: string;
  }

  it('gets the organization from the incident, not from what they type', async () => {
    // An organization the incident does not affect is refused, not read.
    const foreign = await run(dev, incidentId, { org_id: otherOrgId });
    expect(foreign.status).toBe(400);
    // Several affected organizations: they must choose one of them.
    expect((await run(dev, twoOrgIncidentId)).status).toBe(400);
    expect((await run(dev, twoOrgIncidentId, { org_id: otherOrgId })).status).toBe(201);
    // One affected organization: it is filled in.
    const filled = await run(dev, incidentId);
    expect(filled.status).toBe(201);
    expect(filled.body.incidentId).toBe(incidentId);
  });

  it('masks the names of the organization in what an incident run returns, for a developer and an agent', async () => {
    for (const who of [dev, agent]) {
      const response = await run(who, incidentId, { ...(who === agent ? { org_id: orgId } : {}) });
      expect(response.status).toBe(201);
      expect(response.body.excerpt, who.session.user.role).toContain('delivery failed');
      expect(response.body.excerpt).not.toContain('Incidentperson');
      expect(response.body.excerpt).toMatch(/\[NAME_\d+\]/);
    }
  });

  it('cannot run a template that is not limited to an organization, on a ticket or an incident', async () => {
    const open = await call<ToolTemplate>(head, 'POST', '/v1/tools/templates', {
      kind: 'logs',
      name: `all-orgs-${randomBytes(2).toString('hex')}`,
      title: 'Every organization',
      body: 'service="example-delivery" severity>=ERROR',
      runByAi: false,
    });
    expect(open.status).toBe(201);
    const templateId = open.body.id;
    for (const path of [
      `/v1/tickets/${ticketRef}/tools/run`,
      `/v1/incidents/${incidentId}/tools/run`,
    ]) {
      const refused = await call(dev, 'POST', path, { templateId });
      expect([path, refused.status]).toEqual([path, 403]);
      // An agent keeps running it, as before.
      const allowed = await call(agent, 'POST', path, { templateId });
      expect([path, allowed.status]).toEqual([path, 201]);
    }
  });

  it('keeps an agent as free as before: they name the organization themselves', async () => {
    const response = await run(agent, incidentId, { org_id: otherOrgId });
    expect(response.status).toBe(201);
  });
});
