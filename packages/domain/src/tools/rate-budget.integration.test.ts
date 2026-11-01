import { randomBytes, randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import {
  AI_TOOL_BUDGETS,
  LOGGING_RATE_BUDGET,
  rateBudgetFor,
  type RateActor,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbToolLedger } from '../ai/tool-ledger.js';
import { startDomainTest, type DomainTestEnv } from '../testing/support.js';
import { createHumanToolLedger } from './human-ledger.js';
import { takeRateBudget, type RateDecision } from './rate-budget.js';

// T-203b: the shared minute window. Everything here runs against Postgres; the decision is made by
// the database clock under an advisory lock, so parallel callers cannot both take the last unit.
let env: DomainTestEnv;
beforeAll(async () => {
  env = await startDomainTest();
});
afterAll(async () => {
  await env.close();
});

const owner = () => env.db.owner.pool;
const logging = (project: string) => rateBudgetFor('gcp_logs', { project });
const take = (project: string, actor: RateActor) =>
  takeRateBudget(env.database.db, { ...logging(project), actor });

async function usage(project: string): Promise<{ total: number; ai: number }> {
  const { rows } = await owner().query<{ total: number; ai: number }>(
    `SELECT COALESCE(sum(total), 0)::int AS total, COALESCE(sum(ai), 0)::int AS ai
       FROM rate_budget_window WHERE resource = $1`,
    [logging(project).resource],
  );
  return rows[0] ?? { total: 0, ai: 0 };
}

describe('the numbers', () => {
  it('uses 55 of the provider\'s 60 a minute, and 30 of them for the AI', () => {
    expect(LOGGING_RATE_BUDGET).toEqual({
      providerQuotaPerMinute: 60,
      totalPerMinute: 55,
      aiPerMinute: 30,
    });
    expect(logging('p')).toEqual({ resource: 'logging:p', totalPerMinute: 55, aiPerMinute: 30 });
    // The AI-only tools keep the per-tool limit they had before (T-108).
    expect(rateBudgetFor('kb_search')).toEqual({
      resource: 'tool:kb_search',
      totalPerMinute: AI_TOOL_BUDGETS.perToolPerMinute,
      aiPerMinute: AI_TOOL_BUDGETS.perToolPerMinute,
    });
  });
});

describe('acquire', () => {
  it('grants exactly the total, however many callers arrive at once', async () => {
    const project = `race-${randomBytes(3).toString('hex')}`;
    const results = await Promise.all(Array.from({ length: 120 }, () => take(project, 'human')));
    expect(results.filter((r) => r.granted)).toHaveLength(LOGGING_RATE_BUDGET.totalPerMinute);
    expect(await usage(project)).toEqual({ total: 55, ai: 0 });
    const refused = results.find((r): r is Extract<RateDecision, { granted: false }> => !r.granted);
    expect(refused).toMatchObject({ granted: false, reason: 'total' });
    expect(refused?.retryAfterMs).toBeGreaterThan(0);
  });

  it('keeps the AI to its share when AI and people arrive together, and people use what is left', async () => {
    const project = `mixed-${randomBytes(3).toString('hex')}`;
    const actors: RateActor[] = Array.from({ length: 160 }, (_v, i) => (i % 2 === 0 ? 'ai' : 'human'));
    const results = await Promise.all(actors.map((actor) => take(project, actor)));
    const now = await usage(project);
    expect(now.total).toBe(55);
    expect(now.ai).toBeLessThanOrEqual(30);
    const grantedAi = results.filter((r, i) => r.granted && actors[i] === 'ai').length;
    const grantedHuman = results.filter((r, i) => r.granted && actors[i] === 'human').length;
    expect(grantedAi).toBe(now.ai);
    expect(grantedAi + grantedHuman).toBe(55);
    // 80 people asked for 55 units: they got every unit the AI left over.
    expect(grantedHuman).toBe(55 - grantedAi);
  });

  it('refuses the AI at its share while a person still gets a unit (the AI has the lower priority)', async () => {
    const project = `share-${randomBytes(3).toString('hex')}`;
    for (let i = 0; i < 30; i += 1) expect((await take(project, 'ai')).granted).toBe(true);
    const aiRefused = await take(project, 'ai');
    expect(aiRefused).toMatchObject({ granted: false, reason: 'ai', ai: 30, total: 30 });
    expect((await take(project, 'human')).granted).toBe(true);
    expect((await take(project, 'system')).granted).toBe(true);
    expect(await usage(project)).toEqual({ total: 32, ai: 30 });
  });

  it('is a sliding window on the database clock: units come back a minute later, not before', async () => {
    const project = `slide-${randomBytes(3).toString('hex')}`;
    for (let i = 0; i < 55; i += 1) await take(project, 'human');
    expect((await take(project, 'human')).granted).toBe(false);
    // 30 seconds on: the same units are still inside the window.
    await owner().query(
      `UPDATE rate_budget_window SET slot = slot - interval '30 seconds' WHERE resource = $1`,
      [logging(project).resource],
    );
    expect((await take(project, 'human')).granted).toBe(false);
    // 62 seconds on: they have left it.
    await owner().query(
      `UPDATE rate_budget_window SET slot = slot - interval '32 seconds' WHERE resource = $1`,
      [logging(project).resource],
    );
    expect((await take(project, 'human')).granted).toBe(true);
    // And the old slots are swept once they are of no use any more.
    await owner().query(
      `UPDATE rate_budget_window SET slot = slot - interval '5 minutes' WHERE resource = $1`,
      [logging(project).resource],
    );
    await take(project, 'human');
    const rows = await owner().query(`SELECT 1 FROM rate_budget_window WHERE resource = $1`, [
      logging(project).resource,
    ]);
    expect(rows.rowCount).toBe(1);
  });

  it('keeps one window per resource and per project', async () => {
    const a = `iso-a-${randomBytes(3).toString('hex')}`;
    const b = `iso-b-${randomBytes(3).toString('hex')}`;
    for (let i = 0; i < 55; i += 1) await take(a, 'human');
    expect((await take(a, 'human')).granted).toBe(false);
    expect((await take(b, 'human')).granted).toBe(true);
    const data = await takeRateBudget(env.database.db, { ...rateBudgetFor('bigquery_query', { project: a }), actor: 'human' });
    expect(data.granted).toBe(true);
  });
});

describe('the AI ledger and the people share one window (T-108 ledger moved onto it)', () => {
  const project = `ledger-${randomBytes(3).toString('hex')}`;
  const entry = (tool = 'gcp_logs') => ({
    runKey: randomUUID(),
    ticketId: null,
    agent: 'investigator',
    tool,
    intent: null,
    stage: 2,
    inputHash: randomBytes(32).toString('hex'),
    mock: false,
  });

  it('counts a person\'s calls against the AI\'s tool_rate, and writes both to tool_execution', async () => {
    const ai = createDbToolLedger({
      db: env.database.db,
      limits: { perRun: 1000, perTicketPerHour: 1000, perToolPerMinute: AI_TOOL_BUDGETS.perToolPerMinute },
      project,
    });
    const human = createHumanToolLedger({ db: env.database.db, project });
    // People take 40 units; the AI can then take only 15 more, though its own share is 30.
    for (let i = 0; i < 40; i += 1) {
      const decision = await human.begin({
        runKey: randomUUID(),
        ticketId: null,
        agent: 'human',
        tool: 'gcp_logs',
        inputHash: randomBytes(32).toString('hex'),
        mock: true,
        actor: 'human',
      });
      expect(decision.allowed).toBe(true);
    }
    let aiAllowed = 0;
    for (let i = 0; i < 40; i += 1) {
      const decision = await ai.begin(entry());
      if (decision.allowed) aiAllowed += 1;
      else expect(decision).toEqual({ allowed: false, reason: 'tool_rate' });
    }
    expect(aiAllowed).toBe(15);
    expect(await usage(project)).toEqual({ total: 55, ai: 15 });

    const rows = await env.db.owner.db.select().from(schema.toolExecution);
    const mine = rows.filter((row) => row.tool === 'gcp_logs');
    expect(mine.filter((row) => row.agent === 'human' && row.status === 'running')).toHaveLength(40);
    expect(mine.filter((row) => row.agent === 'investigator' && row.status === 'denied').length).toBeGreaterThan(0);
    // A refused person is recorded too, with no secret in it.
    const refused = await human.begin({
      runKey: randomUUID(),
      ticketId: null,
      agent: 'human',
      tool: 'gcp_logs',
      inputHash: randomBytes(32).toString('hex'),
      mock: true,
      actor: 'human',
    });
    expect(refused).toMatchObject({ allowed: false });
    const denied = (await env.db.owner.db.select().from(schema.toolExecution)).filter(
      (row) => row.agent === 'human' && row.status === 'denied',
    );
    expect(denied).toHaveLength(1);
    expect(denied[0]?.errorCode).toBe('tool_rate');
  });

  it('closes a human row once and keeps only a class name', async () => {
    const human = createHumanToolLedger({ db: env.database.db, project: `close-${randomBytes(3).toString('hex')}` });
    const decision = await human.begin({
      runKey: randomUUID(),
      ticketId: null,
      agent: 'human',
      tool: 'bigquery_query',
      inputHash: randomBytes(32).toString('hex'),
      mock: true,
      actor: 'human',
    });
    if (!decision.allowed) throw new Error('expected allowed');
    await human.finish(decision.id, {
      status: 'error',
      errorCode: 'ConnectorError: select * from secrets',
      latencyMs: 4.9,
      resultCount: null,
    });
    const [row] = (await env.db.owner.db.select().from(schema.toolExecution)).filter(
      (candidate) => candidate.id === decision.id,
    );
    expect(row).toMatchObject({ status: 'error', latencyMs: 4, stage: null, intent: null });
    expect(row?.errorCode).not.toMatch(/[ :*]/);
  });
});
