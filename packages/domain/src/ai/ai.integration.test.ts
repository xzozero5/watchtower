import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import { AUDIT_ACTIONS } from '@watchtower/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPolicyGate } from '../autonomy/gate.js';
import {
  addIntent,
  addOrg,
  addPolicy,
  addStaff,
  auditRows,
  startDomainTest,
  type DomainTestEnv,
} from '../testing/support.js';
import { createBudgetMonitor, type BudgetEventNotice } from './budget.js';
import { createAiGuard } from './guard.js';
import { upsertAiInsight } from './insight.js';
import { createAiRunRecorder, type AiRunInput } from './recorder.js';

let env: DomainTestEnv;
let ticketId: string;
let intentId: string;

const INSUFFICIENT_PRIVILEGE = '42501';
const RESTRICT_VIOLATION = '23001';

beforeAll(async () => {
  env = await startDomainTest();
  await addPolicy(
    env,
    { P3: { first_response_min: 60, resolution_min: 240, calendar: '24x7' } },
    'standard',
  );
  const org = await addOrg(env);
  const staff = await addStaff(env);
  const intent = await addIntent(env, { autonomyStage: 2 });
  intentId = intent.id;
  const created = await env.tx((tx) =>
    env.domain.tickets.create(tx, env.ctx(staff.actor), {
      orgId: org.id,
      subject: 'Cannot sign in',
      body: 'Password rejected',
      requester: { email: 'someone@example.test', name: 'Someone' },
      intentId,
    }),
  );
  ticketId = created.value.ticket.id;
});
afterAll(async () => {
  await env.close();
});

function run(overrides: Partial<AiRunInput> = {}): AiRunInput {
  return {
    agent: 'classifier',
    provider: 'mock',
    model: 'mock-light',
    tier: 'light',
    prompt: { id: 'classifier', version: 1, hash: 'a'.repeat(64) },
    tools: [],
    inputHash: 'b'.repeat(64),
    output: '{"type":"triage"} [EMAIL_1]',
    confidence: 0.7,
    redaction: { total: 2, byKind: { EMAIL: 1, PHONE: 1 } },
    inputTokens: 120,
    outputTokens: 30,
    costUsd: 0.0012,
    latencyMs: 41.6,
    status: 'ok',
    errorCode: null,
    intent: null,
    ticketId,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

const sqlState = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
  } catch (error) {
    let current: unknown = error;
    while (typeof current === 'object' && current !== null) {
      if ('code' in current && typeof current.code === 'string') return current.code;
      current = 'cause' in current ? current.cause : undefined;
    }
  }
  return undefined;
};

