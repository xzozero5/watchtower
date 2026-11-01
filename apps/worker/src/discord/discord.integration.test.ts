import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import { discord, type FetchLike } from '@watchtower/channels';
import { createDatabase, createCredentialStore, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { createDomain, createPolicyGate, type Domain } from '@watchtower/domain';
import {
  DEFAULT_DISCORD_CHANNEL_MAP,
  pickCredentialEnv,
  type DiscordChannelMap,
  type DiscordWebhookSlot,
} from '@watchtower/shared';
import { localKmsFromConfig } from '@watchtower/shared/credential-box';
import { disableNetConnect } from '@watchtower/shared/testing';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import {
  DiscordRetryError,
  createDiscordNotifier,
  createDiscordProcessor,
  type DiscordNotifier,
  type DiscordOverrides,
} from './index.js';

// The Discord notifier against the real database (restricted application role). A scripted `fetch`
// stands in for discord.com; disableNetConnect allows loopback only, so a real call would fail loudly.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const net = disableNetConnect();

let testDb: TestDatabase;
let database: Database;
let domain: Domain;
let orgId: string;
const owner = () => testDb.owner.db;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  database = createDatabase({ url: testDb.appUrl, max: 4, applicationName: 'wt-discord-test' });
  domain = createDomain({
    ticketKeyPrefix: 'OPS',
    sealKey: randomBytes(32),
    portalUrl: 'https://desk.example.test/portal',
    policyGate: createPolicyGate({ db: database.db }),
  });
  const [org] = await owner()
    .insert(schema.organization)
    .values({ name: `Org ${randomUUID()}` })
    .returning({ id: schema.organization.id });
  orgId = org?.id ?? '';
});

