import { randomBytes, randomUUID } from 'node:crypto';

import {
  ConnectorRateLimitedError,
  FakeLogsClient,
  type LogEntry,
} from '@watchtower/connectors';
import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { createDbToolLedger, createHumanToolLedger } from '@watchtower/domain';
import { AI_TOOL_BUDGETS, LOGGING_RATE_BUDGET } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// AC-5 (PRD section 4.5): "AI runs cannot exceed the shared Logging rate budget (verified by a load
// test)". The fake answers 429 past 60 requests a minute on an injected clock, as Cloud Logging does.
// In front of it stand the AI ledger of T-108 and the human ledger of T-203d, both on the one window of
// `rate_budget_window`. The test proves the fake is never asked more than the budget (no 429), that
// the AI never takes more than its share, and, without the budget, that the fake does say 429.
const net = disableNetConnect();
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
let database: Database;
let now = Date.parse('2026-03-10T12:00:00.000Z');
const clock = (): number => now;
const project = `load-${randomBytes(3).toString('hex')}`;

const LINES: readonly LogEntry[] = [
  {
    insertId: 'x1',
    timestamp: '2026-03-10T11:59:00.000Z',
    severity: 'ERROR',
    service: 'svc-a',
    message: 'delivery failed',
    labels: {},
  },
];
const range = () => ({ from: new Date(now - 3_600_000), to: new Date(now) });
const hash = (): string => randomBytes(32).toString('hex');

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  database = createDatabase({ url: testDb.appUrl, max: 10, applicationName: 'wt-load-test' });
});
afterAll(async () => {
  await database.close();
  await testDb.cleanup();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

type Outcome = 'served' | 'refused' | '429' | 'error';

/** One call to the (fake) provider, taken through the ledger of its caller first. */
function callers(logs: FakeLogsClient) {
  const ai = createDbToolLedger({
    db: database.db,
    limits: { perRun: 10_000, perTicketPerHour: 10_000, perToolPerMinute: AI_TOOL_BUDGETS.perToolPerMinute },
    project,
  });
  const human = createHumanToolLedger({ db: database.db, project });
  const read = async (): Promise<'ok' | '429' | 'error'> => {
    try {
      await logs.listEntries({ filter: 'service="svc-a"', pageSize: 10, ...range() });
      return 'ok';
    } catch (error) {
      return error instanceof ConnectorRateLimitedError ? '429' : 'error';
    }
  };
  return {
    async ai(): Promise<Outcome> {
      const decision = await ai.begin({
        runKey: randomUUID(),
        ticketId: null,
        agent: 'investigator',
        tool: 'gcp_logs',
        intent: null,
        stage: 2,
        inputHash: hash(),
        mock: true,
      });
      if (!decision.allowed) return 'refused';
      const outcome = await read();
      await ai.finish(decision.id, {
        status: outcome === 'ok' ? 'ok' : 'error',
        errorCode: outcome === 'ok' ? null : 'ConnectorError',
        latencyMs: 1,
        resultCount: 1,
      });
      return outcome === 'ok' ? 'served' : outcome;
    },
    async human(): Promise<Outcome> {
      const decision = await human.begin({
        runKey: randomUUID(),
        ticketId: null,
        agent: 'human',
        tool: 'gcp_logs',
        inputHash: hash(),
        mock: true,
        actor: 'human',
      });
      if (!decision.allowed) return 'refused';
      const outcome = await read();
      await human.finish(decision.id, {
        status: outcome === 'ok' ? 'ok' : 'error',
        errorCode: outcome === 'ok' ? null : 'ConnectorError',
        latencyMs: 1,
        resultCount: 1,
      });
      return outcome === 'ok' ? 'served' : outcome;
    },
    direct: read,
  };
}

const count = (list: readonly string[], what: string): number => list.filter((x) => x === what).length;

describe('the fake of the provider', () => {
  it('answers 429 past 60 requests a minute on its injected clock (nothing in front of it)', async () => {
    const logs = new FakeLogsClient({ entries: LINES, quotaPerMinute: 60, clock });
    const results = await Promise.all(Array.from({ length: 100 }, () => callers(logs).direct()));
    expect(count(results, 'ok')).toBe(LOGGING_RATE_BUDGET.providerQuotaPerMinute);
    expect(count(results, '429')).toBe(40);
  });
});

describe('with the shared budget in front (AC-5 load test)', () => {
  it('never asks the provider for more than 55 in a minute, so it never answers 429, and the AI stays within 30', async () => {
    const logs = new FakeLogsClient({ entries: LINES, quotaPerMinute: 60, clock });
    const c = callers(logs);
    // 400 attempts arriving together: 250 from AI runs, 150 from people.
    const attempts: Promise<Outcome>[] = [
      ...Array.from({ length: 250 }, () => c.ai()),
      ...Array.from({ length: 150 }, () => c.human()),
    ];
    const results = await Promise.all(attempts);
    const ai = results.slice(0, 250);
    const people = results.slice(250);
    expect(count(results, '429')).toBe(0);
    expect(count(results, 'error')).toBe(0);
    expect(logs.served).toBe(LOGGING_RATE_BUDGET.totalPerMinute);
    expect(count(results, 'served')).toBe(LOGGING_RATE_BUDGET.totalPerMinute);
    expect(count(ai, 'served')).toBeLessThanOrEqual(LOGGING_RATE_BUDGET.aiPerMinute);
    // People got every unit the AI did not use.
    expect(count(people, 'served')).toBe(LOGGING_RATE_BUDGET.totalPerMinute - count(ai, 'served'));

    const rows = (await database.db.select().from(schema.toolExecution)).filter(
      (row) => row.tool === 'gcp_logs',
    );
    expect(rows.filter((row) => row.status === 'ok')).toHaveLength(55);
    expect(rows.filter((row) => row.status === 'denied')).toHaveLength(400 - 55);
    expect(rows.filter((row) => row.status === 'running')).toHaveLength(0);
    expect(rows.filter((row) => row.agent === 'investigator' && row.status === 'ok').length).toBeLessThanOrEqual(30);
  });

  it('serves again a minute later, on both clocks', async () => {
    const logs = new FakeLogsClient({ entries: LINES, quotaPerMinute: 60, clock });
    const c = callers(logs);
    expect(await c.human()).toBe('refused');
    // The provider's window and ours both move on by a minute.
    now += 61_000;
    await testDb.owner.pool.query(
      `UPDATE rate_budget_window SET slot = slot - interval '62 seconds' WHERE resource LIKE $1`,
      [`%:${project}`],
    );
    const results = await Promise.all(Array.from({ length: 80 }, () => c.human()));
    expect(count(results, '429')).toBe(0);
    expect(count(results, 'served')).toBe(LOGGING_RATE_BUDGET.totalPerMinute);
  });
});
