import { randomBytes, randomUUID } from 'node:crypto';

import { ChannelError } from '@watchtower/channels';
import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { createDomain, createPolicyGate, type Domain } from '@watchtower/domain';
import { AUDIT_ACTIONS, GMAIL_JOBS, GMAIL_QUEUES, gmailSyncJobSchema } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { createGmailHeartbeat } from './heartbeat.js';
import { createMockGmailRuntime, type MockGmailRuntime } from './runtime.js';
import { createGmailWatch } from './watch.js';

// Watch renewal (R-2.1) and the push heartbeat (R-2.8) on the real database, with the in-memory
// Gmail and a clock the test moves. Business time is counted on the instance's calendar; with none
// configured that is Monday to Friday 09:00 to 18:00 in Bangkok (2030-01-07 is a Monday).
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const net = disableNetConnect();

const TOPIC = 'projects/example-project/topics/example-topic';
const STALE_MINUTES = 120;
const clock = { now: new Date('2030-01-07T06:30:00.000Z') }; // Monday 13:30 in Bangkok
const logger = createLogger(testConfig());

let testDb: TestDatabase;
let database: Database;
let domain: Domain;
let runtime: MockGmailRuntime;

const owner = () => testDb.owner.db;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  database = createDatabase({ url: testDb.appUrl, max: 5, applicationName: 'wt-gmail-hb-test' });
  domain = createDomain({
    ticketKeyPrefix: 'OPS',
    sealKey: randomBytes(32),
    portalUrl: 'https://desk.example.test/portal',
    policyGate: createPolicyGate({ db: database.db }),
    now: () => clock.now,
  });
  runtime = createMockGmailRuntime({ database, now: () => clock.now });
});

afterAll(async () => {
  await database.close();
  await testDb.cleanup();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

beforeEach(() => {
  clock.now = new Date('2030-01-07T06:30:00.000Z');
});

async function mailbox(values: Partial<typeof schema.gmailAccountState.$inferInsert> = {}) {
  const [account] = await owner()
    .insert(schema.channelAccount)
    .values({ type: 'gmail', name: `Mailbox ${randomUUID().slice(0, 8)}`, health: 'healthy' })
    .returning({ id: schema.channelAccount.id });
  const id = account?.id ?? '';
  await owner()
    .insert(schema.gmailAccountState)
    .values({
      channelAccountId: id,
      emailAddress: `${randomUUID().slice(0, 8)}@desk.example.test`,
      createdAt: new Date('2029-12-01T00:00:00Z'),
      ...values,
    });
  return id;
}
async function state(id: string) {
  const [row] = await owner()
    .select()
    .from(schema.gmailAccountState)
    .where(eq(schema.gmailAccountState.channelAccountId, id));
  if (!row) throw new Error('no state');
  return row;
}
async function health(id: string) {
  const [row] = await owner()
    .select({ health: schema.channelAccount.health })
    .from(schema.channelAccount)
    .where(eq(schema.channelAccount.id, id));
  return row?.health;
}
async function audits(action: string, id: string) {
  const rows = await owner()
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, action));
  return rows.filter((row) => row.targetId === id);
}
async function syncJobs(id: string) {
  const rows = await owner()
    .select()
    .from(schema.outbox)
    .where(eq(schema.outbox.queue, GMAIL_QUEUES.gmail));
  return rows.filter(
    (row) => (row.payload as { channelAccountId?: string }).channelAccountId === id,
  );
}

const makeWatch = (topicName: string | null = TOPIC) =>
  createGmailWatch({
    database,
    domain,
    runtime,
    topicName: topicName ?? undefined,
    logger,
    now: () => clock.now,
  });
const makeHeartbeat = (topicName: string | null = TOPIC) =>
  createGmailHeartbeat({
    database,
    domain,
    watch: makeWatch(topicName),
    staleMinutes: STALE_MINUTES,
    logger,
    now: () => clock.now,
  });