afterAll(async () => {
  await database.close();
  await testDb.cleanup();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

// --- helpers -------------------------------------------------------------------------------------

function webhookFor() {
  const id = `1${randomBytes(6).readUIntBE(0, 6).toString().padStart(16, '0')}`;
  const token = randomBytes(34).toString('base64url');
  return { id, token, url: `https://discord.com/api/webhooks/${id}/${token}` };
}

type Step = Response | Error;
const created = () =>
  new Response(JSON.stringify({ id: '9876543210987654321' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const status = (code: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ message: 'x' }), {
    status: code,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** A `fetch` that plays the given answers in order and records every request. */
function scripted(steps: Step[] = []) {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const queue = [...steps];
  const fetch: FetchLike = (url, init) => {
    requests.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const step = queue.shift() ?? created();
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
  };
  return { fetch, requests };
}

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { lines, logger: createLogger(testConfig({ LOG_LEVEL: 'debug' }), stream) };
}

async function addTicket(priority: 'P1' | 'P2' | 'P3' | 'P4' = 'P3'): Promise<string> {
  const [account] = await owner()
    .select({ id: schema.channelAccount.id })
    .from(schema.channelAccount)
    .where(eq(schema.channelAccount.type, 'portal'));
  const [ticket] = await owner()
    .insert(schema.ticket)
    .values({
      subject: 'A subject the customer wrote',
      orgId,
      channel: 'portal',
      channelAccountId: account?.id ?? '',
      priority,
    })
    .returning({ id: schema.ticket.id });
  return ticket?.id ?? '';
}

interface Setup {
  readonly urls?: Partial<Record<DiscordWebhookSlot, string>>;
  readonly steps?: Step[];
  readonly map?: DiscordChannelMap;
  readonly production?: boolean;
  readonly overrides?: DiscordOverrides;
}

function build(setup: Setup = {}) {
  const fetchStub = scripted(setup.steps);
  const log = capture();
  const notifier = createDiscordNotifier({
    database,
    logger: log.logger,
    channelMap: setup.map ?? DEFAULT_DISCORD_CHANNEL_MAP,
    ticketKeyPrefix: 'OPS',
    appUrl: 'https://desk.example.test',
    isProduction: setup.production ?? false,
    credentials: undefined,
    overrides: {
      webhookUrls: () => Promise.resolve(setup.urls ?? {}),
      fetch: fetchStub.fetch,
      ...setup.overrides,
    },
  });
  return { notifier, ...fetchStub, log };
}

const notice = (ticketId: string) => ({ event: 'ticket.created', ticketId }) as const;

async function rows(ticketId: string) {
  return owner()
    .select()
    .from(schema.discordNotification)
    .where(eq(schema.discordNotification.ticketId, ticketId));
}

const twoSlots: DiscordChannelMap = {
  routes: [
    { name: 'all', slot: 'default' },
    { name: 'hot', slot: 'urgent', minPriority: 'P2' },
  ],
};

// --- tests ---------------------------------------------------------------------------------------

describe('mock mode (nothing configured)', () => {
  it('records the notice as mock, never as sent, and says so', async () => {
    const { notifier, requests, log } = build();
    const ticketId = await addTicket();
    const result = await notifier.notify(notice(ticketId), { final: false });
    expect(result).toMatchObject({ status: 'processed', mode: 'mock' });
    expect(result.slots).toEqual([{ slot: 'default', state: 'mock' }]);

    const [row] = await rows(ticketId);
    expect(row).toMatchObject({ state: 'mock', slot: 'default', attempts: 1, sentAt: null });
    expect(row?.providerMessageId).toBeNull();
    expect(requests).toHaveLength(0);
    expect(notifier.mockTransport.sent).toHaveLength(1);
    expect(log.lines.join('')).toContain('MOCK');
    expect(log.lines.join('')).toContain('NOT delivered');
  });

  it('is loud in production: a warning that nothing is delivered', async () => {
    const { notifier, log } = build({ production: true });
    await notifier.notify(notice(await addTicket()), { final: false });
    const warning = log.lines.map((line) => JSON.parse(line) as { level: string; msg: string });
    expect(
      warning.some((entry) => entry.level === 'warn' && entry.msg.includes('MOCK in production')),
    ).toBe(true);
  });

  it('does not post a second time for the same ticket', async () => {
    const { notifier } = build();
    const ticketId = await addTicket();
    await notifier.notify(notice(ticketId), { final: false });
    const again = await notifier.notify(notice(ticketId), { final: false });
    expect(again.slots).toEqual([{ slot: 'default', state: 'already', was: 'mock' }]);
    expect(notifier.mockTransport.sent).toHaveLength(1);
    expect(await rows(ticketId)).toHaveLength(1);
  });

  it('carries the ticket key, priority and a link, and nothing the customer wrote', async () => {
    const { notifier } = build();
    const ticketId = await addTicket('P2');
    await notifier.notify(notice(ticketId), { final: false });
    const posted = JSON.stringify(notifier.mockTransport.sent.at(-1)?.payload);
    expect(posted).toContain('"allowed_mentions":{"parse":[]}');
    expect(posted).toMatch(/New ticket OPS-\d+/);
    expect(posted).toContain('P2 (high)');
    expect(posted).toContain('https://desk.example.test/tickets/OPS-');
    expect(posted).not.toContain('A subject the customer wrote');
    expect(posted).not.toContain(orgId);
  });
});

describe('live mode (a webhook is configured)', () => {
  it('posts to discord.com and records sent with a delivery time only when Discord accepted it', async () => {
    const hook = webhookFor();
    const { notifier, requests } = build({ urls: { default: hook.url } });
    const ticketId = await addTicket();
    const result = await notifier.notify(notice(ticketId), { final: false });
    expect(result.mode).toBe('live');
    expect(result.slots).toEqual([{ slot: 'default', state: 'sent' }]);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]?.url ?? '').hostname).toBe('discord.com');
    expect(requests[0]?.url).toContain(`/webhooks/${hook.id}/`);
    const [row] = await rows(ticketId);
    expect(row).toMatchObject({ state: 'sent', providerMessageId: '9876543210987654321' });
    expect(row?.sentAt).toBeInstanceOf(Date);
    expect(notifier.mockTransport.sent).toHaveLength(0);

    // A repeat (a duplicate job, a late retry) posts nothing.
    await notifier.notify(notice(ticketId), { final: false });
    expect(requests).toHaveLength(1);
  });

  it('never writes the webhook URL or token to the log or the ledger', async () => {
    const hook = webhookFor();
    const { notifier, log } = build({ urls: { default: hook.url }, steps: [status(500)] });
    const ticketId = await addTicket();
    await notifier.notify(notice(ticketId), { final: true });
    const everything = JSON.stringify({ lines: log.lines, rows: await rows(ticketId) });
    expect(everything).not.toContain(hook.token);
    expect(everything).not.toContain(hook.url);
  });

  it('fans out by the channel map: priority P2 reaches both slots, P4 only the default', async () => {
    const [a, b] = [webhookFor(), webhookFor()];
    const { notifier, requests } = build({
      urls: { default: a.url, urgent: b.url },
      map: twoSlots,
    });
    const hot = await addTicket('P2');
    const calm = await addTicket('P4');
    const first = await notifier.notify(notice(hot), { final: false });
    expect(first.slots.map((slot) => `${slot.slot}:${slot.state}`)).toEqual([
      'default:sent',
      'urgent:sent',
    ]);
    const second = await notifier.notify(notice(calm), { final: false });
    expect(second.slots.map((slot) => `${slot.slot}:${slot.state}`)).toEqual(['default:sent']);
    expect(requests.map((request) => request.url.split('/')[5])).toEqual([a.id, b.id, a.id]);
  });

  it('skips a slot that has no webhook, loudly, while the configured slot is delivered', async () => {
    const { notifier, requests, log } = build({
      urls: { default: webhookFor().url },
      map: twoSlots,
    });
    const ticketId = await addTicket('P1');
    const result = await notifier.notify(notice(ticketId), { final: false });
    expect(result.slots).toEqual([
      { slot: 'default', state: 'sent' },
      { slot: 'urgent', state: 'skipped' },
    ]);
    expect(requests).toHaveLength(1);
    const skipped = (await rows(ticketId)).find((row) => row.slot === 'urgent');
    expect(skipped).toMatchObject({
      state: 'skipped',
      errorCode: 'slot_not_configured',
      sentAt: null,
    });
    expect(log.lines.join('')).toContain('slot_not_configured');
  });

  it('fails, without any request, when the configured URL is not a discord.com webhook (SSRF)', async () => {
    const { notifier, requests, log } = build({
      urls: {
        default:
          'https://internal.example.test/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz',
      },
    });
    const ticketId = await addTicket();
    const result = await notifier.notify(notice(ticketId), { final: false });
    expect(result.mode).toBe('live');
    expect(result.slots).toEqual([{ slot: 'default', state: 'failed' }]);
    expect(requests).toHaveLength(0);
    expect((await rows(ticketId))[0]).toMatchObject({
      state: 'failed',
      errorCode: 'invalid_webhook_url',
    });
    expect(log.lines.join('')).not.toContain('internal.example.test');
  });
});

describe('failures', () => {
  it('keeps a rate-limited post pending and does not post the finished slot again on retry', async () => {
    const [a, b] = [webhookFor(), webhookFor()];
    // default ok; urgent: 429 asking for 90 s (too long to wait in the call), then ok on the retry.
    // The transport has a clock the test moves, so the 90 s can pass without waiting.
    const stub = scripted([created(), status(429, { 'retry-after': '90' }), created()]);
    const clock = { now: 1_000_000 };
    const { notifier } = build({
      urls: { default: a.url, urgent: b.url },
      map: twoSlots,
      overrides: {
        liveTransport: new discord.LiveDiscordTransport({
          fetch: stub.fetch,
          http: { now: () => clock.now, sleep: () => Promise.resolve() },
        }),
      },
    });
    const requests = stub.requests;
    const ticketId = await addTicket('P1');
    const first = await notifier.notify(notice(ticketId), { final: false });
    expect(first.slots).toEqual([
      { slot: 'default', state: 'sent' },
      { slot: 'urgent', state: 'pending', retryAfterMs: 90_000 },
    ]);
    expect(await rows(ticketId)).toHaveLength(2);
    expect((await rows(ticketId)).find((row) => row.slot === 'urgent')).toMatchObject({
      state: 'pending',
      errorCode: 'rate_limited',
      attempts: 1,
    });

    // Still inside the 90 s: the transport remembers the limit and does not even ask.
    const early = await notifier.notify(notice(ticketId), { final: false });
    expect(early.slots[1]).toMatchObject({ slot: 'urgent', state: 'pending' });
    expect(requests).toHaveLength(2);

    clock.now += 91_000;
    const second = await notifier.notify(notice(ticketId), { final: false });
    expect(second.slots).toEqual([
      { slot: 'default', state: 'already', was: 'sent' },
      { slot: 'urgent', state: 'sent' },
    ]);
    // default was posted once, urgent twice (one refused): three requests, not four.
    expect(requests.map((request) => request.url.split('/')[5])).toEqual([a.id, b.id, b.id]);
  });

  it('settles an exhausted retry as failed and says the outcome is unknown after a 5xx', async () => {
    const { notifier } = build({ urls: { default: webhookFor().url }, steps: [status(502)] });
    const ticketId = await addTicket();
    const result = await notifier.notify(notice(ticketId), { final: true });
    expect(result.slots).toEqual([{ slot: 'default', state: 'failed' }]);
    expect((await rows(ticketId))[0]).toMatchObject({
      state: 'failed',
      errorCode: 'server',
      outcomeUnknown: true,
      sentAt: null,
    });
  });

  it('a deleted webhook (404) fails at once and is not retried', async () => {
    const { notifier } = build({ urls: { default: webhookFor().url }, steps: [status(404)] });
    const ticketId = await addTicket();
    const result = await notifier.notify(notice(ticketId), { final: false });
    expect(result.slots).toEqual([{ slot: 'default', state: 'failed' }]);
    expect((await rows(ticketId))[0]).toMatchObject({ state: 'failed', errorCode: 'webhook_gone' });
  });

  it('does nothing for a ticket that is gone or that no route selects', async () => {
    const { notifier, requests } = build({
      urls: { default: webhookFor().url },
      map: { routes: [{ name: 'p1-only', slot: 'default', minPriority: 'P1' }] },
    });
    expect(await notifier.notify(notice(randomUUID()), { final: false })).toMatchObject({
      status: 'ticket_missing',
    });
    const ticketId = await addTicket('P3');
    expect(await notifier.notify(notice(ticketId), { final: false })).toMatchObject({
      status: 'no_route',
    });
    expect(await rows(ticketId)).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });
});

describe('credential store (ADR-004, ADR-012)', () => {
  function storeWith(env: Record<string, string | undefined>) {
    const config = testConfig(env);
    return createCredentialStore({
      database,
      kms: localKmsFromConfig(config),
      env: pickCredentialEnv(config),
    });
  }

  function notifierWith(
    env: Record<string, string | undefined>,
    fetchStub: ReturnType<typeof scripted>,
  ) {
    return createDiscordNotifier({
      database,
      logger: capture().logger,
      channelMap: DEFAULT_DISCORD_CHANNEL_MAP,
      ticketKeyPrefix: 'OPS',
      appUrl: 'https://desk.example.test',
      isProduction: false,
      credentials: storeWith(env),
      overrides: { fetch: fetchStub.fetch },
    });
  }

  it('is mock with an empty store, live with an encrypted database value, and the environment wins', async () => {
    const empty = scripted();
    const mockNotifier = notifierWith({}, empty);
    expect((await mockNotifier.notify(notice(await addTicket()), { final: false })).mode).toBe(
      'mock',
    );
    expect(empty.requests).toHaveLength(0);

    const stored = webhookFor();
    await storeWith({}).put('discord', { webhookUrl: stored.url }, null);
    const dbFetch = scripted();
    const dbResult = await notifierWith({}, dbFetch).notify(notice(await addTicket()), {
      final: false,
    });
    expect(dbResult).toMatchObject({ mode: 'live', slots: [{ slot: 'default', state: 'sent' }] });
    expect(dbFetch.requests[0]?.url).toContain(`/webhooks/${stored.id}/`);

    const fromEnv = webhookFor();
    const envFetch = scripted();
    await notifierWith({ DISCORD_WEBHOOK_URL: fromEnv.url }, envFetch).notify(
      notice(await addTicket()),
      { final: false },
    );
    expect(envFetch.requests[0]?.url).toContain(`/webhooks/${fromEnv.id}/`);
    await storeWith({}).remove('discord', 'webhookUrl');
  });
});

describe('processor', () => {
  const job = (data: unknown, attemptsMade = 0, attempts = 5) =>
    ({ name: 'notify', data, attemptsMade, opts: { attempts } }) as unknown as Job;
  const run = (notifier: DiscordNotifier, ...args: Parameters<typeof job>) =>
    createDiscordProcessor({ notifier })(job(...args));

  it('rejects a payload with extra meaning missing, and an unknown job name, without retrying', async () => {
    const { notifier } = build();
    await expect(run(notifier, { event: 'ticket.created' })).rejects.toMatchObject({
      name: 'UnrecoverableError',
    });
    await expect(
      createDiscordProcessor({ notifier })({ name: 'other', data: {} } as unknown as Job),
    ).rejects.toMatchObject({ name: 'UnrecoverableError' });
  });

  it('fails the job (so the queue retries) while a post is still owed, and completes on the last attempt', async () => {
    const { notifier } = build({
      urls: { default: webhookFor().url },
      steps: [status(429, { 'retry-after': '90' }), status(429, { 'retry-after': '90' })],
    });
    const ticketId = await addTicket();
    await expect(run(notifier, notice(ticketId), 0, 5)).rejects.toBeInstanceOf(DiscordRetryError);
    // Attempt 5 of 5: the row is settled as failed and the job ends.
    await expect(run(notifier, notice(ticketId), 4, 5)).resolves.toMatchObject({
      status: 'processed',
      slots: ['default:failed'],
    });
    expect((await rows(ticketId))[0]).toMatchObject({
      state: 'failed',
      // The first attempt was refused by Discord; this one was refused locally, inside the 90 s it asked for.
      errorCode: 'bucket_exhausted',
    });
  });

  it('works from what the domain queued when a ticket is created', async () => {
    const created = await domain.context({ actor: { type: 'system', id: null } });
    const { value } = await database.db.transaction((tx) =>
      domain.tickets.create(tx, created, { orgId, subject: 'Hello', body: 'Body text' }),
    );
    const [queued] = await owner()
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.jobId, `discord-ticket-created-${value.ticket.id}`));
    expect(queued).toMatchObject({ queue: 'discord', jobName: 'notify' });

    const { notifier } = build();
    const outcome = await run(notifier, queued?.payload);
    expect(outcome).toMatchObject({ status: 'processed', mode: 'mock', slots: ['default:mock'] });
    expect((await rows(value.ticket.id))[0]?.state).toBe('mock');
  });
});
