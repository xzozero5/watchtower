import { randomUUID } from 'node:crypto';

import { discord } from '@watchtower/channels';
import { REALTIME_PATH, type RealtimeEvent } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { WebSocket, type RawData } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { apiOrg, signIn, sleep, type Persona } from '../testing/ticketing.js';

// T-202b on the real application module: the Discord interactions endpoint with an Ed25519 key pair made
// here (no Discord, no token, no network). AC-3: pressing Ack in Discord acknowledges the alert and the web
// hears of it within 2 s. An unlinked Discord account is refused and nothing changes. The same interaction
// id is handled once. The whole path answers inside the 3 seconds Discord allows.
const net = disableNetConnect();
const keys = discord.generateInteractionKeys();
const URL_PATH = '/v1/inbound/discord/interactions';

let h: Harness;
let agent: Persona;
let lead: Persona;
let observer: Persona;
let customer: Persona;
let counter = 3000;
let snowflake = 100_000_000_000_000_000n;
const owner = () => h.db.owner.pool;
const sockets: WebSocket[] = [];
const nextId = (): string => String(++snowflake);
const discordIds = new Map<string, string>();

beforeAll(async () => {
  h = await startHarness({ env: { DISCORD_PUBLIC_KEY: keys.publicKeyHex } });
  agent = await link(await signIn(h, 'agent'));
  lead = await link(await signIn(h, 'lead'));
  observer = await signIn(h, 'agent');
  const org = await apiOrg(lead, { name: 'Interactions Org' });
  customer = await link(await signIn(h, 'client', org.id));
});
afterAll(async () => {
  for (const socket of sockets) socket.terminate();
  await h.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

/** Links a Watchtower user to a made-up Discord account (users.discord_user_id). */
async function link(who: Persona): Promise<Persona> {
  const id = nextId();
  discordIds.set(who.userId, id);
  await owner().query(`UPDATE users SET discord_user_id = $1 WHERE id = $2`, [id, who.userId]);
  return who;
}
const discordOf = (who: Persona): string => discordIds.get(who.userId) ?? '';

async function send(
  body: unknown,
  options: { signature?: string; tamper?: boolean; ageSeconds?: number } = {},
) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000) - (options.ageSeconds ?? 0));
  const signature = options.signature ?? keys.sign(timestamp, raw);
  const started = Date.now();
  const response = await fetch(`${h.base}${URL_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `203.0.113.${String(1 + (counter % 250))}`,
      'x-signature-ed25519': signature,
      'x-signature-timestamp': timestamp,
    },
    body: options.tamper === true ? raw.replace('type', 'tyPe') : raw,
  });
  const json = (await response.json().catch(() => null)) as {
    type: number;
    data?: { content: string; flags?: number; components?: unknown[] };
  } | null;
  return { status: response.status, body: json, ms: Date.now() - started };
}

const press = (who: Persona, customId: string, id = nextId()) =>
  send({
    id,
    type: 3,
    member: { user: { id: discordOf(who) } },
    data: { custom_id: customId, component_type: 2 },
  });

const command = (who: Persona, name: string, options: unknown[], id = nextId()) =>
  send({ id, type: 2, member: { user: { id: discordOf(who) } }, data: { name, options } });

async function addAlert(): Promise<string> {
  counter += 1;
  const row = await owner().query<{ id: string }>(
    `INSERT INTO alert (fingerprint, source, title) VALUES ($1, 'alertmanager', 'Secret customer outage title') RETURNING id`,
    [counter.toString(16).padStart(64, '0')],
  );
  return row.rows[0]?.id ?? '';
}
const alertState = async (id: string) =>
  (
    await owner().query<{ state: string; acked_by: string | null; acked_via: string | null }>(
      `SELECT state, acked_by, acked_via FROM alert WHERE id = $1`,
      [id],
    )
  ).rows[0];

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

describe('the signature', () => {
  it('answers a PING with a PONG and nothing else needs a database', async () => {
    const response = await send({ id: nextId(), type: 1 });
    expect(response).toMatchObject({ status: 200, body: { type: 1 } });
  });

  it('refuses a genuine request that is too old or too far ahead (a replay), with the same 401, and does nothing (review)', async () => {
    const alertId = await addAlert();
    const body = {
      id: nextId(),
      type: 3,
      member: { user: { id: discordOf(agent) } },
      data: { custom_id: discord.customIds.alertAck(alertId), component_type: 2 },
    };
    const tolerance = discord.INTERACTION_TOLERANCE_SECONDS;
    // Correctly signed, but from before the tolerance: the old press is a replay, however long ago.
    expect((await send(body, { ageSeconds: tolerance + 60 })).status).toBe(401);
    expect((await send(body, { ageSeconds: 3 * 24 * 3600 })).status).toBe(401);
    expect((await send(body, { ageSeconds: -(tolerance + 60) })).status).toBe(401);
    expect((await alertState(alertId))?.state).toBe('open');
    const seen = await owner().query(`SELECT 1 FROM discord_interaction WHERE id = $1`, [body.id]);
    expect(seen.rowCount).toBe(0);
    // The same request, fresh, is handled; the stale copy of it stays refused afterwards.
    expect((await send(body, { ageSeconds: 5 })).status).toBe(200);
    expect((await send(body, { ageSeconds: tolerance + 60 })).status).toBe(401);
  });

  it('refuses a missing, wrong or tampered signature with 401 and writes nothing', async () => {
    const before = await owner().query(`SELECT count(*)::int AS n FROM discord_interaction`);
    const body = { id: nextId(), type: 3, data: { custom_id: 'x' } };
    expect((await send(body, { signature: '00'.repeat(64) })).status).toBe(401);
    expect((await send(body, { signature: 'nonsense' })).status).toBe(401);
    expect((await send(body, { tamper: true })).status).toBe(401);
    const response = await fetch(`${h.base}${URL_PATH}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(401);
    const after = await owner().query(`SELECT count(*)::int AS n FROM discord_interaction`);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('is 400 for a signed body that is not an interaction, and 503 when no public key is set', async () => {
    expect((await send('not json')).status).toBe(400);
    expect((await send({ id: 'nope', type: 3 })).status).toBe(400);
    const bare = await startHarness({ env: { DISCORD_PUBLIC_KEY: '' } });
    try {
      const response = await fetch(`${bare.base}${URL_PATH}`, {
        method: 'POST',
        body: '{}',
        headers: {
          'content-type': 'application/json',
          'x-signature-ed25519': '00'.repeat(64),
          'x-signature-timestamp': '1',
        },
      });
      expect(response.status).toBe(503);
    } finally {
      await bare.close();
    }
  });
});

