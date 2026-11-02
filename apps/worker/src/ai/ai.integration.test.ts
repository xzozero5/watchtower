import { randomBytes } from 'node:crypto';

import { DevMockLlmProvider, type LlmProvider } from '@watchtower/ai';
import { gmail } from '@watchtower/channels';
import { createDatabase, enqueueOutbox, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { createDomain, type Domain } from '@watchtower/domain';
import {
  AUDIT_ACTIONS,
  INBOUND_QUEUES,
  INGEST_JOBS,
  INGEST_OUTBOX_JOB_OPTIONS,
  QUEUE_NAMES,
  parseRedisUrl,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMemoryObjectStore } from '../ingest/object-store.js';
import { createLogger } from '../logger.js';
import { testConfig, testSealKey } from '../testing/support.js';
import { startWorker, type RunningWorker } from '../worker.js';

// The AI brief through the real worker (T-106e): Postgres (restricted application role) and Redis
// from docker compose, the offline mock provider, nothing else. disableNetConnect allows loopback
// only, so a provider call that tried the network would fail the test.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const prefix = `wt-ai-${randomBytes(4).toString('hex')}`;
const net = disableNetConnect();

let testDb: TestDatabase;
let worker: RunningWorker;
let appDatabase: Database;
let domain: Domain;
let config: ReturnType<typeof testConfig>;
let gmailId = '';
let orgId = '';
let providerCalls = 0;
const seenRequests: string[] = [];
let sequence = 0;

const owner = () => testDb.owner.db;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  config = {
    ...testConfig({
      DATABASE_URL: testDb.appUrl,
      OUTBOX_POLL_INTERVAL_MS: '100',
      INGEST_CLASSIFIER_TIMEOUT_MS: '2000',
      AI_DAILY_TOKEN_CAP: '100000',
    }),
    listenPort: 0,
  };
  const inner = new DevMockLlmProvider();
  const counting: LlmProvider = {
    kind: 'mock',
    generate(request) {
      providerCalls += 1;
      seenRequests.push(JSON.stringify(request));
      return inner.generate(request);
    },
  };
  worker = await startWorker(config, createLogger(config), {
    queuePrefix: prefix,
    realtimeChannel: `watchtower:realtime:${prefix}`,
    overrides: {
      ingest: { store: createMemoryObjectStore() },
      ai: { providers: { mock: counting } },
    },
  });
  appDatabase = createDatabase({ url: testDb.appUrl, max: 4, applicationName: 'wt-ai-test' });
  domain = createDomain({ ticketKeyPrefix: 'OPS', sealKey: testSealKey(config) });

  const [account] = await owner()
    .insert(schema.channelAccount)
    .values({ type: 'gmail', name: 'Support mailbox' })
    .returning();
  gmailId = account?.id ?? '';
  const [org] = await owner()
    .insert(schema.organization)
    .values({ name: 'Example Org' })
    .returning();
  orgId = org?.id ?? '';
  await owner()
    .insert(schema.intent)
    .values([
      { key: 'access_issue', name: 'Cannot sign in or reset a password' },
      { key: 'incident_report', name: 'Something is broken or down' },
    ]);
});