describe('watch renewal', () => {
  it('calls users.watch on the INBOX with the configured topic and records when it lapses', async () => {
    const id = await mailbox();
    const result = await makeWatch().renewAccount(id);
    expect(result.status).toBe('renewed');
    const fake = runtime.fakeFor(id);
    expect(fake.watchState?.topicName).toBe(TOPIC);
    const call = fake.calls.find((entry) => entry.op === 'watch');
    expect(call).toMatchObject({
      request: { topicName: TOPIC, labelIds: ['INBOX'], labelFilterBehavior: 'include' },
    });
    const row = await state(id);
    expect(row.watchRenewedAt).toEqual(clock.now);
    // The fake's watch lasts 7 days, like Gmail's.
    expect(row.watchExpiresAt).toEqual(new Date(clock.now.getTime() + 7 * 24 * 3600 * 1000));
  });

  it('does nothing without a Pub/Sub topic (mock) or for a disabled mailbox', async () => {
    const id = await mailbox();
    expect(await makeWatch(null).renewAccount(id)).toEqual({ status: 'no_topic' });
    expect(runtime.fakeFor(id).calls).toHaveLength(0);
    const off = await mailbox({ enabled: false });
    expect(await makeWatch().renewAccount(off)).toEqual({ status: 'skipped' });
    expect(runtime.fakeFor(off).calls).toHaveLength(0);
  });

  it('marks the mailbox unhealthy and audits a failed renewal, and a later success clears the error', async () => {
    const id = await mailbox();
    runtime.fakeFor(id).failNext(
      'users.watch',
      new ChannelError({
        provider: 'gmail',
        operation: 'users.watch',
        kind: 'auth',
        status: 403,
      }),
    );
    await expect(makeWatch().renewAccount(id)).rejects.toBeInstanceOf(ChannelError);
    expect(await health(id)).toBe('unhealthy');
    expect(await state(id)).toMatchObject({ lastErrorCode: 'watch_failed' });
    const [failure] = await audits(AUDIT_ACTIONS.gmailWatchFailed, id);
    expect(failure).toMatchObject({ outcome: 'failure', metadata: { code: 'channel_auth' } });

    await makeWatch().renewAccount(id);
    expect(await state(id)).toMatchObject({ lastErrorCode: null });
  });

  it('renewAll tries every mailbox, then fails the job so it is retried', async () => {
    const bad = await mailbox();
    const good = await mailbox();
    runtime
      .fakeFor(bad)
      .failNext(
        'users.watch',
        new ChannelError({ provider: 'gmail', operation: 'users.watch', kind: 'server' }),
      );
    // The two mailboxes of earlier cases are renewed too (they are enabled); only count the ones here.
    await expect(makeWatch().renewAll()).rejects.toBeInstanceOf(ChannelError);
    expect((await state(good)).watchRenewedAt).toEqual(clock.now);
    expect(await health(bad)).toBe('unhealthy');
  });
});

