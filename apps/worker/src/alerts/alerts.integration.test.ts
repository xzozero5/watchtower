import { randomBytes, randomUUID } from 'node:crypto';

import { ChannelError } from '@watchtower/channels';
import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { createDomain, heartbeatFingerprint, type Domain } from '@watchtower/domain';
import {
  ALERTS_JOBS,
  DEFAULT_ESCALATION_STEPS,
  QUEUE_NAMES,
  normalizedAlertSchema,
  parseRedisUrl,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { startWorker, type RunningWorker } from '../worker.js';
import {
  FakeAlertChat,
  createAlertChatNotifier,
  type AlertChatNotifier,
  type AlertChatPort,
} from './index.js';

// T-201d in the worker, on real Postgres and Redis and no network: the repeating sweep follows the
// escalation policy, the `chat` job posts each step through the port (a fake: no token, no network),
// and the ledger tells the truth about it (`mock` is not `sent`, an unknown outcome is not retried).
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
let counter = 900;
const chat = new FakeAlertChat();
const realtimeChannel = `wt-alerts-test-${randomBytes(4).toString('hex')}`;
const heard: unknown[] = [];
let subscriber: Redis;
const owner = () => testDb.owner.db;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  config = {
    ...testConfig({ DATABASE_URL: testDb.appUrl, OUTBOX_POLL_INTERVAL_MS: '100' }),
    listenPort: 0,
  };
  appDb = createDatabase({ url: testDb.appUrl, max: 3, applicationName: 'wt-alerts-test' });
  domain = createDomain({
    ticketKeyPrefix: config.TICKET_KEY_PREFIX,
    sealKey: deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.outboxSecret),
  });
  alertsQueue = new Queue(QUEUE_NAMES.alerts, {
    connection: parseRedisUrl(config.REDIS_URL),
    prefix,
  });
  subscriber = new Redis({ ...parseRedisUrl(config.REDIS_URL), maxRetriesPerRequest: 2 });
  await subscriber.subscribe(realtimeChannel);
  subscriber.on('message', (_channel, message) => heard.push(JSON.parse(message)));
  worker = await startWorker(config, createLogger(config), {
    queuePrefix: prefix,
    realtimeChannel,
    overrides: { alerts: { chat } },
  });
});

