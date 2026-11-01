import { randomBytes, randomUUID } from 'node:crypto';

import { ChannelError, discord } from '@watchtower/channels';
import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { createDomain, type Domain } from '@watchtower/domain';
import { ALERTS_JOBS, QUEUE_NAMES, normalizedAlertSchema, parseRedisUrl } from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import { disableNetConnect } from '@watchtower/shared/testing';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { startWorker, type RunningWorker } from '../worker.js';

// T-202b in the worker, on real Postgres and Redis and no network: an incident's Discord thread is
// created through the bot port (the in-memory fake: no token), key timeline entries are mirrored into it,
// and nothing of the incident's free text, a note or an alert's title ever reaches Discord (N4).
const net = disableNetConnect();
const prefix = `wt-test-${randomBytes(4).toString('hex')}`;
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
let config: ReturnType<typeof testConfig>;
let worker: RunningWorker;
let alertsQueue: Queue;
let appDb: Database;
let domain: Domain;
let counter = 0;
const bot = new discord.FakeBotTransport();
const owner = () => testDb.owner.db;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  config = {
    ...testConfig({ DATABASE_URL: testDb.appUrl, OUTBOX_POLL_INTERVAL_MS: '100' }),
    listenPort: 0,
  };
  appDb = createDatabase({ url: testDb.appUrl, max: 3, applicationName: 'wt-incidents-test' });
  domain = createDomain({
    ticketKeyPrefix: config.TICKET_KEY_PREFIX,
    sealKey: deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.outboxSecret),
  });
  alertsQueue = new Queue(QUEUE_NAMES.alerts, {
    connection: parseRedisUrl(config.REDIS_URL),
    prefix,
  });
  worker = await startWorker(config, createLogger(config), {
    queuePrefix: prefix,
    overrides: { incidents: { bot }, alerts: { bot } },
  });
});
afterAll(async () => {
  await worker.close();
  await alertsQueue.obliterate({ force: true });
  await alertsQueue.close();
  await appDb.close();
  await testDb.cleanup();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

async function waitFor<T>(
  read: () => Promise<T | undefined> | T | undefined,
  what: string,
  ms = 25_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function addPerson(role: 'agent' | 'lead' = 'agent') {
  const [row] = await owner()
    .insert(schema.users)
    .values({ email: `${randomUUID()}@example.test`, name: 'Person', role })
    .returning({ id: schema.users.id });
  return { id: row?.id ?? '', actor: { type: 'user', id: row?.id ?? null } as const };
}

async function openIncident(fields: { title?: string; serviceSlug?: string } = {}) {
  const person = await addPerson();
  const slug = fields.serviceSlug ?? `svc-${randomUUID().slice(0, 8)}`;
  const [service] = await owner()
    .insert(schema.service)
    .values({ slug, name: 'Checkout' })
    .returning({ id: schema.service.id });
  const { value } = await appDb.db.transaction((tx) =>
    domain.incidents.create(tx, domain.context({ actor: person.actor }), {
      title: fields.title ?? 'Acme Corp cannot pay',
      severity: 'SEV2',
      serviceIds: [service?.id ?? ''],
      alertIds: [],
      ticketIds: [],
      orgIds: [],
    }),
  );
  return { ...value, person, slug };
}

const rowOf = async (incidentId: string) =>
  (await owner().select().from(schema.incident).where(eq(schema.incident.id, incidentId)))[0];

describe('the thread of an incident (R-3.13)', () => {
  it('is created through the bot port: a mock state, the opening message with buttons, a name without the title', async () => {
    const incident = await openIncident();
    await waitFor(
      async () =>
        (await rowOf(incident.incidentId))?.discordThreadState === 'mock' ? true : undefined,
      'the thread to be recorded',
    );
    const row = await rowOf(incident.incidentId);
    // A fake never has ids: the row says mock, and the table would refuse ids on it.
    expect(row).toMatchObject({
      discordThreadState: 'mock',
      discordThreadId: null,
      discordChannelId: null,
    });

    const opening = bot.calls.find(
      (call) => call.op === 'postMessage' && JSON.stringify(call).includes(incident.key),
    );
    expect(opening).toBeDefined();
    expect(JSON.stringify(opening?.payload.components)).toContain(
      `incident:ack:${incident.incidentId}`,
    );
    expect(JSON.stringify(opening?.payload.components)).toContain(
      `incident:assign:${incident.incidentId}`,
    );
    const thread = bot.calls.find(
      (call) => call.op === 'createThread' && String(call.payload.name).startsWith(incident.key),
    );
    expect(thread?.payload.name).toBe(`${incident.key} SEV2 ${incident.slug}`);
    // N4: the title (which names a customer) is nowhere in what Discord was sent.
    expect(JSON.stringify(bot.calls)).not.toContain('Acme');

    const timeline = await owner()
      .select()
      .from(schema.incidentTimeline)
      .where(eq(schema.incidentTimeline.incidentId, incident.incidentId));
    expect(timeline.map((entry) => [entry.type, entry.payload])).toContainEqual([
      'thread_created',
      { state: 'mock' },
    ]);
  });

  it('mirrors a status change and a new commander as one line each, and never a note', async () => {
    const incident = await openIncident();
    await waitFor(
      async () =>
        (await rowOf(incident.incidentId))?.discordThreadState === 'mock' ? true : undefined,
      'the thread',
    );
    const lead = await addPerson('lead');
    await appDb.db.transaction(async (tx) => {
      const ctx = domain.context({ actor: incident.person.actor });
      await domain.incidents.update(tx, ctx, {
        incidentId: incident.incidentId,
        status: 'identified',
        commanderId: lead.id,
        canResolve: false,
      });
      await domain.incidents.note(tx, ctx, {
        incidentId: incident.incidentId,
        text: 'Acme says card payments fail for them',
      });
    });
    const lines = () =>
      bot.calls
        .filter(
          (call) =>
            call.op === 'postInThread' && call.target === `mock-thread-${incident.incidentId}`,
        )
        .map((call) => String(call.payload.content));
    await waitFor(() => (lines().length >= 3 ? true : undefined), 'the mirrored lines');
    expect(lines().toSorted()).toEqual(
      [
        `${incident.key} opened as SEV2`,
        `${incident.key} status: investigating -> identified`,
        `${incident.key} has a new commander`,
      ].toSorted(),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(lines()).toHaveLength(3);
    expect(JSON.stringify(bot.calls)).not.toContain('card payments');
  });

  it('retries when the bot is rate limited, and ends in the same place', async () => {
    bot.failNext(
      new ChannelError({
        provider: 'discord',
        operation: 'message.create',
        kind: 'rate_limited',
        retryAfterMs: 100,
      }),
    );
    const incident = await openIncident();
    const row = await waitFor(async () => {
      const found = await rowOf(incident.incidentId);
      return found?.discordThreadState === 'mock' ? found : undefined;
    }, 'the thread after a retry');
    expect(row.discordThreadState).toBe('mock');
  });
});

describe('the alert page through the bot (T-201d with T-202b)', () => {
  it('posts the escalation with an Ack button and without the alert title, as a mock', async () => {
    counter += 1;
    const alert = normalizedAlertSchema.parse({
      source: 'gcp_monitoring',
      providerEventId: `evt-${String(counter)}`,
      fingerprint: counter.toString(16).padStart(64, '0'),
      state: 'firing',
      severity: 'critical',
      title: 'Acme Corp payments queue is stuck',
      summary: null,
      conditionName: null,
      labels: {},
      url: null,
      occurredAt: null,
      renotify: false,
      payload: {},
    });
    const { value } = await appDb.db.transaction((tx) =>
      domain.alerts.ingest(tx, domain.context({ actor: { type: 'system', id: null } }), { alert }),
    );
    if (value.kind !== 'opened') throw new Error('expected an opened alert');
    await alertsQueue.add(ALERTS_JOBS.sweep, {}, { removeOnComplete: true });
    const posted = await waitFor(
      () =>
        bot.calls.find(
          (call) =>
            call.op === 'postMessage' &&
            JSON.stringify(call).includes(`alert:ack:${value.alertId}`),
        ),
      'the page',
    );
    expect(String(posted.payload.content)).toContain('CRITICAL alert needs an answer');
    expect(JSON.stringify(posted)).not.toContain('Acme');
    const step = (
      await owner()
        .select()
        .from(schema.alertEscalation)
        .where(eq(schema.alertEscalation.alertId, value.alertId))
    )[0];
    await waitFor(async () => {
      const current = (
        await owner()
          .select()
          .from(schema.alertEscalation)
          .where(eq(schema.alertEscalation.alertId, value.alertId))
      )[0];
      return current?.chatState === 'mock' ? true : undefined;
    }, 'the ledger to say mock');
    expect(step?.chatMessageId).toBeNull();
  });
});
