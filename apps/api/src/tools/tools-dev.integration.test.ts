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
  const orgId = (await apiOrg(lead, { name: 'Tools Dev Org' })).id;
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