describe('heartbeat', () => {
  const lastPush = new Date('2030-01-07T03:00:00.000Z'); // 10:00 Bangkok, 210 business minutes ago

  it('marks a mailbox with no push for the window unhealthy once, and still queues a catch-up sync', async () => {
    const id = await mailbox({ lastPushAt: lastPush });
    const first = await makeHeartbeat().run();
    expect(first.stale).toContain(id);
    expect(await health(id)).toBe('unhealthy');
    const raised = await audits(AUDIT_ACTIONS.gmailHeartbeatStale, id);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.metadata).toMatchObject({
      quietBusinessMinutes: 210,
      thresholdMinutes: STALE_MINUTES,
      neverPushed: false,
      watchLapsed: false,
    });
    const jobs = await syncJobs(id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ queue: GMAIL_QUEUES.gmail, jobName: GMAIL_JOBS.sync });
    expect(gmailSyncJobSchema.parse(jobs[0]?.payload)).toEqual({
      channelAccountId: id,
      reason: 'heartbeat',
    });

    // Same moment, again: no second alert, no second job. Ten minutes later: a new job, still one alert.
    await makeHeartbeat().run();
    expect(await syncJobs(id)).toHaveLength(1);
    clock.now = new Date(clock.now.getTime() + 11 * 60_000);
    await makeHeartbeat().run();
    expect(await syncJobs(id)).toHaveLength(2);
    expect(await audits(AUDIT_ACTIONS.gmailHeartbeatStale, id)).toHaveLength(1);
  });

  it('counts business time only: a quiet night or weekend is not a symptom', async () => {
    // Monday 17:00 to Tuesday 09:30 Bangkok: 60 + 30 = 90 business minutes.
    clock.now = new Date('2030-01-08T02:30:00.000Z');
    const overnight = await mailbox({ lastPushAt: new Date('2030-01-07T10:00:00.000Z') });
    // Friday 17:00 to Monday 09:30: also 90.
    clock.now = new Date('2030-01-07T02:30:00.000Z');
    const weekend = await mailbox({ lastPushAt: new Date('2030-01-04T10:00:00.000Z') });

    clock.now = new Date('2030-01-08T02:30:00.000Z');
    const night = await makeHeartbeat().run();
    expect(night.stale).not.toContain(overnight);
    clock.now = new Date('2030-01-07T02:30:00.000Z');
    const monday = await makeHeartbeat().run();
    expect(monday.stale).not.toContain(weekend);
    expect(await health(overnight)).toBe('healthy');
    expect(await health(weekend)).toBe('healthy');
    expect(await syncJobs(overnight)).toHaveLength(0);
  });

  it('treats a mailbox that never pushed as quiet since it was created', async () => {
    const old = await mailbox({ lastPushAt: null });
    const fresh = await mailbox({
      lastPushAt: null,
      createdAt: new Date('2030-01-07T06:00:00.000Z'),
    });
    const result = await makeHeartbeat().run();
    expect(result.stale).toContain(old);
    expect(result.stale).not.toContain(fresh);
    const [alert] = await audits(AUDIT_ACTIONS.gmailHeartbeatStale, old);
    expect(alert?.metadata).toMatchObject({ neverPushed: true });
  });

  it('treats a lapsed watch as stale even after a recent push, and renews it', async () => {
    const id = await mailbox({
      lastPushAt: new Date('2030-01-07T06:20:00.000Z'),
      watchExpiresAt: new Date('2030-01-07T06:00:00.000Z'),
    });
    const result = await makeHeartbeat().run();
    expect(result.stale).toContain(id);
    expect((await audits(AUDIT_ACTIONS.gmailHeartbeatStale, id))[0]?.metadata).toMatchObject({
      watchLapsed: true,
    });
    expect(runtime.fakeFor(id).watchState?.topicName).toBe(TOPIC);
    expect((await state(id)).watchExpiresAt?.getTime()).toBeGreaterThan(clock.now.getTime());
  });

  it('brings a mailbox back once pushes are fresh again, unless an error is still recorded', async () => {
    const recovered = await mailbox({ lastPushAt: new Date('2030-01-07T06:25:00.000Z') });
    const errored = await mailbox({
      lastPushAt: new Date('2030-01-07T06:25:00.000Z'),
      lastErrorCode: 'watch_failed',
    });
    await owner()
      .update(schema.channelAccount)
      .set({ health: 'unhealthy' })
      .where(eq(schema.channelAccount.id, recovered));
    await owner()
      .update(schema.channelAccount)
      .set({ health: 'unhealthy' })
      .where(eq(schema.channelAccount.id, errored));
    const result = await makeHeartbeat().run();
    expect(result.recovered).toContain(recovered);
    expect(result.recovered).not.toContain(errored);
    expect(await health(recovered)).toBe('healthy');
    expect(await health(errored)).toBe('unhealthy');
  });

  it('ignores disabled mailboxes', async () => {
    const id = await mailbox({ enabled: false, lastPushAt: lastPush });
    const result = await makeHeartbeat().run();
    expect(result.stale).not.toContain(id);
    expect(await health(id)).toBe('healthy');
  });
});
