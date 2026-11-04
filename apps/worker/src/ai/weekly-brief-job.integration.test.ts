import {
  DevMockLlmProvider,
  ProviderError,
  type LlmProvider,
  type LlmRequest,
} from '@watchtower/ai';
import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { disableNetConnect } from '@watchtower/shared/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { createAiRuntime, type AiRuntime } from './runtime.js';
import {
  MAX_MODEL_ATTEMPTS,
  runWeeklyBrief,
  type WeeklyBriefDeps,
  type WeeklyBriefSettings,
} from './weekly-brief-job.js';

// T-305c: the weekly brief job on the offline mock, with Postgres (restricted application role). The model never
// sees an address or a colleague's name, every sentence cites a fact the code read, nothing is sent to anyone.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const net = disableNetConnect();

let testDb: TestDatabase;
let database: Database;
let runtime: AiRuntime;
let orgId = '';
const requests: LlmRequest[] = [];
let mode: 'ok' | 'offline' | 'garbage' = 'ok';

const logger = createLogger(testConfig());
const owner = () => testDb.owner.db;

function provider(): LlmProvider {
  const inner = new DevMockLlmProvider();
  return {
    kind: 'mock',
    generate(request) {
      requests.push(request);
      if (mode === 'offline') {
        return Promise.reject(new ProviderError('claude-cli', 'offline', 503, true));
      }
      if (mode === 'garbage') {
        return Promise.resolve({
          text: 'not json',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: request.model,
        });
      }
      return inner.generate(request);
    },
  };
}

// Monday 2026-11-09 10:00 in Bangkok: the slot of that Monday is open.
const MONDAY = new Date('2026-11-09T03:00:00Z');
const settings: WeeklyBriefSettings = {
  enabled: true,
  day: 'mon',
  time: '08:00',
  timeZone: 'Asia/Bangkok',
  locale: 'en',
  ticketKeyPrefix: 'OPS',
  minutesPerTicket: 10,
  staffCostUsdPerHour: null,
};

const deps = (over: Partial<WeeklyBriefDeps> = {}): WeeklyBriefDeps => ({
  database,
  ai: runtime,
  logger,
  settings,
  now: () => MONDAY,
  ...over,
});

const briefs = () => owner().select().from(schema.weeklyBrief);

async function ticket(subject: string, intentKey: string | null, day: string): Promise<string> {
  const [intent] =
    intentKey === null
      ? []
      : await owner()
          .select({ id: schema.intent.id })
          .from(schema.intent)
          .where(eq(schema.intent.key, intentKey))
          .limit(1);
  const [row] = await owner()
    .insert(schema.ticket)
    .values({
      orgId,
      subject,
      intentId: intent?.id ?? null,
      createdAt: new Date(`2026-11-${day}T05:00:00Z`),
    })
    .returning({ id: schema.ticket.id });
  return row?.id ?? '';
}

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  database = createDatabase({ url: testDb.appUrl, max: 4, applicationName: 'wt-brief-test' });
  runtime = createAiRuntime(testConfig(), database, logger, { providers: { mock: provider() } });
  const [org] = await owner()
    .insert(schema.organization)
    .values({ name: 'Example Org' })
    .returning();
  orgId = org?.id ?? '';
  await owner()
    .insert(schema.users)
    .values({ email: 'head@example.test', name: 'Hana Headley', role: 'head' });
  await owner()
    .insert(schema.intent)
    .values([
      { key: 'login_issue', name: 'Login issue', autonomyStage: 2 },
      { key: 'billing_question', name: 'Billing question', autonomyStage: 2 },
    ]);
  const first = await ticket(
    'Cannot sign in, mail me at somchai@customer.example.test',
    'login_issue',
    '07',
  );
  await ticket('Sign-in loop', 'login_issue', '08');
  await ticket('Sign-in fails after reset', 'login_issue', '08');
  await ticket('Invoice question', 'billing_question', '06');
  // Older than the window: counted nowhere.
  await ticket('Ancient history', 'login_issue', '01');
  await owner()
    .insert(schema.aiTicketInsight)
    .values({
      ticketId: first,
      state: 'classified',
      stage: 2,
      generatedAt: new Date('2026-11-07T06:00:00Z'),
      intentKey: 'login_issue',
      report: {
        findings: [
          { text: 'The session cookie is rejected after the password reset.', evidenceIds: [] },
        ],
        likelyCause: 'The session is not renewed after a reset.',
        confidence: 0.6,
        openQuestions: [],
        tools: [],
        promptVersion: '1',
        scope: { intent: 'login_issue', reason: 'classified' },
      },
    });
  await owner()
    .insert(schema.incident)
    .values({
      title: 'Login errors for some customers',
      severity: 'SEV2',
      status: 'investigating',
      startedAt: new Date('2026-11-08T01:00:00Z'),
    });
});
afterAll(async () => {
  await testDb.cleanup();
  net.restore();
});
beforeEach(async () => {
  requests.length = 0;
  mode = 'ok';
  await owner().execute(sql`DELETE FROM weekly_brief`);
});