afterAll(async () => {
  await worker.close();
  subscriber.disconnect();
  await alertsQueue.obliterate({ force: true });
  await alertsQueue.close();
  await appDb.close();
  await testDb.cleanup();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  what: string,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function openAlert(title = 'High CPU on API VMs'): Promise<string> {
  counter += 1;
  const alert = normalizedAlertSchema.parse({
    source: 'gcp_monitoring',
    providerEventId: `evt-${String(counter)}`,
    fingerprint: counter.toString(16).padStart(64, '0'),
    state: 'firing',
    severity: 'critical',
    title,
    summary: 'CPU is above 90%',
    conditionName: 'CPU above 90%',
    labels: { service: 'checkout' },
    url: 'https://console.example.invalid/alert/1',
    occurredAt: '2026-11-02T03:00:00.000Z',
    renotify: false,
    payload: { kind: 'gcp_monitoring' },
  });
  const ctx = domain.context({ actor: { type: 'system', id: null } });
  const { value } = await appDb.db.transaction((tx) => domain.alerts.ingest(tx, ctx, { alert }));
  if (value.kind !== 'opened') throw new Error('expected an opened alert');
  return value.alertId;
}

const sweepNow = () => alertsQueue.add(ALERTS_JOBS.sweep, {}, { removeOnComplete: true });

const stepRows = (alertId: string) =>
  owner()
    .select()
    .from(schema.alertEscalation)
    .where(eq(schema.alertEscalation.alertId, alertId))
    .orderBy(schema.alertEscalation.level);

describe('the alerts queue in the worker', () => {
  it('a sweep escalates, queues the chat post through the outbox, and the fake records it as mock', async () => {
    const [lead] = await owner()
      .insert(schema.users)
      .values({
        email: `${randomUUID()}@example.test`,
        name: 'Lead',
        role: 'lead',
        discordUserId: '123456789012345678',
      })
      .returning({ id: schema.users.id });
    const alertId = await openAlert();
    await sweepNow();
    const [step] = await waitFor(async () => {
      const rows = await stepRows(alertId);
      return rows[0]?.chatState === 'mock' ? rows : undefined;
    }, 'the first step to be posted to the fake chat');
    expect(step?.target).toBe('on_shift');
    // Nobody was on shift, so the leads were told in their place, and say so.
    expect(step?.fallback).toBe('lead');
    expect(lead).toBeDefined();

    const message = chat.posted.find((candidate) => candidate.alertId === alertId);
    expect(message).toMatchObject({
      level: 0,
      target: 'on_shift',
      severity: 'critical',
      serviceName: null,
      count: 1,
      fallback: true,
    });
    expect(message?.mentionUserIds).toContain('123456789012345678');
    // N4: nothing of the alert's own text travels to chat; a link back to the app does.
    expect(JSON.stringify(message)).not.toContain('CPU');
    expect(message?.link).toBe(new URL(`/alerts/${alertId}`, config.APP_URL).toString());

    // A fake can never say sent: the ledger has no delivery time or message id.
    expect(step).toMatchObject({ chatState: 'mock', chatSentAt: null, chatMessageId: null });
  });

  it('carries the next step when it falls due and publishes a realtime event for it', async () => {
    const alertId = await openAlert();
    await sweepNow();
    await waitFor(
      async () => ((await stepRows(alertId)).length === 1 ? true : undefined),
      'step 0',
    );
    await owner().execute(
      sql`UPDATE alert SET first_seen_at = first_seen_at - make_interval(secs => ${DEFAULT_ESCALATION_STEPS[1]?.afterSeconds ?? 0}),
                           next_escalation_at = next_escalation_at - make_interval(secs => ${DEFAULT_ESCALATION_STEPS[1]?.afterSeconds ?? 0})
           WHERE id = ${alertId}`,
    );
    await sweepNow();
    const rows = await waitFor(async () => {
      const found = await stepRows(alertId);
      return found.length === 2 && found.every((row) => row.chatState === 'mock')
        ? found
        : undefined;
    }, 'step 1 to be posted');
    expect(rows.map((row) => row.target)).toEqual(['on_shift', 'lead']);
    // The escalation told staff in realtime, ids only.
    await waitFor(
      () =>
        Promise.resolve(
          heard.some(
            (event) =>
              JSON.stringify(event).includes(alertId) &&
              JSON.stringify(event).includes('alert.updated'),
          )
            ? true
            : undefined,
        ),
      'the realtime event of the escalation',
    );
    expect(
      chat.posted.filter((candidate) => candidate.alertId === alertId).map((m) => m.level),
    ).toEqual([0, 1]);
  });
});

describe('heartbeats in the same sweep', () => {
  it('a heartbeat silent past its time opens an alert that is escalated and posted in the same run', async () => {
    const [row] = await owner()
      .insert(schema.heartbeat)
      .values({
        slug: `hb-${randomUUID().slice(0, 8)}`,
        name: 'Nightly export',
        expectedIntervalSeconds: 60,
        graceSeconds: 0,
        lastBeatAt: sql`clock_timestamp() - interval '1 hour'`,
      })
      .returning({ id: schema.heartbeat.id });
    const heartbeatId = row?.id ?? '';
    await sweepNow();
    const alertRow = await waitFor(async () => {
      const found = await owner()
        .select()
        .from(schema.alert)
        .where(eq(schema.alert.source, 'heartbeat'));
      return found.find((candidate) => candidate.fingerprint === heartbeatFingerprint(heartbeatId));
    }, 'the heartbeat alert');
    const steps = await waitFor(async () => {
      const found = await stepRows(alertRow.id);
      return found[0]?.chatState === 'mock' ? found : undefined;
    }, 'its first step to be posted');
    expect(steps[0]?.level).toBe(0);
    expect(
      (await owner().select().from(schema.heartbeat).where(eq(schema.heartbeat.id, heartbeatId)))[0]
        ?.state,
    ).toBe('missing');
  });
});

describe('the chat ledger tells the truth', () => {
  function notifier(
    port: AlertChatPort,
    extra: { claimLeaseSeconds?: number; retryMaxSeconds?: number } = {},
  ): AlertChatNotifier {
    return createAlertChatNotifier({
      database: appDb,
      logger: createLogger(config),
      chat: port,
      appUrl: config.APP_URL,
      isProduction: false,
      ...extra,
    });
  }

  async function pendingStep(): Promise<{ alertId: string; level: number }> {
    counter += 1;
    const [alert] = await owner()
      .insert(schema.alert)
      .values({
        fingerprint: counter.toString(16).padStart(64, '0'),
        source: 'alertmanager',
        title: 'High error rate',
      })
      .returning({ id: schema.alert.id });
    const alertId = alert?.id ?? '';
    await owner().insert(schema.alertEscalation).values({ alertId, level: 0, target: 'lead' });
    return { alertId, level: 0 };
  }

  const rowOf = async (alertId: string) => (await stepRows(alertId))[0];

  const livePort = (result: { delivered: boolean }): AlertChatPort => ({
    kind: 'live',
    postEscalation: () =>
      Promise.resolve({ delivered: result.delivered, channelId: '111', messageId: '222' }),
  });
  const failingPort = (error: Error): AlertChatPort => ({
    kind: 'live',
    postEscalation: () => Promise.reject(error),
  });
  const discordError = (
    kind: ConstructorParameters<typeof ChannelError>[0]['kind'],
    retryAfterMs?: number,
  ) =>
    new ChannelError({
      provider: 'discord',
      operation: 'message.create',
      kind,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });

  it('`sent` only when the port says delivered, with the message id and the delivery time', async () => {
    const step = await pendingStep();
    expect(await notifier(livePort({ delivered: true })).post(step)).toEqual({
      status: 'posted',
      state: 'sent',
    });
    expect(await rowOf(step.alertId)).toMatchObject({
      chatState: 'sent',
      chatChannelId: '111',
      chatMessageId: '222',
      chatClaimedAt: null,
    });
    expect((await rowOf(step.alertId))?.chatSentAt).not.toBeNull();
  });

  it('does not post a step for an alert somebody acknowledged first', async () => {
    const step = await pendingStep();
    const [person] = await owner()
      .insert(schema.users)
      .values({ email: `${randomUUID()}@example.test`, name: 'Agent', role: 'agent' })
      .returning({ id: schema.users.id });
    await appDb.db.transaction((tx) =>
      domain.alerts.ack(tx, domain.context({ actor: { type: 'user', id: person?.id ?? null } }), {
        alertId: step.alertId,
        via: 'web',
      }),
    );
    const quiet = new FakeAlertChat();
    expect(await notifier(quiet).post(step)).toEqual({ status: 'posted', state: 'skipped' });
    expect(await rowOf(step.alertId)).toMatchObject({
      chatState: 'skipped',
      chatErrorCode: 'not_open',
    });
    expect(quiet.posted).toEqual([]);
  });

  it('is posted once: a repeated job finds it already done', async () => {
    const step = await pendingStep();
    const live = notifier(livePort({ delivered: true }));
    await live.post(step);
    expect(await live.post(step)).toEqual({ status: 'already', was: 'sent' });
    expect(await live.post({ alertId: randomUUID(), level: 0 })).toEqual({ status: 'missing' });
  });

  it('rate limited: nothing was posted, so it waits and is re-driven by the sweep', async () => {
    const step = await pendingStep();
    const limited = notifier(failingPort(discordError('rate_limited', 0)));
    expect(await limited.post(step)).toMatchObject({ status: 'retry', code: 'rate_limited' });
    expect(await rowOf(step.alertId)).toMatchObject({ chatState: 'pending', chatAttempts: 1 });
    // Not due yet (the backoff has a floor): a repeated job does not post.
    expect(await notifier(livePort({ delivered: true })).post(step)).toEqual({ status: 'not_due' });
    await owner().execute(
      sql`UPDATE alert_escalation SET chat_next_attempt_at = clock_timestamp() - interval '1 second' WHERE alert_id = ${step.alertId}`,
    );
    const result = await notifier(livePort({ delivered: true })).sweep();
    expect(result.redriven).toBeGreaterThanOrEqual(1);
    expect(await rowOf(step.alertId)).toMatchObject({ chatState: 'sent', chatAttempts: 2 });
  });

  it('an unknown outcome (timeout, network, 5xx) is not retried: the post may have been made', async () => {
    for (const kind of ['timeout', 'network', 'server'] as const) {
      const step = await pendingStep();
      await notifier(failingPort(discordError(kind))).post(step);
      expect(await rowOf(step.alertId)).toMatchObject({
        chatState: 'failed',
        chatErrorCode: 'outcome_unknown',
      });
    }
  });

  it('a refusal that will not change is failed with its code, and a plain error counts as unknown', async () => {
    const refused = await pendingStep();
    await notifier(failingPort(discordError('auth'))).post(refused);
    expect(await rowOf(refused.alertId)).toMatchObject({
      chatState: 'failed',
      chatErrorCode: 'auth',
    });
    const odd = await pendingStep();
    await notifier(failingPort(new Error('boom'))).post(odd);
    expect(await rowOf(odd.alertId)).toMatchObject({
      chatState: 'failed',
      chatErrorCode: 'outcome_unknown',
    });
  });

  it('the sweep turns a claim a dead worker left into an honest unknown outcome, and gives up on old steps', async () => {
    const abandoned = await pendingStep();
    await owner().execute(
      sql`UPDATE alert_escalation SET chat_state = 'sending', chat_claimed_at = clock_timestamp() - interval '1 hour' WHERE alert_id = ${abandoned.alertId}`,
    );
    const old = await pendingStep();
    await owner().execute(
      sql`UPDATE alert_escalation SET created_at = clock_timestamp() - interval '1 day' WHERE alert_id = ${old.alertId}`,
    );
    const result = await notifier(new FakeAlertChat()).sweep();
    expect(result.recovered).toBeGreaterThanOrEqual(1);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(await rowOf(abandoned.alertId)).toMatchObject({
      chatState: 'failed',
      chatErrorCode: 'outcome_unknown',
    });
    expect(await rowOf(old.alertId)).toMatchObject({
      chatState: 'failed',
      chatErrorCode: 'expired',
    });
  });

  it('two workers on one step: exactly one posts', async () => {
    const step = await pendingStep();
    const calls: string[] = [];
    const slow: AlertChatPort = {
      kind: 'live',
      postEscalation: async () => {
        calls.push('post');
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { delivered: true, channelId: '1', messageId: '2' };
      },
    };
    await Promise.all([
      notifier(slow).post(step),
      notifier(slow).post(step),
      notifier(slow).post(step),
    ]);
    expect(calls).toEqual(['post']);
  });
});
