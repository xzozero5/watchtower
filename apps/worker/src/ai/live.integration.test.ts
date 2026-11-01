import { classifyTicket } from '@watchtower/ai';
import { createCredentialStore, createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { AUDIT_ACTIONS } from '@watchtower/shared';
import { localKmsFromConfig } from '@watchtower/shared/credential-box';
import { disableNetConnect } from '@watchtower/shared/testing';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../logger.js';
import { createReplayFetch, forbiddenFetch, readFixture } from '../testing/replay-fetch.js';
import { testConfig } from '../testing/support.js';
import { createAiRuntime, type AiOverrides, type AiRuntime } from './runtime.js';

// T-132: the real adapter selected by AI_PROVIDER, on a real Postgres (restricted application
// role), with a fixture `fetch` as the only network access. disableNetConnect makes any other
// outgoing connection fail the test. The fixtures are hand-written from the documented response
// shape; nothing here calls a provider.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const net = disableNetConnect();

// Made-up values that only have to be non-empty. They are not credentials.
const DB_KEY = 'db-key-not-a-secret';
const ENV_KEY = 'env-key-not-a-secret';
const MODELS = {
  AI_MODEL_DEEP: 'label-deep',
  AI_MODEL_STANDARD: 'label-standard',
  AI_MODEL_LIGHT: 'label-light',
  AI_MODEL_PRICES: JSON.stringify({
    'label-deep': { inputUsdPerMTok: 10, outputUsdPerMTok: 50 },
    'label-standard': { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    // Fixture usage is 1000 in / 50 out: 1000 * 1 + 50 * 5 = 1250 micro-dollars per call.
    'label-light': { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
  }),
};
const COST_PER_CALL = 0.00125;
const EMAIL = 'somchai.jaidee@customer.example.test';
const fixture = readFixture('anthropic-classifier.json');

let testDb: TestDatabase;
let appDatabase: Database;
const owner = () => testDb.owner.db;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  appDatabase = createDatabase({ url: testDb.appUrl, max: 4, applicationName: 'wt-live-ai-test' });
});

afterAll(async () => {
  await appDatabase.close();
  await testDb.cleanup();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

function runtimeFor(env: Record<string, string>, overrides: AiOverrides = {}): AiRuntime {
  const config = testConfig({ DATABASE_URL: testDb.appUrl, ...env });
  return createAiRuntime(config, appDatabase, createLogger(config), overrides);
}

const anthropicEnv = (extra: Record<string, string> = {}) => ({
  AI_PROVIDER: 'anthropic',
  ...MODELS,
  ...extra,
});

async function classify(runtime: AiRuntime) {
  const deps = runtime.agentDeps(['Somchai Jaidee']);
  return classifyTicket(deps, {
    ticketId: null,
    scope: 'inbound:live-test',
    channel: 'gmail',
    subject: 'Cannot sign in',
    body: `Hi, this is Somchai Jaidee. I cannot sign in. Reach me at ${EMAIL} or 081-234-5678.`,
    intents: [{ key: 'access_issue', name: 'Cannot sign in or reset a password' }],
  });
}

const latestRun = async () => {
  const [row] = await owner()
    .select()
    .from(schema.aiRun)
    .orderBy(desc(schema.aiRun.startedAt))
    .limit(1);
  return row;
};

describe('AI_PROVIDER=anthropic through the real adapter (fixture fetch only)', () => {
  it('classifies, meters the cost from the configured price and leaves a redacted ai_run row', async () => {
    const replay = createReplayFetch(fixture);
    const runtime = runtimeFor(anthropicEnv({ ANTHROPIC_API_KEY: ENV_KEY }), {
      fetch: replay.fetch,
    });
    expect(runtime.provider).toBe('anthropic');
    await expect(runtime.readiness()).resolves.toEqual({ ready: true, problems: [] });

    const outcome = await classify(runtime);

    expect(outcome).toMatchObject({
      status: 'ok',
      value: { type: 'new_customer_issue', intentKey: 'access_issue' },
    });
    expect(replay.requests).toHaveLength(1);
    const run = await latestRun();
    expect(run).toMatchObject({
      agent: 'classifier',
      provider: 'anthropic',
      model: 'label-light',
      tier: 'light',
      status: 'ok',
      inputTokens: 1000,
      outputTokens: 50,
    });
    expect(Number(run?.costUsd)).toBeCloseTo(COST_PER_CALL, 8);
    expect(run?.redaction.total).toBeGreaterThanOrEqual(3);
    expect(run?.promptId).toBe('classifier');
    expect(JSON.stringify(run)).not.toContain(EMAIL);
    expect(JSON.stringify(run)).not.toContain('Somchai');
  });

  it('redaction proof: the outgoing request body of the real adapter holds placeholders only', async () => {
    const replay = createReplayFetch(fixture);
    const runtime = runtimeFor(anthropicEnv({ ANTHROPIC_API_KEY: ENV_KEY }), {
      fetch: replay.fetch,
    });
    await classify(runtime);

    const wire = replay.requests[0]?.rawBody ?? '';
    expect(wire).toContain('[EMAIL_1]');
    expect(wire).toContain('[PHONE_1]');
    expect(wire).toContain('[NAME_1]');
    for (const secret of [EMAIL, 'Somchai', 'Jaidee', '081-234-5678', ENV_KEY]) {
      expect(wire, secret).not.toContain(secret);
    }
    // The model id on the wire is the configured one, not a literal from code.
    expect((replay.requests[0]?.body as { model: string }).model).toBe('label-light');
  });

  it('reads the key from the credential store; the environment wins over the database (ADR-012)', async () => {
    const config = testConfig({ DATABASE_URL: testDb.appUrl, ...anthropicEnv() });
    const store = createCredentialStore({
      database: appDatabase,
      kms: localKmsFromConfig(config),
      env: {},
    });
    await store.put('ai', { anthropicApiKey: DB_KEY }, null);

    const fromDb = createReplayFetch(fixture);
    await classify(runtimeFor(anthropicEnv(), { fetch: fromDb.fetch }));
    expect(fromDb.requests[0]?.headers['x-api-key']).toBe(DB_KEY);

    const fromEnv = createReplayFetch(fixture);
    await classify(
      runtimeFor(anthropicEnv({ ANTHROPIC_API_KEY: ENV_KEY }), { fetch: fromEnv.fetch }),
    );
    expect(fromEnv.requests[0]?.headers['x-api-key']).toBe(ENV_KEY);

    await store.remove('ai', 'anthropicApiKey');
  });

  it('without a key it fails visibly: nothing is sent, the run is an error row, never a mock answer', async () => {
    const runtime = runtimeFor(anthropicEnv(), { fetch: forbiddenFetch });
    const state = await runtime.readiness();
    expect(state.ready).toBe(false);
    expect(state.problems).toEqual([expect.stringContaining('Anthropic API key')]);

    const outcome = await classify(runtime);

    expect(outcome).toEqual({ status: 'failed', reason: 'provider_unavailable' });
    const run = await latestRun();
    expect(run).toMatchObject({
      provider: 'anthropic',
      model: 'label-light',
      status: 'error',
      errorCode: 'ProviderUnavailableError',
      output: null,
    });
  });

  it('the kill switch stops it before the adapter is reached', async () => {
    const replay = createReplayFetch(fixture);
    const runtime = runtimeFor(anthropicEnv({ ANTHROPIC_API_KEY: ENV_KEY }), {
      fetch: replay.fetch,
    });
    await testDb.owner.pool.query(
      `UPDATE ai_switch SET is_on = true, reason = 'test' WHERE key = 'ai_kill_switch'`,
    );
    try {
      await expect(classify(runtime)).resolves.toEqual({
        status: 'skipped',
        reason: 'kill_switch_on',
      });
      expect(replay.requests).toHaveLength(0);
    } finally {
      await testDb.owner.pool.query(
        `UPDATE ai_switch SET is_on = false WHERE key = 'ai_kill_switch'`,
      );
    }
  });

  it('the daily cost cap stops it: the call that reaches the cap is the last one sent', async () => {
    const spentRows = await owner().select({ cost: schema.aiRun.costUsd }).from(schema.aiRun);
    const spent = spentRows.reduce((sum, row) => sum + Number(row.cost ?? 0), 0);
    // Room for one call, and a second that reaches the cap.
    const cap = spent + COST_PER_CALL * 1.5;
    const replay = createReplayFetch(fixture);
    const runtime = runtimeFor(
      anthropicEnv({ ANTHROPIC_API_KEY: ENV_KEY, AI_DAILY_COST_CAP_USD: String(cap) }),
      { fetch: replay.fetch },
    );

    expect((await classify(runtime)).status).toBe('ok');
    expect((await classify(runtime)).status).toBe('ok');
    const stopped = await classify(runtime);

    expect(stopped).toEqual({ status: 'skipped', reason: 'budget_stop' });
    expect(replay.requests).toHaveLength(2);
    const stops = (await owner().select().from(schema.auditLog)).filter(
      (row) => row.action === AUDIT_ACTIONS.aiBudgetStop,
    );
    expect(stops.length).toBeGreaterThanOrEqual(1);
  });
});

describe('AI_PROVIDER=mock (the default) never touches the network', () => {
  it('answers offline: no fetch, no outgoing connection, a mock ai_run row', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const runtime = runtimeFor({}, { fetch: forbiddenFetch });
      expect(runtime.provider).toBe('mock');
      const outcome = await classify(runtime);
      expect(outcome.status).toBe('ok');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    expect(net.blocked()).toEqual([]);
    const [run] = await owner()
      .select()
      .from(schema.aiRun)
      .where(eq(schema.aiRun.provider, 'mock'))
      .limit(1);
    expect(run).toMatchObject({ provider: 'mock', model: 'mock-light', status: 'ok' });
  });

  it('ignores AI_MODEL_* and a stray ANTHROPIC_API_KEY: selecting mock never reaches a vendor', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const runtime = runtimeFor({ ...MODELS, ANTHROPIC_API_KEY: ENV_KEY });
      expect(runtime.provider).toBe('mock');
      expect((await classify(runtime)).status).toBe('ok');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