describe('Ack on an alert page (AC-3)', () => {
  it('acknowledges, takes the button away, audits "via discord", and the web hears of it within 2 s', async () => {
    const alertId = await addAlert();
    const heard = await listen(observer);
    const started = Date.now();
    const response = await press(agent, discord.customIds.alertAck(alertId));
    expect(response.status).toBe(200);
    expect(response.body?.type).toBe(7);
    expect(response.body?.data?.components).toEqual([]);
    expect(response.body?.data?.content).toContain('acknowledged');
    expect(response.body?.data?.content).toContain(`<@${discordOf(agent)}>`);
    // N4: nothing of the alert's own text is in what Discord is told.
    expect(JSON.stringify(response.body)).not.toContain('Secret customer outage');
    // The 3 s Discord allows, with a wide margin on a laptop.
    expect(response.ms).toBeLessThan(discord.INTERACTION_DEADLINE_MS);

    expect(await alertState(alertId)).toEqual({
      state: 'acknowledged',
      acked_by: agent.userId,
      acked_via: 'discord',
    });
    let event: RealtimeEvent | undefined;
    while (event === undefined && Date.now() - started < 2000) {
      event = heard.find(
        (candidate) => candidate.type === 'alert.updated' && candidate.data.alertId === alertId,
      );
      if (event === undefined) await sleep(10);
    }
    expect(event, 'the web heard within 2 s').toBeDefined();
    const audited = await owner().query<{ metadata: { via: string }; actor_id: string }>(
      `SELECT metadata, actor_id FROM audit_log WHERE action = 'alert.ack' AND target_id = $1`,
      [alertId],
    );
    expect(audited.rows).toEqual([
      { metadata: { via: 'discord', level: 0 }, actor_id: agent.userId },
    ]);
  });

  it('handles an interaction id once: a redelivery is answered "already handled" and changes nothing', async () => {
    const alertId = await addAlert();
    const id = nextId();
    const first = await press(agent, discord.customIds.alertAck(alertId), id);
    expect(first.body?.type).toBe(7);
    const again = await press(agent, discord.customIds.alertAck(alertId), id);
    expect(again.body?.data?.content).toBe('This was already handled.');
    expect(again.body?.data?.flags).toBe(discord.EPHEMERAL_FLAG);
    const audited = await owner().query(
      `SELECT 1 FROM audit_log WHERE action = 'alert.ack' AND target_id = $1`,
      [alertId],
    );
    expect(audited.rowCount).toBe(1);
  });

  it('a second person pressing later is told somebody was first, and the first stays', async () => {
    const alertId = await addAlert();
    await press(agent, discord.customIds.alertAck(alertId));
    const late = await press(lead, discord.customIds.alertAck(alertId));
    expect(late.body?.data?.content).toBe('Somebody acknowledged that alert first.');
    expect((await alertState(alertId))?.acked_by).toBe(agent.userId);
  });

  it('refuses a Discord account that is not linked to anyone, and a customer’s, and changes nothing', async () => {
    const alertId = await addAlert();
    const stranger = await send({
      id: nextId(),
      type: 3,
      member: { user: { id: nextId() } },
      data: { custom_id: discord.customIds.alertAck(alertId), component_type: 2 },
    });
    expect(stranger.body?.data?.content).toContain('not linked');
    expect(stranger.body?.data?.flags).toBe(discord.EPHEMERAL_FLAG);
    const fromCustomer = await press(customer, discord.customIds.alertAck(alertId));
    expect(fromCustomer.body?.data?.content).toContain('not linked');
    expect((await alertState(alertId))?.state).toBe('open');
    const outcomes = await owner().query<{ outcome: string }>(
      `SELECT outcome FROM discord_interaction WHERE outcome = 'refused_unlinked'`,
    );
    expect(outcomes.rowCount).toBeGreaterThanOrEqual(2);
  });

  it('a forged button, or an alert that does not exist, is refused', async () => {
    expect((await press(agent, 'alert:ack:1; DROP TABLE alert')).body?.data?.content).toBe(
      'That button is not recognised.',
    );
    expect((await press(agent, discord.customIds.alertAck(randomUUID()))).body?.data?.content).toBe(
      'That alert no longer exists.',
    );
  });

  it('/ack with the start of an alert id acknowledges that alert; an ambiguous or unknown start does not', async () => {
    const alertId = await addAlert();
    const prefix = alertId.slice(0, 12);
    const none = await command(agent, 'ack', [{ name: 'id', type: 3, value: 'abcdef12' }]);
    expect(none.body?.data?.content).toBe('No open alert starts with that.');
    const bad = await command(agent, 'ack', [{ name: 'id', type: 3, value: 'x' }]);
    expect(bad.body?.data?.content).toBe('Give the first characters of the alert id.');
    const ok = await command(agent, 'ack', [{ name: 'id', type: 3, value: prefix }]);
    expect(ok.body?.data?.content).toBe('Acknowledged.');
    expect((await alertState(alertId))?.acked_via).toBe('discord');
  });
});