afterAll(async () => {
  await worker.close();
  await appDatabase.close();
  const connection = parseRedisUrl(config.REDIS_URL);
  for (const name of [QUEUE_NAMES.ingest, QUEUE_NAMES.ai]) {
    const queue = new Queue(name, { connection, prefix });
    await queue.obliterate({ force: true });
    await queue.close();
  }
  await testDb.cleanup();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A Gmail event on the ingest queue, as the webhook receiver writes it. Returns the event id. */
async function receiveMail(subject: string, body: string): Promise<string> {
  sequence += 1;
  const from = `customer${String(sequence)}@customer.example.test`;
  const mime = gmail.buildFakeMime({
    fromName: 'Pat Example',
    subject,
    body,
    messageId: `m${String(sequence)}-${randomBytes(3).toString('hex')}@customer.example.test`,
    from,
  });
  const providerEventId = `g-${prefix}-${String(sequence)}`;
  return owner().transaction(async (tx) => {
    const [event] = await tx
      .insert(schema.inboundEvent)
      .values({
        channelAccountId: gmailId,
        providerEventId,
        payload: {
          id: providerEventId,
          threadId: `thread-${prefix}-${String(sequence)}`,
          labelIds: ['INBOX', 'UNREAD'],
          raw: mime.rawBase64Url,
        },
      })
      .returning({ id: schema.inboundEvent.id });
    if (!event) throw new Error('no event row');
    await enqueueOutbox(tx, {
      queue: INBOUND_QUEUES.ingest,
      jobName: INGEST_JOBS.process,
      jobId: event.id,
      payload: { inboundEventId: event.id },
      options: { ...INGEST_OUTBOX_JOB_OPTIONS },
    });
    return event.id;
  });
}

async function ticketOf(eventId: string) {
  return waitFor('the event to become a ticket', async () => {
    const [message] = await owner()
      .select()
      .from(schema.inboundMessage)
      .where(eq(schema.inboundMessage.inboundEventId, eventId));
    return message?.ticketId == null ? undefined : message;
  });
}

async function insightOf(ticketId: string) {
  return waitFor('the AI insight', async () => {
    const [row] = await owner()
      .select()
      .from(schema.aiTicketInsight)
      .where(eq(schema.aiTicketInsight.ticketId, ticketId));
    return row;
  });
}

/**
 * Waits until the AI has stopped calling the provider. A new ticket is investigated and drafted after
 * its brief (T-108), so the work of an earlier case can still be running when the next one starts.
 */
async function quiet(): Promise<void> {
  let last = -1;
  while (last !== providerCalls) {
    last = providerCalls;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
}

const runsOf = (ticketId: string) =>
  owner().select().from(schema.aiRun).where(eq(schema.aiRun.ticketId, ticketId));

const setKillSwitch = (on: boolean) =>
  testDb.owner.pool.query(
    `UPDATE ai_switch SET is_on = $1, reason = 'test' WHERE key = 'ai_kill_switch'`,
    [on],
  );

describe('AI brief, end to end on the mock provider', () => {
  it('classifies at ingest with an ai_run row, then summarizes after the ticket exists', async () => {
    const eventId = await receiveMail(
      'Cannot login',
      'I forgot my password and I am locked out. Please write to pat.example@customer.example.test',
    );
    const inbound = await ticketOf(eventId);
    const ticketId = inbound.ticketId ?? '';

    // 1. Ingest classification came from the AI agent and points at its ai_run row.
    expect(inbound.classification).toMatchObject({ type: 'new_customer_issue', source: 'ai' });
    const aiRunId = (inbound.classification as { aiRunId: string }).aiRunId;
    const [classifierRun] = await owner()
      .select()
      .from(schema.aiRun)
      .where(eq(schema.aiRun.id, aiRunId));
    expect(classifierRun).toMatchObject({
      agent: 'classifier',
      provider: 'mock',
      model: 'mock-light',
      ticketId: null,
      status: 'ok',
    });
    const [ticket] = await owner()
      .select()
      .from(schema.ticket)
      .where(eq(schema.ticket.id, ticketId));
    const [intent] = await owner()
      .select()
      .from(schema.intent)
      .where(eq(schema.intent.id, ticket?.intentId ?? ''));
    expect(intent?.key).toBe('access_issue');

    // 2. The summarize job ran (outbox -> BullMQ -> worker) and left the insight.
    const insight = await insightOf(ticketId);
    expect(insight).toMatchObject({
      state: 'classified',
      reasonCode: null,
      intentKey: 'access_issue',
      nextStepKind: 'reply',
      stage: 2,
    });
    expect(insight.intentConfidence).toBeGreaterThan(0.5);
    expect(insight.summary).toContain('forgot my password');
    expect(insight.classifierRunId).not.toBeNull();
    expect(insight.summarizerRunId).not.toBeNull();

    // 3. Both runs are on record, redacted: the address is in neither the input hash nor the output.
    const runs = await runsOf(ticketId);
    expect(runs.map((run) => run.agent).toSorted()).toEqual(['classifier', 'summarizer']);
    for (const run of runs) {
      expect(run).toMatchObject({ provider: 'mock', model: 'mock-light', status: 'ok' });
      expect(run.redaction.total).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(run)).not.toContain('pat.example@customer.example.test');
    }
    expect(JSON.stringify(runs.find((run) => run.agent === 'summarizer')?.output)).toContain(
      '[EMAIL_1]',
    );
  });

  it('redacts a name that no dictionary knows when a cue introduces it (QA-30)', async () => {
    const eventId = await receiveMail(
      'Export fails',
      'Hello, my name is Somchai Jaidee and the portal export keeps failing.\n\nBest regards,\nSomchai Jaidee',
    );
    const inbound = await ticketOf(eventId);
    const ticketId = inbound.ticketId ?? '';
    await insightOf(ticketId);
    await quiet();
    expect(seenRequests.length).toBeGreaterThan(0);
    const mine = seenRequests.filter((request) => request.includes('Export fails'));
    expect(mine.length).toBeGreaterThan(0);
    for (const request of mine) {
      expect(request).not.toContain('Somchai');
      expect(request).not.toContain('Jaidee');
    }
    for (const run of await runsOf(ticketId)) {
      expect(JSON.stringify(run)).not.toContain('Somchai');
    }
  });

  it('summarizes a ticket made through the domain (portal path) in Thai', async () => {
    const created = await appDatabase.db.transaction((tx) =>
      domain.tickets.create(tx, domain.context({ actor: { type: 'system', id: null } }), {
        orgId,
        subject: 'ระบบล่ม',
        body: 'ระบบล่ม ใช้งานไม่ได้ตั้งแต่เช้า ช่วยตรวจสอบด่วน',
        requester: { email: 'thai.customer@customer.example.test', name: 'สมชาย ใจดี' },
      }),
    );
    const ticketId = created.value.ticket.id;
    const insight = await insightOf(ticketId);
    expect(insight.state).toBe('classified');
    expect(insight.intentKey).toBe('incident_report');
    expect(insight.nextStepKind).toBe('escalate_dev');
    expect(insight.summary).toMatch(/[฀-๿]/);
  });

  it('kill switch: no model call, rules classify the mail, the insight says a person is needed', async () => {
    await quiet();
    await setKillSwitch(true);
    try {
      const before = providerCalls;
      const eventId = await receiveMail('Cannot login again', 'I forgot my password again');
      const inbound = await ticketOf(eventId);
      const insight = await insightOf(inbound.ticketId ?? '');
      expect(inbound.classification).toMatchObject({ source: 'rules' });
      expect(insight).toMatchObject({
        state: 'needs_human',
        reasonCode: 'kill_switch_on',
        summary: null,
        nextStepKind: 'other',
      });
      expect(providerCalls).toBe(before);
      expect(await runsOf(inbound.ticketId ?? '')).toHaveLength(0);
    } finally {
      await setKillSwitch(false);
    }
  });

  it('daily cap reached: no model call and the stop is on the audit log', async () => {
    // A real-provider run today that used up the token cap (the mock is free and never counts).
    await testDb.owner.pool.query(
      `INSERT INTO ai_run (started_at, agent, provider, model, tier, prompt_id, prompt_version,
                           prompt_hash, input_hmac, redaction, input_tokens, status)
       VALUES (now(), 'summarizer', 'anthropic', 'priced-model', 'light', 'summarizer', 1,
               repeat('a', 64), repeat('b', 64), '{"total":0,"byKind":{}}', 100000, 'ok')`,
    );
    await quiet();
    const before = providerCalls;
    const eventId = await receiveMail('Invoice question', 'My invoice is wrong');
    const inbound = await ticketOf(eventId);
    const insight = await insightOf(inbound.ticketId ?? '');
    expect(inbound.classification).toMatchObject({ source: 'rules' });
    expect(insight).toMatchObject({ state: 'needs_human', reasonCode: 'budget_stop' });
    expect(providerCalls).toBe(before);
    const stops = (await owner().select().from(schema.auditLog)).filter(
      (row) => row.action === AUDIT_ACTIONS.aiBudgetStop,
    );
    expect(stops).toHaveLength(1);
    const events = await owner().select().from(schema.aiBudgetEvent);
    expect(events.map((event) => `${event.dimension}:${event.level}`)).toContain('tokens:stop');
  });
});
