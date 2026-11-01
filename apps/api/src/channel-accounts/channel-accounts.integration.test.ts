import { randomBytes } from 'node:crypto';

import { line } from '@watchtower/channels';
import { createDatabase } from '@watchtower/db';
import { AUDIT_ACTIONS, type ChannelAccount } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runChannelAccountsCli } from '../cli/channel-accounts-cli.js';
import { startHarness, uniqueEmail, type Harness } from '../testing/harness.js';
import { captureLogs } from '../testing/support.js';
import { signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';

// T-131: registering LINE Official Accounts and Gmail mailboxes over HTTP and from the CLI, on real
// Postgres. The channel secret is generated here at run time and goes through the credential store.
const net = disableNetConnect();
const logs = captureLogs();
const channelSecret = randomBytes(24).toString('base64');

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let ipCounter = 0;
const freshIp = (): string => `203.0.113.${String(++ipCounter % 250)}`;
const owner = () => h.db.owner.pool;
const seen: string[] = [];

async function call<T>(who: Persona, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) {
  const response = await who.client.request<T>(method, path, body === undefined ? {} : { body });
  seen.push(JSON.stringify(response.body));
  return response;
}

beforeAll(async () => {
  h = await startHarness({ logs, env: { LOG_LEVEL: 'debug' } });
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
});
afterAll(async () => {
  await h.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

async function postWebhook(path: string, raw: string) {
  const response = await fetch(`${h.base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': freshIp(),
      'x-line-signature': line.computeLineSignature(raw, channelSecret),
    },
    body: raw,
  });
  return response.status;
}

const lineEvent = () => ({
  type: 'message',
  mode: 'active',
  timestamp: Date.now(),
  webhookEventId: `01${randomBytes(12).toString('hex').toUpperCase()}`,
  deliveryContext: { isRedelivery: false },
  source: { type: 'user', userId: `Ufake${randomBytes(12).toString('hex')}` },
  replyToken: randomBytes(16).toString('hex'),
  message: { type: 'text', id: randomBytes(6).toString('hex'), text: 'hello' },
});

describe('access', () => {
  it('is for the head only: lead and agent get 403, no session gets 401, nothing is written', async () => {
    const routes: readonly [string, string, unknown][] = [
      ['GET', '/v1/admin/channel-accounts', undefined],
      ['POST', '/v1/admin/channel-accounts', { type: 'line', name: 'x' }],
      ['POST', '/v1/admin/channel-accounts/6f1b3a52-0000-4000-8000-000000000000/disable', {}],
    ];
    for (const [method, path, body] of routes) {
      for (const who of [lead, agent]) {
        const response = await who.client.request(method, path, body === undefined ? {} : { body });
        expect(response.status, `${who.session.user.role} ${method} ${path}`).toBe(403);
      }
      const anonymous = await h
        .client()
        .request(method, path, body === undefined ? {} : { body, csrf: false });
      expect(anonymous.status, `anonymous ${method} ${path}`).toBe(401);
    }
    expect(
      (await owner().query(`SELECT 1 FROM channel_account WHERE type = 'line'`)).rowCount,
    ).toBe(0);
  });
});

describe('LINE account', () => {
  let account: ChannelAccount;

  it('validates the body', async () => {
    for (const body of [
      { type: 'line' },
      { type: 'line', name: '   ' },
      { type: 'line', name: 'x', emailAddress: 'a@example.com' },
      { type: 'gmail', name: 'x' },
      { type: 'gmail', name: 'x', emailAddress: 'not-an-address' },
      { type: 'discord', name: 'x' },
    ]) {
      const response = await call<ApiErrorBody>(head, 'POST', '/v1/admin/channel-accounts', body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('creates it and returns the webhook URL; credentials are reported as not set', async () => {
    const response = await call<ChannelAccount>(head, 'POST', '/v1/admin/channel-accounts', {
      type: 'line',
      name: ' Support LINE ',
    });
    expect(response.status).toBe(201);
    account = response.body;
    expect(account).toMatchObject({
      type: 'line',
      name: 'Support LINE',
      enabled: true,
      disabledAt: null,
      emailAddress: null,
      credentials: 'not_configured',
    });
    expect(account.webhookUrl).toBe(
      `${h.config.API_URL.replace(/\/$/, '')}/v1/inbound/line/${account.id}`,
    );
    expect(account.notes.join(' ')).toContain('save them under integrations');
    const audit = await owner().query<{ metadata: unknown; target_id: string; actor_id: string }>(
      `SELECT metadata, target_id, actor_id FROM audit_log WHERE action = $1 AND target_id = $2`,
      [AUDIT_ACTIONS.channelAccountCreate, account.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      target_id: account.id,
      actor_id: head.session.user.id,
      metadata: { type: 'line' },
    });
  });

  it('refuses a second active LINE account with 409 and says why; nothing is created', async () => {
    const response = await call<ApiErrorBody>(head, 'POST', '/v1/admin/channel-accounts', {
      type: 'line',
      name: 'Second',
    });
    expect(response.status).toBe(409);
    expect(response.body.message).toContain('one LINE channel secret');
    const rows = await owner().query(`SELECT 1 FROM channel_account WHERE type = 'line'`);
    expect(rows.rowCount).toBe(1);
  });

  it('two simultaneous requests create exactly one more only if none is active (race)', async () => {
    await call(head, 'POST', `/v1/admin/channel-accounts/${account.id}/disable`);
    const results = await Promise.all(
      ['A', 'B', 'C'].map((name) =>
        call<ChannelAccount | ApiErrorBody>(head, 'POST', '/v1/admin/channel-accounts', {
          type: 'line',
          name,
        }),
      ),
    );
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(results.filter((result) => result.status === 409)).toHaveLength(2);
    // Put the first state back for the next tests: disable the winner, re-create nothing.
    const winner = results.find((result) => result.status === 201)?.body as ChannelAccount;
    await call(head, 'POST', `/v1/admin/channel-accounts/${winner.id}/disable`);
  });

  it('receives a signed webhook at the URL, until it is disabled', async () => {
    // A fresh account: the earlier ones are all disabled by now.
    const created = await call<ChannelAccount>(head, 'POST', '/v1/admin/channel-accounts', {
      type: 'line',
      name: 'Live one',
    });
    expect(created.status).toBe(201);
    const path = new URL(created.body.webhookUrl ?? '').pathname;
    const put = await call(head, 'PUT', '/v1/admin/integrations/line', {
      fields: { channelSecret },
    });
    expect(put.status).toBe(200);
    const raw = JSON.stringify({ destination: 'Ubot', events: [lineEvent()] });
    expect(await postWebhook(path, raw)).toBe(200);

    const listed = await call<{ items: ChannelAccount[] }>(
      head,
      'GET',
      '/v1/admin/channel-accounts',
    );
    expect(listed.body.items.find((item) => item.id === created.body.id)?.credentials).toBe(
      'partial',
    );

    const disabled = await call<ChannelAccount>(
      head,
      'POST',
      `/v1/admin/channel-accounts/${created.body.id}/disable`,
    );
    expect(disabled.status).toBe(200);
    expect(disabled.body).toMatchObject({ enabled: false });
    expect(disabled.body.disabledAt).not.toBeNull();
    // Same answer as an unknown account: nothing is learned about which ones exist.
    expect(await postWebhook(path, raw)).toBe(401);
  });

  it('disable is idempotent and audited with the change flag; unknown id is 404; portal is refused', async () => {
    const [portal] = (
      await owner().query<{ id: string }>(`SELECT id FROM channel_account WHERE type = 'portal'`)
    ).rows;
    const refused = await call<ApiErrorBody>(
      head,
      'POST',
      `/v1/admin/channel-accounts/${portal?.id ?? ''}/disable`,
    );
    expect(refused.status).toBe(400);
    expect(
      (
        await call<ApiErrorBody>(
          head,
          'POST',
          '/v1/admin/channel-accounts/6f1b3a52-0000-4000-8000-000000000000/disable',
        )
      ).status,
    ).toBe(404);
    expect(
      (await owner().query(`SELECT disabled_at FROM channel_account WHERE id = $1`, [portal?.id]))
        .rows[0],
    ).toEqual({ disabled_at: null });

    const again = await call<ChannelAccount>(
      head,
      'POST',
      `/v1/admin/channel-accounts/${account.id}/disable`,
    );
    expect(again.status).toBe(200);
    const rows = await owner().query<{ metadata: { changed: boolean } }>(
      `SELECT metadata FROM audit_log WHERE action = $1 AND target_id = $2 ORDER BY created_at`,
      [AUDIT_ACTIONS.channelAccountDisable, account.id],
    );
    expect(rows.rows.map((row) => row.metadata.changed)).toEqual([true, false]);
  });
});

describe('Gmail mailbox', () => {
  it('registers several mailboxes, lower-cases the address and refuses a repeat', async () => {
    const first = uniqueEmail('Shared');
    const created = await call<ChannelAccount>(head, 'POST', '/v1/admin/channel-accounts', {
      type: 'gmail',
      name: 'Support mailbox',
      emailAddress: ` ${first.toUpperCase()} `,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      type: 'gmail',
      emailAddress: first.toLowerCase(),
      webhookUrl: null,
      enabled: true,
    });
    const state = await owner().query(
      `SELECT enabled, history_id FROM gmail_account_state WHERE channel_account_id = $1`,
      [created.body.id],
    );
    expect(state.rows[0]).toEqual({ enabled: true, history_id: null });

    const second = await call<ChannelAccount>(head, 'POST', '/v1/admin/channel-accounts', {
      type: 'gmail',
      name: 'Billing mailbox',
      emailAddress: uniqueEmail('billing'),
    });
    expect(second.status).toBe(201);

    const repeat = await call<ApiErrorBody>(head, 'POST', '/v1/admin/channel-accounts', {
      type: 'gmail',
      name: 'Again',
      emailAddress: first.toLowerCase(),
    });
    expect(repeat.status).toBe(409);
    // The failed attempt left no half-made account behind.
    const count = await owner().query(`SELECT 1 FROM channel_account WHERE name = 'Again'`);
    expect(count.rowCount).toBe(0);

    // The mailbox address is not written to the audit log.
    const audit = await owner().query<{ metadata: unknown }>(
      `SELECT metadata::text AS metadata FROM audit_log WHERE action = $1`,
      [AUDIT_ACTIONS.channelAccountCreate],
    );
    expect(JSON.stringify(audit.rows)).not.toContain(first.toLowerCase());
  });

  it('disable stops the mailbox: state.enabled is false and the account stays listed', async () => {
    const created = await call<ChannelAccount>(head, 'POST', '/v1/admin/channel-accounts', {
      type: 'gmail',
      name: 'Old',
      emailAddress: uniqueEmail('old'),
    });
    const disabled = await call<ChannelAccount>(
      head,
      'POST',
      `/v1/admin/channel-accounts/${created.body.id}/disable`,
    );
    expect(disabled.body.enabled).toBe(false);
    const state = await owner().query(
      `SELECT enabled FROM gmail_account_state WHERE channel_account_id = $1`,
      [created.body.id],
    );
    expect(state.rows[0]).toEqual({ enabled: false });
    const listed = await call<{ items: ChannelAccount[] }>(
      head,
      'GET',
      '/v1/admin/channel-accounts',
    );
    expect(listed.body.items.find((item) => item.id === created.body.id)?.enabled).toBe(false);
    // The portal account is not offered here.
    expect(listed.body.items.map((item) => item.type as string)).not.toContain('portal');
  });
});

describe('CLI', () => {
  const lines: string[] = [];
  const errors: string[] = [];
  const io = { out: (l: string) => lines.push(l), err: (l: string) => errors.push(l) };

  async function run(argv: string[]): Promise<number> {
    lines.length = 0;
    errors.length = 0;
    const database = createDatabase({ url: h.config.DATABASE_URL, max: 2 });
    try {
      return await runChannelAccountsCli(argv, h.config, database, io);
    } finally {
      await database.close();
    }
  }

  it('creates, lists and disables, prints the webhook URL, audits as the system', async () => {
    // The HTTP tests left no active LINE account (every one was disabled).
    expect(await run(['create', 'line', '--name', 'CLI LINE'])).toBe(0);
    const output = lines.join('\n');
    expect(output).toMatch(/\/v1\/inbound\/line\/[0-9a-f-]{36}/);
    const id = /([0-9a-f-]{36}) {2}line/.exec(output)?.[1] ?? '';

    expect(await run(['create', 'line', '--name', 'CLI LINE 2'])).toBe(1);
    expect(errors.join(' ')).toContain('one LINE channel secret');

    expect(await run(['list'])).toBe(0);
    expect(lines.join('\n')).toContain('CLI LINE');

    expect(await run(['create', 'gmail', '--name', 'CLI box', '--email', 'Cli@Example.com'])).toBe(
      0,
    );
    expect(lines.join('\n')).toContain('mailbox: cli@example.com');
    expect(await run(['create', 'gmail', '--name', 'dup', '--email', 'cli@example.com'])).toBe(1);

    expect(await run(['disable', id])).toBe(0);
    expect(lines[0]).toBe('disabled');
    expect(await run(['disable', id])).toBe(0);
    expect(lines[0]).toBe('already disabled');

    const audit = await owner().query<{ actor_type: string; actor_id: string }>(
      `SELECT actor_type, actor_id FROM audit_log WHERE actor_id = 'channel-accounts-cli' ORDER BY created_at`,
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(4);
    expect(audit.rows[0]).toEqual({ actor_type: 'system', actor_id: 'channel-accounts-cli' });
  });

  it('refuses bad usage with exit 2 and does not echo the input', async () => {
    for (const argv of [
      [],
      ['create'],
      ['create', 'line'],
      ['create', 'line', '--name'],
      ['create', 'line', '--name', 'x', '--email', 'a@example.com'],
      ['create', 'gmail', '--name', 'x', '--email', 'secret-looking-not-an-address'],
      ['disable', 'not-a-uuid'],
      ['frobnicate'],
    ]) {
      expect(await run(argv), argv.join(' ')).toBe(2);
    }
    expect(errors.join(' ')).not.toContain('secret-looking-not-an-address');
  });
});

describe('no secret leaves', () => {
  it('no response or log contains the channel secret', () => {
    for (const body of seen) expect(body).not.toContain(channelSecret);
    expect(logs.raw()).not.toContain(channelSecret);
  });
});