describe('incident buttons and commands (R-3.13)', () => {
  async function openIncident(alertIds: string[] = []): Promise<{ id: string; key: string }> {
    const response = await agent.client.post<{ id: string; key: string }>('/v1/incidents', {
      title: 'Checkout errors',
      severity: 'SEV2',
      alertIds,
    });
    return { id: response.body.id, key: response.body.key };
  }

  it('Ack alerts acknowledges the open alerts of the incident; Assign to me makes the presser commander', async () => {
    const a = await addAlert();
    const b = await addAlert();
    const incident = await openIncident([a, b]);
    const acked = await press(lead, discord.customIds.incidentAck(incident.id));
    expect(acked.body?.data?.content).toBe('Acknowledged 2 alert(s).');
    expect((await alertState(a))?.acked_via).toBe('discord');
    expect((await alertState(b))?.state).toBe('acknowledged');
    const again = await press(lead, discord.customIds.incidentAck(incident.id));
    expect(again.body?.data?.content).toBe('No open alerts of this incident.');

    await press(lead, discord.customIds.incidentAssign(incident.id));
    const row = await owner().query<{ commander_id: string }>(
      `SELECT commander_id FROM incident WHERE id = $1`,
      [incident.id],
    );
    expect(row.rows[0]?.commander_id).toBe(lead.userId);
  });

  it('/incident status, update and resolve work for the people allowed to, and only for them', async () => {
    const incident = await openIncident();
    const sub = (name: string, options: unknown[]) => [{ name, type: 1, options }];
    const number = { name: 'number', type: 3, value: incident.key };

    const status = await command(
      agent,
      'incident',
      sub('status', [number, { name: 'value', type: 3, value: 'identified' }]),
    );
    expect(status.body?.data?.content).toBe('Status is now identified.');
    const note = await command(
      agent,
      'incident',
      sub('update', [number, { name: 'text', type: 3, value: 'Rolled back' }]),
    );
    expect(note.body?.data?.content).toBe('Note added.');
    // Resolving needs incident.manage, which an agent does not have.
    const denied = await command(agent, 'incident', sub('resolve', [number]));
    expect(denied.body?.data?.content).toContain('incident.manage');
    expect(
      (
        await owner().query<{ status: string }>(`SELECT status FROM incident WHERE id = $1`, [
          incident.id,
        ])
      ).rows[0]?.status,
    ).toBe('identified');
    const resolved = await command(lead, 'incident', sub('resolve', [number]));
    expect(resolved.body?.data?.content).toBe('Status is now resolved.');
    expect(
      (
        await command(
          lead,
          'incident',
          sub('status', [number, { name: 'value', type: 3, value: 'investigating' }]),
        )
      ).body?.data?.content,
    ).toBe('That change is not allowed now.');
    expect(
      (
        await command(
          agent,
          'incident',
          sub('status', [
            { name: 'number', type: 3, value: 'INC-999999' },
            { name: 'value', type: 3, value: 'identified' },
          ]),
        )
      ).body?.data?.content,
    ).toBe('No such incident.');
    expect(
      (
        await command(
          agent,
          'incident',
          sub('status', [{ name: 'number', type: 3, value: 'twelve' }]),
        )
      ).body?.data?.content,
    ).toBe('Give the incident as INC-12.');
  });
});