describe('runWeeklyBrief', () => {
  it('drafts the brief from the real figures and facts, every claim with its evidence', async () => {
    const result = await runWeeklyBrief(deps());
    expect(result).toEqual({ status: 'drafted', slotDate: '2026-11-09', source: 'ai' });

    const [row] = await briefs();
    expect(row).toMatchObject({
      status: 'draft',
      slotDate: '2026-11-09',
      source: 'ai',
      reasonCode: null,
      locale: 'en',
      mock: true,
      promptVersion: 1,
    });
    // The figures are the CEO view's own: 4 tickets in the window, the one of last month is not counted.
    const figures = row?.figures as { kpis: { volume: { data: { value: number } } } };
    expect(figures.kpis.volume.data.value).toBe(4);
    expect(row?.periodTo.toISOString()).toBe(MONDAY.toISOString());

    const content = row?.content as {
      summary: { text: string; uncited: boolean; evidence: { kind: string; href?: string }[] }[];
      rootCauses: {
        title: string;
        claims: { evidence: { kind: string; label: string; href?: string }[] }[];
      }[];
      decisions: { evidence: { kind: string; href?: string }[] }[];
    };
    expect(content.summary.length).toBeGreaterThan(0);
    expect(content.summary.every((claim) => !claim.uncited && claim.evidence.length > 0)).toBe(
      true,
    );
    // The busiest intent is a root cause, with tickets of the week as its evidence.
    expect(content.rootCauses[0]?.title).toContain('login_issue');
    const causeEvidence = content.rootCauses[0]?.claims[0]?.evidence ?? [];
    expect(
      causeEvidence.some(
        (item) => item.kind === 'ticket' && item.href?.startsWith('/?ticket=OPS-'),
      ),
    ).toBe(true);
    // The open incident is a decision, with a link to its page.
    expect(content.decisions[0]?.evidence[0]).toMatchObject({ kind: 'incident' });
    expect(content.decisions[0]?.evidence[0]?.href).toMatch(/^\/incidents\?incident=/);
    // What the model wrote is kept next to what the head will edit.
    expect(row?.aiContent).toEqual(row?.content);
  });

  it('is recorded on ai_run with the prompt version, and the model never sees an address or a colleague', async () => {
    await runWeeklyBrief(deps());
    const runs = await owner()
      .select()
      .from(schema.aiRun)
      .where(eq(schema.aiRun.agent, 'summarizer'));
    const run = runs.find((candidate) => candidate.promptId === 'weekly_brief');
    expect(run).toBeDefined();
    expect(run?.promptVersion).toBe(1);
    expect(run?.ticketId).toBeNull();
    const [row] = await briefs();
    expect(row?.aiRunId).toBe(run?.id);

    const sent = requests
      .map((request) => request.system + request.messages.map((m) => m.content).join(''))
      .join('\n');
    expect(sent).toContain('OPS-');
    expect(sent).not.toContain('somchai@customer.example.test');
    expect(sent).not.toContain('Hana Headley');
  });

  it('makes one brief per slot', async () => {
    await runWeeklyBrief(deps());
    const calls = requests.length;
    expect(await runWeeklyBrief(deps())).toEqual({ status: 'exists', slotDate: '2026-11-09' });
    expect(await briefs()).toHaveLength(1);
    expect(requests).toHaveLength(calls);
  });

  it('waits for the slot: before the time of day it belongs to last week', async () => {
    // Monday 07:00 Bangkok: this week is not due yet, last Monday is (and is made, it was missed).
    const early = new Date('2026-11-09T00:00:00Z');
    const result = await runWeeklyBrief(deps({ now: () => early }));
    expect(result).toMatchObject({ status: 'drafted', slotDate: '2026-11-02' });
  });

  it('does nothing when switched off', async () => {
    expect(await runWeeklyBrief(deps({ settings: { ...settings, enabled: false } }))).toEqual({
      status: 'disabled',
    });
    expect(await briefs()).toHaveLength(0);
  });

  it('with no AI set up drafts the figures alone and says why, each figure a claim with its chip', async () => {
    const result = await runWeeklyBrief(deps({ ai: undefined }));
    expect(result).toMatchObject({
      status: 'drafted',
      source: 'data_only',
      reason: 'provider_unavailable',
    });
    const [row] = await briefs();
    expect(row).toMatchObject({
      source: 'data_only',
      reasonCode: 'provider_unavailable',
      mock: false,
      aiRunId: null,
    });
    const content = row?.content as {
      summary: { uncited: boolean; evidence: { href?: string }[] }[];
      rootCauses: unknown[];
    };
    expect(content.summary).toHaveLength(8);
    expect(
      content.summary.every(
        (claim) => !claim.uncited && claim.evidence[0]?.href === '/dashboard/ceo',
      ),
    ).toBe(true);
    expect(content.rootCauses).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('is put off while the AI host is offline, and made from the figures after a day', async () => {
    mode = 'offline';
    expect(await runWeeklyBrief(deps())).toEqual({ status: 'deferred', slotDate: '2026-11-09' });
    expect(await briefs()).toHaveLength(0);

    // Tuesday 10:00 Bangkok: more than 24 hours after the slot (Monday 08:00).
    const later = new Date('2026-11-10T03:00:00Z');
    const result = await runWeeklyBrief(deps({ now: () => later }));
    expect(result).toMatchObject({
      status: 'drafted',
      source: 'data_only',
      reason: 'provider_offline',
    });
    expect(await briefs()).toHaveLength(1);
  });

  it('puts an unusable answer off twice, then drafts the figures alone', async () => {
    mode = 'garbage';
    const attempts = new Map<string, number>();
    for (let attempt = 1; attempt < MAX_MODEL_ATTEMPTS; attempt += 1) {
      expect(await runWeeklyBrief(deps({ attempts }))).toEqual({
        status: 'deferred',
        slotDate: '2026-11-09',
      });
    }
    expect(await briefs()).toHaveLength(0);
    const result = await runWeeklyBrief(deps({ attempts }));
    expect(result).toMatchObject({ source: 'data_only', reason: 'model_output_invalid' });
    expect(await briefs()).toHaveLength(1);
  });

  it('counts no ticket of a seed batch, in the figures or in the facts', async () => {
    // ticket.seed_batch_id exists since 0096 and only the schema owner writes it; a seed ticket must live in
    // an organization of the same batch (trigger seed_batch_guard). The seed_batch row stays: append-only.
    const batch = await owner().execute<{ id: string }>(
      sql`INSERT INTO seed_batch (kind, note) VALUES ('demo', 'T-305c weekly brief test') RETURNING id`,
    );
    const batchId = batch.rows[0]?.id;
    if (batchId === undefined) throw new Error('seed_batch insert returned no row');
    const seedOrg = await owner().execute<{ id: string }>(
      sql`INSERT INTO organization (name, seed_batch_id) VALUES ('Seed org', ${batchId}::uuid) RETURNING id`,
    );
    const seedOrgId = seedOrg.rows[0]?.id;
    if (seedOrgId === undefined) throw new Error('organization insert returned no row');
    await owner().execute(
      sql`UPDATE ticket SET org_id = ${seedOrgId}::uuid, seed_batch_id = ${batchId}::uuid WHERE subject = 'Invoice question'`,
    );
    await runWeeklyBrief(deps());
    const [row] = await briefs();
    const figures = row?.figures as {
      seedExcluded: boolean;
      kpis: { volume: { data: { value: number } } };
    };
    expect(figures.seedExcluded).toBe(true);
    expect(figures.kpis.volume.data.value).toBe(3);
    const sent = requests
      .map((request) => request.messages.map((m) => m.content).join(''))
      .join('\n');
    expect(sent).not.toContain('billing_question');
  });
});