describe('the ai_run recorder', () => {
  const recorder = () => createAiRunRecorder({ db: env.database.db });

  it('writes one row per call in its own transaction and returns the id', async () => {
    const receipt = await recorder().record(run());
    const [row] = await env.db.owner.db
      .select()
      .from(schema.aiRun)
      .where(eq(schema.aiRun.id, receipt.id));
    expect(row).toMatchObject({
      agent: 'classifier',
      ticketId,
      provider: 'mock',
      model: 'mock-light',
      promptId: 'classifier',
      promptVersion: 1,
      inputHmac: 'b'.repeat(64),
      confidence: 0.7,
      redaction: { total: 2, byKind: { EMAIL: 1, PHONE: 1 } },
      costUsd: '0.00120000',
      latencyMs: 42,
      status: 'ok',
    });
    expect(row?.output).toBe('{"type":"triage"} [EMAIL_1]');
  });

  it('keeps a ticketless call (the ingest classifier) and an error row', async () => {
    const a = await recorder().record(run({ ticketId: null }));
    const b = await recorder().record(
      run({ status: 'error', errorCode: 'ProviderError', output: null, costUsd: null }),
    );
    const rows = await env.db.owner.db.select().from(schema.aiRun);
    expect(rows.find((row) => row.id === a.id)?.ticketId).toBeNull();
    expect(rows.find((row) => row.id === b.id)).toMatchObject({
      status: 'error',
      errorCode: 'ProviderError',
      output: null,
      costUsd: null,
    });
  });

  it('refuses a ticket id that is not a uuid, before touching the table', async () => {
    await expect(recorder().record(run({ ticketId: 'T-1' }))).rejects.toThrow(/uuid/);
  });

  it('lands in the partition of the current month', async () => {
    const receipt = await recorder().record(run());
    const result = await env.db.owner.pool.query<{ part: string }>(
      `SELECT tableoid::regclass::text AS part FROM ai_run WHERE id = $1`,
      [receipt.id],
    );
    const now = new Date();
    const expected = `ai_run_p${String(now.getUTCFullYear())}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(result.rows[0]?.part).toBe(expected);
  });

  it('is append-only: the application role cannot UPDATE, DELETE or TRUNCATE, and nobody can by trigger', async () => {
    const receipt = await recorder().record(run());
    const app = env.database.pool;
    expect(
      await sqlState(app.query(`UPDATE ai_run SET status = 'ok' WHERE id = $1`, [receipt.id])),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(app.query(`DELETE FROM ai_run WHERE id = $1`, [receipt.id]))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await sqlState(app.query(`TRUNCATE ai_run`))).toBe(INSUFFICIENT_PRIVILEGE);
    // The schema owner is stopped by the trigger.
    const owner = env.db.owner.pool;
    expect(
      await sqlState(owner.query(`UPDATE ai_run SET status = 'ok' WHERE id = $1`, [receipt.id])),
    ).toBe(RESTRICT_VIOLATION);
    expect(await sqlState(owner.query(`DELETE FROM ai_run WHERE id = $1`, [receipt.id]))).toBe(
      RESTRICT_VIOLATION,
    );
    expect(await sqlState(owner.query(`TRUNCATE ai_run`))).toBe(RESTRICT_VIOLATION);
  });

  it('rejects rows the database must not hold (bad hash, confidence, provider)', async () => {
    const app = env.database.db;
    const insert = (values: Partial<typeof schema.aiRun.$inferInsert>) =>
      app.insert(schema.aiRun).values({
        startedAt: new Date(),
        agent: 'classifier',
        provider: 'mock',
        model: 'm',
        tier: 'light',
        promptId: 'classifier',
        promptVersion: 1,
        promptHash: 'a'.repeat(64),
        inputHmac: 'b'.repeat(64),
        redaction: { total: 0, byKind: {} },
        status: 'ok',
        ...values,
      });
    expect(await sqlState(insert({ inputHmac: 'plain input text' }))).toBe('23514');
    expect(await sqlState(insert({ confidence: 1.5 }))).toBe('23514');
    expect(await sqlState(insert({ provider: 'someone-else' }))).toBe('23514');
  });
});

describe('ai_ticket_insight', () => {
  it('keeps one row per ticket and replaces it on the next upsert, leaving evidence alone', async () => {
    const db = env.database.db;
    await upsertAiInsight(db, {
      ticketId,
      state: 'classified',
      summary: 'first',
      intent: { key: 'access_issue', confidence: 0.8, reason: 'password' },
      nextStep: { kind: 'reply', label: 'Reply' },
      stage: 2,
      generatedAt: new Date('2026-11-01T01:00:00Z'),
    });
    await env.db.owner.pool.query(
      `UPDATE ai_ticket_insight SET evidence = '[{"id":"e1"}]'::jsonb WHERE ticket_id = $1`,
      [ticketId],
    );
    await upsertAiInsight(db, {
      ticketId,
      state: 'needs_human',
      reasonCode: 'budget_stop',
      stage: 2,
      generatedAt: new Date('2026-11-01T02:00:00Z'),
    });
    const rows = await db
      .select()
      .from(schema.aiTicketInsight)
      .where(eq(schema.aiTicketInsight.ticketId, ticketId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: 'needs_human',
      reasonCode: 'budget_stop',
      summary: null,
      intentKey: null,
      evidence: [{ id: 'e1' }],
    });
    expect(rows[0]?.generatedAt.toISOString()).toBe('2026-11-01T02:00:00.000Z');
  });

  it('rejects a state the contract does not know, and a missing ticket', async () => {
    const db = env.database.db;
    expect(
      await sqlState(
        upsertAiInsight(db, {
          ticketId,
          state: 'whatever' as never,
          stage: 0,
          generatedAt: new Date(),
        }),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        upsertAiInsight(db, {
          ticketId: randomUUID(),
          state: 'none',
          stage: 0,
          generatedAt: new Date(),
        }),
      ),
    ).toBe('23503');
  });
});

describe('daily caps', () => {
  const caps = { dailyCostUsd: 10, dailyTokens: 1_000_000, alertPercent: 80 };

  async function spend(costUsd: number, provider = 'anthropic', tokens = 10): Promise<void> {
    await createAiRunRecorder({ db: env.database.db }).record(
      run({ provider, model: `${provider}-model`, costUsd, inputTokens: tokens, outputTokens: 0 }),
    );
  }

  it('alerts once at 80 percent, stops at 100, and records both in the audit log', async () => {
    const events: BudgetEventNotice[] = [];
    const monitor = createBudgetMonitor({
      db: env.database.db,
      caps,
      onEvent: (notice) => events.push(notice),
    });
    expect((await monitor.check()).level).toBe('ok');

    // The mock provider is free: it never counts.
    await spend(500, 'mock');
    expect((await monitor.check()).level).toBe('ok');

    await spend(8.5);
    expect((await monitor.check()).level).toBe('alert');
    expect((await monitor.check()).level).toBe('alert');
    expect(events.map((event) => `${event.dimension}:${event.level}`)).toEqual(['cost:alert']);
    expect(await auditRows(env, AUDIT_ACTIONS.aiBudgetAlert)).toHaveLength(1);

    await spend(1.5);
    const stopped = await monitor.check();
    expect(stopped.level).toBe('stop');
    expect(stopped.usage.costUsd).toBeCloseTo(10.0012 + 0, 0);
    await monitor.check();
    expect(events.map((event) => `${event.dimension}:${event.level}`)).toEqual([
      'cost:alert',
      'cost:stop',
    ]);
    const stops = await auditRows(env, AUDIT_ACTIONS.aiBudgetStop);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ actorType: 'system', outcome: 'denied' });
    expect(stops[0]?.metadata).toMatchObject({ dimension: 'cost', cap: 10, alertPercent: 80 });
  });

  it('the token cap works on its own, and unpriced runs still count their tokens', async () => {
    const tokenCaps = { dailyCostUsd: 1_000_000, dailyTokens: 5_000, alertPercent: 80 };
    const monitor = createBudgetMonitor({ db: env.database.db, caps: tokenCaps });
    // Nothing from the cost test above reaches 5,000 tokens by itself.
    const before = (await monitor.check()).usage.tokens;
    await createAiRunRecorder({ db: env.database.db }).record(
      run({
        provider: 'vertex',
        model: 'unpriced',
        costUsd: null,
        inputTokens: 5_000 - before,
        outputTokens: 0,
      }),
    );
    const status = await monitor.check();
    expect(status.level).toBe('stop');
    expect(status.findings.map((finding) => finding.dimension)).toContain('tokens');
  });
});

describe('the guard before a model call', () => {
  const generous = { dailyCostUsd: 1_000_000, dailyTokens: 1_000_000_000, alertPercent: 80 };
  const guardWith = (caps = generous, gate = createPolicyGate({ db: env.database.db })) =>
    createAiGuard({
      policyGate: gate,
      db: env.database.db,
      budget: createBudgetMonitor({ db: env.database.db, caps }),
    });
  const ask = (guard: ReturnType<typeof guardWith>) =>
    guard.check({ agent: 'summarizer', ticketId, action: 'summarize' });
  const setSwitch = (on: boolean) =>
    env.db.owner.pool.query(
      `UPDATE ai_switch SET is_on = $1, reason = 'test' WHERE key = 'ai_kill_switch'`,
      [on],
    );

  it('allows when the switch is off and the budget has room', async () => {
    await setSwitch(false);
    expect(await ask(guardWith())).toEqual({ allowed: true });
  });

  it('answers kill_switch_on the moment the kill switch is flipped, and audits the denial', async () => {
    await setSwitch(true);
    try {
      const before = (await auditRows(env, AUDIT_ACTIONS.autonomyPolicyDenied)).length;
      expect(await ask(guardWith())).toEqual({ allowed: false, reason: 'kill_switch_on' });
      expect((await auditRows(env, AUDIT_ACTIONS.autonomyPolicyDenied)).length).toBe(before + 1);
    } finally {
      await setSwitch(false);
    }
  });

  it('answers budget_stop when the day is spent', async () => {
    // The previous suite spent more than 1 USD of real-provider cost today.
    const decision = await ask(
      guardWith({ dailyCostUsd: 1, dailyTokens: 1_000_000_000, alertPercent: 80 }),
    );
    expect(decision).toEqual({ allowed: false, reason: 'budget_stop' });
  });

  it('fails closed without a gate, and when the database errors', async () => {
    expect(
      await createAiGuard({
        policyGate: undefined,
        db: env.database.db,
        budget: createBudgetMonitor({ db: env.database.db, caps: generous }),
      }).check({ agent: 'summarizer', ticketId, action: 'summarize' }),
    ).toEqual({ allowed: false, reason: 'policy_denied' });

    const broken = createAiGuard({
      policyGate: createPolicyGate({ db: env.database.db }),
      db: env.database.db,
      budget: { check: () => Promise.reject(new Error('db down')) },
    });
    expect(await ask(broken)).toEqual({ allowed: false, reason: 'policy_denied' });
  });
});

describe('a new ticket queues its AI brief', () => {
  it('writes one ai/summarize outbox job in the ticket transaction, once per ticket', async () => {
    const jobs = await env.db.owner.db
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.jobId, `ai-summarize-${ticketId}`));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ queue: 'ai', jobName: 'summarize' });
    expect(jobs[0]?.payload).toEqual({ ticketId });
  });
});
