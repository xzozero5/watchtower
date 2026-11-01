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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import {
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

// The sweep looks at every owed row, so each case starts with an empty ledger.
beforeEach(async () => {
  await owner().delete(schema.discordNotification);
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
    requests.push({
      url,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >,
    });
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
    const result = await notifier.notify(notice(ticketId));
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

  it('is loud in production: a warning on every mock post, not once per process (F-1)', async () => {
    const { notifier, log } = build({ production: true });
    await notifier.notify(notice(await addTicket()));
    await notifier.notify(notice(await addTicket()));
    const entries = log.lines.map((line) => JSON.parse(line) as { level: string; msg: string });
    const warnings = entries.filter(
      (entry) => entry.level === 'warn' && entry.msg.includes('NOT delivered'),
    );
    expect(warnings).toHaveLength(2);
  });

  it('does not post a second time for the same ticket', async () => {
    const { notifier } = build();
    const ticketId = await addTicket();
    await notifier.notify(notice(ticketId));
    const again = await notifier.notify(notice(ticketId));
    expect(again.slots).toEqual([{ slot: 'default', state: 'already', was: 'mock' }]);
    expect(notifier.mockTransport.sent).toHaveLength(1);
    expect(await rows(ticketId)).toHaveLength(1);
  });

  it('carries the ticket key, priority and a link, and nothing the customer wrote', async () => {
    const { notifier } = build();
    const ticketId = await addTicket('P2');
    await notifier.notify(notice(ticketId));
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
    const result = await notifier.notify(notice(ticketId));
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
    await notifier.notify(notice(ticketId));
    expect(requests).toHaveLength(1);
  });

  it('never writes the webhook URL or token to the log or the ledger', async () => {
    const hook = webhookFor();
    const { notifier, log } = build({ urls: { default: hook.url }, steps: [status(500)] });
    const ticketId = await addTicket();
    await notifier.notify(notice(ticketId));
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
    const first = await notifier.notify(notice(hot));
    expect(first.slots.map((slot) => `${slot.slot}:${slot.state}`)).toEqual([
      'default:sent',
      'urgent:sent',
    ]);
    const second = await notifier.notify(notice(calm));
    expect(second.slots.map((slot) => `${slot.slot}:${slot.state}`)).toEqual(['default:sent']);
    expect(requests.map((request) => request.url.split('/')[5])).toEqual([a.id, b.id, a.id]);
  });

  it('skips a slot that has no webhook, loudly, while the configured slot is delivered', async () => {
    const { notifier, requests, log } = build({
      urls: { default: webhookFor().url },
      map: twoSlots,
    });
    const ticketId = await addTicket('P1');
    const result = await notifier.notify(notice(ticketId));
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
    const result = await notifier.notify(notice(ticketId));
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

/** A notifier whose clock and transport clock are the same variable, so waits pass without waiting. */
function withClock(setup: Setup, steps: Step[]) {
  const clock = { now: Date.now() + 5000 };
  const stub = scripted(steps);
  const built = build({
    ...setup,
    overrides: {
      now: () => new Date(clock.now),
      liveTransport: new discord.LiveDiscordTransport({
        fetch: stub.fetch,
        http: { now: () => clock.now, sleep: () => Promise.resolve() },
      }),
      ...setup.overrides,
    },
  });
  return { ...built, clock, requests: stub.requests };
}

/** A ledger row the way a failed attempt leaves it. */
async function owe(
  ticketId: string,
  extra: Partial<typeof schema.discordNotification.$inferInsert> = {},
) {
  await owner()
    .insert(schema.discordNotification)
    .values({
      dedupeKey: `ticket.created:${ticketId}:default`,
      event: 'ticket.created',
      ticketId,
      slot: 'default',
      nextAttemptAt: new Date(Date.now() - 1000),
      ...extra,
    });
}

describe('failures and retries', () => {
  it('keeps a rate-limited post pending until Retry-After has passed, and never posts the finished slot again (F-2)', async () => {
    const [a, b] = [webhookFor(), webhookFor()];
    // default ok; urgent: 429 asking for 90 s (too long to wait in the call), then ok on the retry.
    const { notifier, clock, requests } = withClock(
      { urls: { default: a.url, urgent: b.url }, map: twoSlots },
      [created(), status(429, { 'retry-after': '90' }), created()],
    );
    const ticketId = await addTicket('P1');
    const first = await notifier.notify(notice(ticketId));
    expect(first.slots[0]).toEqual({ slot: 'default', state: 'sent' });
    expect(first.slots[1]).toMatchObject({ slot: 'urgent', state: 'pending' });
    const urgent = (await rows(ticketId)).find((row) => row.slot === 'urgent');
    expect(urgent).toMatchObject({ state: 'pending', errorCode: 'rate_limited', attempts: 1 });
    // The time the row is next due includes what Discord asked for.
    expect(urgent?.nextAttemptAt.getTime()).toBe(clock.now + 90_000);
    expect(urgent?.outcomeUnknown).toBe(false);

    // Not due yet: nothing is sent, not even a question to Discord.
    clock.now += 1000;
    const early = await notifier.notify(notice(ticketId));
    expect(early.slots[1]).toMatchObject({ slot: 'urgent', state: 'pending' });
    expect(requests).toHaveLength(2);

    clock.now += 91_000;
    const second = await notifier.notify(notice(ticketId));
    expect(second.slots).toEqual([
      { slot: 'default', state: 'already', was: 'sent' },
      { slot: 'urgent', state: 'sent' },
    ]);
    expect(requests.map((request) => request.url.split('/')[5])).toEqual([a.id, b.id, b.id]);
  });

  it('an unknown outcome (5xx) is retried once, then given up: at most two posts per slot (F-3)', async () => {
    const { notifier, clock, requests } = withClock({ urls: { default: webhookFor().url } }, [
      status(502),
      status(502),
      status(502),
    ]);
    const ticketId = await addTicket();
    const first = await notifier.notify(notice(ticketId));
    expect(first.slots[0]).toMatchObject({ state: 'pending' });
    expect((await rows(ticketId))[0]).toMatchObject({ state: 'pending', outcomeUnknown: true });

    clock.now += 10 * 60 * 1000;
    const second = await notifier.notify(notice(ticketId));
    expect(second.slots).toEqual([{ slot: 'default', state: 'failed' }]);
    expect((await rows(ticketId))[0]).toMatchObject({
      state: 'failed',
      errorCode: 'outcome_unknown',
      outcomeUnknown: true,
      sentAt: null,
    });
    // A later attempt (a duplicate job, the sweep) posts nothing more.
    clock.now += 10 * 60 * 1000;
    await notifier.notify(notice(ticketId));
    await notifier.sweep();
    expect(requests).toHaveLength(2);
  });

  it('the row is claimed before the post is made (F-3)', async () => {
    const ticketId = await addTicket();
    let seen: { state: string; claimed: boolean; attempts: number } | undefined;
    const spy: discord.DiscordTransport = {
      kind: 'live',
      execute: async () => {
        const [row] = await rows(ticketId);
        seen = {
          state: row?.state ?? '',
          claimed: row?.claimedAt != null,
          attempts: row?.attempts ?? 0,
        };
        return { delivered: true, messageId: '1' };
      },
    };
    const { notifier } = build({
      urls: { default: webhookFor().url },
      overrides: { liveTransport: spy },
    });
    await notifier.notify(notice(ticketId));
    expect(seen).toEqual({ state: 'sending', claimed: true, attempts: 1 });
    expect((await rows(ticketId))[0]).toMatchObject({ state: 'sent', claimedAt: null });
  });

  it('a claim whose worker died is an unknown outcome: posted once more, then failed, never silently "sent" (F-3)', async () => {
    const { notifier, requests } = build({
      urls: { default: webhookFor().url },
      overrides: { claimLeaseMs: 0 },
    });
    const ticketId = await addTicket();
    const dead = new Date(Date.now() - 60_000);
    await owe(ticketId, { state: 'sending', claimedAt: dead, attempts: 1 });

    const first = await notifier.sweep();
    expect(first.recovered).toBe(1);
    // Recovered as "may have been posted", and re-driven in the same pass: that is the one repost.
    expect((await rows(ticketId))[0]).toMatchObject({ state: 'sent', outcomeUnknown: true });
    expect(requests).toHaveLength(1);

    // The same worker dying again after that repost: now it is given up, and nothing more is posted.
    await owner()
      .update(schema.discordNotification)
      .set({ state: 'sending', claimedAt: dead, sentAt: null, providerMessageId: null })
      .where(eq(schema.discordNotification.ticketId, ticketId));
    const second = await notifier.sweep();
    expect(second.recovered).toBe(1);
    expect((await rows(ticketId))[0]).toMatchObject({
      state: 'failed',
      errorCode: 'outcome_unknown',
      outcomeUnknown: true,
    });
    expect(requests).toHaveLength(1);
  });

  it('outcome_unknown is never reset by a later known answer (F-4)', async () => {
    const { notifier, clock } = withClock({ urls: { default: webhookFor().url } }, [
      status(502),
      status(429, { 'retry-after': '30' }),
      created(),
    ]);
    const ticketId = await addTicket();
    await notifier.notify(notice(ticketId)); // 502: unknown
    clock.now += 60_000;
    await notifier.notify(notice(ticketId)); // 429: refused, not processed
    expect((await rows(ticketId))[0]).toMatchObject({ state: 'pending', outcomeUnknown: true });
    clock.now += 60_000;
    await notifier.notify(notice(ticketId)); // accepted
    expect((await rows(ticketId))[0]).toMatchObject({ state: 'sent', outcomeUnknown: true });
  });

  it('a database error after a successful post never turns it into a failure (F-4)', async () => {
    const hiccup = { updates: 0, failOn: new Set<number>() };
    const flaky = new Proxy(database.db, {
      get(target, property, receiver) {
        if (property === 'update') {
          return (...args: Parameters<typeof target.update>) => {
            hiccup.updates += 1;
            if (hiccup.failOn.has(hiccup.updates)) throw new Error('database hiccup');
            return target.update(...args);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const notifier = createDiscordNotifier({
      database: { db: flaky },
      logger: capture().logger,
      channelMap: DEFAULT_DISCORD_CHANNEL_MAP,
      ticketKeyPrefix: 'OPS',
      appUrl: 'https://desk.example.test',
      isProduction: false,
      credentials: undefined,
      overrides: {
        webhookUrls: () => Promise.resolve({ default: webhookFor().url }),
        fetch: scripted().fetch,
        claimLeaseMs: 0,
      },
    });

    // One hiccup on the write after the post (update #1 is the claim): the write is tried again.
    const once = await addTicket();
    hiccup.updates = 0;
    hiccup.failOn = new Set([2]);
    const outcome = await notifier.notify(notice(once));
    expect(outcome.slots).toEqual([{ slot: 'default', state: 'sent' }]);
    expect((await rows(once))[0]).toMatchObject({ state: 'sent' });

    // Every write fails: the row stays `sending` (not `failed`) and the sweep calls it unknown.
    const always = await addTicket();
    hiccup.updates = 0;
    hiccup.failOn = new Set([2, 3, 4]);
    await notifier.notify(notice(always));
    const [stuck] = await rows(always);
    expect(stuck).toMatchObject({ state: 'sending' });
    expect(stuck?.claimedAt).toBeInstanceOf(Date);
    hiccup.failOn = new Set();
    await notifier.sweep();
    expect((await rows(always))[0]?.outcomeUnknown).toBe(true);
  });

  it('a deleted webhook (404) fails at once and is not retried', async () => {
    const { notifier } = build({ urls: { default: webhookFor().url }, steps: [status(404)] });
    const ticketId = await addTicket();
    const result = await notifier.notify(notice(ticketId));
    expect(result.slots).toEqual([{ slot: 'default', state: 'failed' }]);
    expect((await rows(ticketId))[0]).toMatchObject({ state: 'failed', errorCode: 'webhook_gone' });
  });

  it('does nothing for a ticket that is gone or that no route selects', async () => {
    const { notifier, requests } = build({
      urls: { default: webhookFor().url },
      map: { routes: [{ name: 'p1-only', slot: 'default', minPriority: 'P1' }] },
    });
    expect(await notifier.notify(notice(randomUUID()))).toMatchObject({
      status: 'ticket_missing',
    });
    const ticketId = await addTicket('P3');
    expect(await notifier.notify(notice(ticketId))).toMatchObject({ status: 'no_route' });
    expect(await rows(ticketId)).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });
});

describe('the sweep (F-2)', () => {
  it('re-drives due posts after an outage, most urgent ticket first', async () => {
    const { notifier, requests } = build({ urls: { default: webhookFor().url } });
    const calm = await addTicket('P4');
    const hot = await addTicket('P1');
    // Both are owed and due; the calm ticket has been waiting longer.
    await owe(calm, { createdAt: new Date(Date.now() - 20 * 60 * 1000) });
    await owe(hot);
    const result = await notifier.sweep();
    expect(result.redriven).toBe(2);
    const titles = requests.map((request) => JSON.stringify(request.body));
    const key = async (id: string) => {
      const [row] = await owner()
        .select({ number: schema.ticket.number })
        .from(schema.ticket)
        .where(eq(schema.ticket.id, id));
      return `OPS-${String(row?.number)}`;
    };
    expect(titles[0]).toContain(await key(hot));
    expect(titles[1]).toContain(await key(calm));
    expect((await rows(calm))[0]?.state).toBe('sent');
    expect((await rows(hot))[0]?.state).toBe('sent');
  });

  it('does not touch a post that is not due yet', async () => {
    const { notifier, requests } = build({ urls: { default: webhookFor().url } });
    const ticketId = await addTicket();
    await owe(ticketId, { nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000) });
    await notifier.sweep();
    expect(requests).toHaveLength(0);
    expect((await rows(ticketId))[0]?.state).toBe('pending');
  });

  it('gives up on an owed post older than the retry age (expired) and keeps a younger one', async () => {
    const { notifier } = build({
      urls: { default: webhookFor().url },
      overrides: { retryMaxAgeMs: 60 * 60 * 1000 },
    });
    const old = await addTicket();
    const young = await addTicket();
    const later = new Date(Date.now() + 60 * 60 * 1000);
    await owe(old, { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000), nextAttemptAt: later });
    await owe(young, { nextAttemptAt: later });
    const result = await notifier.sweep();
    expect(result.expired).toBe(1);
    expect((await rows(old))[0]).toMatchObject({ state: 'failed', errorCode: 'expired' });
    expect((await rows(young))[0]?.state).toBe('pending');
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
    expect((await mockNotifier.notify(notice(await addTicket()))).mode).toBe('mock');
    expect(empty.requests).toHaveLength(0);

    const stored = webhookFor();
    await storeWith({}).put('discord', { webhookUrl: stored.url }, null);
    const dbFetch = scripted();
    const dbResult = await notifierWith({}, dbFetch).notify(notice(await addTicket()));
    expect(dbResult).toMatchObject({ mode: 'live', slots: [{ slot: 'default', state: 'sent' }] });
    expect(dbFetch.requests[0]?.url).toContain(`/webhooks/${stored.id}/`);

    const fromEnv = webhookFor();
    const envFetch = scripted();
    await notifierWith({ DISCORD_WEBHOOK_URL: fromEnv.url }, envFetch).notify(
      notice(await addTicket()),
    );
    expect(envFetch.requests[0]?.url).toContain(`/webhooks/${fromEnv.id}/`);
    await storeWith({}).remove('discord', 'webhookUrl');
  });
});

describe('processor', () => {
  const job = (data: unknown) => {
    const moved: number[] = [];
    const fake = {
      name: 'notify',
      data,
      moveToDelayed: (timestamp: number) => {
        moved.push(timestamp);
        return Promise.resolve();
      },
    } as unknown as Job;
    return { fake, moved };
  };
  const run = (notifier: DiscordNotifier, data: unknown) => {
    const { fake, moved } = job(data);
    return { result: createDiscordProcessor({ notifier })(fake, 'token'), moved };
  };

  it('rejects a payload with extra meaning missing, and an unknown job name, without retrying', async () => {
    const { notifier } = build();
    await expect(run(notifier, { event: 'ticket.created' }).result).rejects.toMatchObject({
      name: 'UnrecoverableError',
    });
    await expect(
      createDiscordProcessor({ notifier })({ name: 'other', data: {} } as unknown as Job),
    ).rejects.toMatchObject({ name: 'UnrecoverableError' });
  });

  it('moves the job to the time the ledger says (Retry-After included) instead of failing it (F-2)', async () => {
    const { notifier, clock } = withClock({ urls: { default: webhookFor().url } }, [
      status(429, { 'retry-after': '90' }),
    ]);
    const ticketId = await addTicket();
    const { result, moved } = run(notifier, notice(ticketId));
    await expect(result).rejects.toMatchObject({ name: 'DelayedError' });
    expect(moved).toEqual([clock.now + 90_000]);
    expect((await rows(ticketId))[0]).toMatchObject({
      state: 'pending',
      errorCode: 'rate_limited',
    });
  });

  it('runs the sweep job', async () => {
    const { notifier } = build();
    await expect(
      createDiscordProcessor({ notifier })({ name: 'sweep', data: {} } as unknown as Job),
    ).resolves.toMatchObject({ recovered: expect.any(Number) as number });
  });

  it('works from what the domain queued when a ticket is created', async () => {
    const ctx = domain.context({ actor: { type: 'system', id: null } });
    const { value } = await database.db.transaction((tx) =>
      domain.tickets.create(tx, ctx, { orgId, subject: 'Hello', body: 'Body text' }),
    );
    const [queued] = await owner()
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.jobId, `discord-ticket-created-${value.ticket.id}`));
    expect(queued).toMatchObject({ queue: 'discord', jobName: 'notify' });

    const { notifier } = build();
    const outcome = await run(notifier, queued?.payload).result;
    expect(outcome).toMatchObject({ status: 'processed', mode: 'mock', slots: ['default:mock'] });
    expect((await rows(value.ticket.id))[0]?.state).toBe('mock');
  });
});
