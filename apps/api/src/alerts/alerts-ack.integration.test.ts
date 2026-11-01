import { randomUUID } from 'node:crypto';

import {
  ALERTS_AUDIT_ACTIONS,
  REALTIME_PATH,
  type AlertAckResult,
  type RealtimeEvent,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { WebSocket, type RawData } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { signIn, sleep, type Persona } from '../testing/ticketing.js';

// AC-3, the second half, on the real application: acknowledging an alert stops its escalation, shows up
// on the staff realtime feed within the request's own round trip (the 2 s budget is for the whole
// path), is audited once, and a second press is harmless. RBAC: `alert.ack` for the three staff roles,
// nobody else.
const net = disableNetConnect();

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let client: Persona;
let counter = 500;
const owner = () => h.db.owner.pool;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  h = await startHarness();
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  const org = await owner().query<{ id: string }>(
    `INSERT INTO organization (name) VALUES ('Ack org') RETURNING id`,
  );
  client = await signIn(h, 'client', org.rows[0]?.id);
});
afterAll(async () => {
  for (const socket of sockets) socket.terminate();
  await h.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

async function insertAlert(escalationLevel = 1): Promise<string> {
  counter += 1;
  const result = await owner().query<{ id: string }>(
    `INSERT INTO alert (fingerprint, source, title, escalation_level, next_escalation_at)
     VALUES ($1, 'alertmanager', 'High error rate', $2, clock_timestamp() + interval '1 hour') RETURNING id`,
    [counter.toString(16).padStart(64, '0'), escalationLevel],
  );
  return result.rows[0]?.id ?? '';
}

function text(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
}

async function listen(who: Persona): Promise<RealtimeEvent[]> {
  const cookie = [...who.client.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  const ws = new WebSocket(`${h.base.replace('http://', 'ws://')}${REALTIME_PATH}`, {
    headers: { origin: new URL(h.config.APP_URL).origin, cookie },
  });
  sockets.push(ws);
  const events: RealtimeEvent[] = [];
  const state = { ready: false };
  ws.on('message', (data) => {
    const frame = JSON.parse(text(data)) as { type: string };
    if (frame.type === 'ready') state.ready = true;
    else events.push(frame as unknown as RealtimeEvent);
  });
  const deadline = Date.now() + 4000;
  while (!state.ready && Date.now() < deadline) await sleep(20);
  if (!state.ready) throw new Error('socket not ready');
  return events;
}

describe('access (RBAC)', () => {
  it('lets agent, lead and head acknowledge; refuses a client and a visitor', async () => {
    for (const who of [agent, lead, head]) {
      const alertId = await insertAlert();
      const response = await who.client.post<AlertAckResult>(`/v1/alerts/${alertId}/ack`, {});
      expect(response.status, who.email).toBe(200);
    }
    const alertId = await insertAlert();
    expect((await client.client.post(`/v1/alerts/${alertId}/ack`, {})).status).toBe(403);
    expect(
      (await h.client().request('POST', `/v1/alerts/${alertId}/ack`, { body: {}, csrf: false }))
        .status,
    ).toBe(401);
    const untouched = await owner().query(`SELECT state FROM alert WHERE id = $1`, [alertId]);
    expect(untouched.rows[0]).toEqual({ state: 'open' });
  });
});

describe('POST /v1/alerts/:id/ack', () => {
  it('acknowledges, stops the escalation clock, records who and how, and audits once', async () => {
    const alertId = await insertAlert();
    const response = await lead.client.post<AlertAckResult>(`/v1/alerts/${alertId}/ack`, {});
    expect(response.status).toBe(200);
    expect(response.body.changed).toBe(true);
    expect(response.body.alert).toMatchObject({
      id: alertId,
      state: 'acknowledged',
      ackedBy: lead.userId,
      ackedVia: 'web',
      nextEscalationAt: null,
    });
    expect(response.body.alert.ackedAt).not.toBeNull();

    const audited = await owner().query<{ actor_id: string; metadata: { via: string } }>(
      `SELECT actor_id, metadata FROM audit_log WHERE action = $1 AND target_id = $2`,
      [ALERTS_AUDIT_ACTIONS.alertAck, alertId],
    );
    expect(audited.rows).toHaveLength(1);
    expect(audited.rows[0]).toMatchObject({ actor_id: lead.userId, metadata: { via: 'web' } });
  });

  it('a second press changes nothing: changed false, the first person stays, no second audit row', async () => {
    const alertId = await insertAlert();
    await lead.client.post(`/v1/alerts/${alertId}/ack`, {});
    const again = await agent.client.post<AlertAckResult>(`/v1/alerts/${alertId}/ack`, {});
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(again.body.alert.ackedBy).toBe(lead.userId);
    const audited = await owner().query(
      `SELECT 1 FROM audit_log WHERE action = $1 AND target_id = $2 AND outcome = 'success'`,
      [ALERTS_AUDIT_ACTIONS.alertAck, alertId],
    );
    expect(audited.rowCount).toBe(1);
  });

  it('answers 404 for an alert that does not exist', async () => {
    const response = await agent.client.post(`/v1/alerts/${randomUUID()}/ack`, {});
    expect(response.status).toBe(404);
  });

  it('is on the staff realtime feed within the 2 s of AC-3, and a client never hears it', async () => {
    const staff = await listen(agent);
    const customer = await listen(client);
    const alertId = await insertAlert();
    const started = Date.now();
    await lead.client.post(`/v1/alerts/${alertId}/ack`, {});
    let heard: RealtimeEvent | undefined;
    while (heard === undefined && Date.now() - started < 2000) {
      heard = staff.find(
        (event) => event.type === 'alert.updated' && event.data.alertId === alertId,
      );
      if (heard === undefined) await sleep(10);
    }
    expect(heard, 'alert.updated reached staff in time').toBeDefined();
    expect(heard).toMatchObject({
      type: 'alert.updated',
      data: { alertId, state: 'acknowledged', changed: ['state'] },
    });
    await sleep(150);
    expect(customer.filter((event) => event.type === 'alert.updated')).toEqual([]);
  });
});

describe('GET /v1/alerts/:id/escalations', () => {
  it('lists the steps carried out, counts only, with the chat state', async () => {
    const alertId = await insertAlert();
    await owner().query(
      `INSERT INTO alert_escalation (alert_id, level, target, fallback, recipient_ids, recipient_count, chat_state)
       VALUES ($1, 0, 'on_shift', 'lead', ARRAY[$2]::uuid[], 1, 'mock')`,
      [alertId, lead.userId],
    );
    const response = await agent.client.get<{ items: Record<string, unknown>[] }>(
      `/v1/alerts/${alertId}/escalations`,
    );
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      level: 0,
      target: 'on_shift',
      fallback: 'lead',
      recipientCount: 1,
      chatState: 'mock',
    });
    // Never who: only how many.
    expect(JSON.stringify(response.body)).not.toContain(lead.userId);
  });

  it('answers 404 for an unknown alert and 403 for a client', async () => {
    expect((await agent.client.get(`/v1/alerts/${randomUUID()}/escalations`)).status).toBe(404);
    const alertId = await insertAlert();
    expect((await client.client.get(`/v1/alerts/${alertId}/escalations`)).status).toBe(403);
  });
});
