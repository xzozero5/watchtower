import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { DevMockLlmProvider, type LlmProvider, type LlmRequest } from '@watchtower/ai';
import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { createDomain, type Domain } from '@watchtower/domain';
import {
  PROCEDURE_REQUIRE_HUMAN_TAG,
  PROCEDURE_TICKET_EVENTS,
  QUEUE_NAMES,
  parseRedisUrl,
  type AiReport,
  type ProcedureSimulationMetrics,
  type ProcedureSteps,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { Queue } from 'bullmq';
import { and, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMemoryObjectStore } from '../ingest/object-store.js';
import { createLogger } from '../logger.js';
import { testConfig, testSealKey } from '../testing/support.js';
import { startWorker, type RunningWorker } from '../worker.js';

// T-303c / T-303d through the real worker on the offline mock provider: a published procedure steers the
// investigation and the draft, the runs carry its version, and a simulation job writes its result.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const prefix = `wt-proc-${randomBytes(4).toString('hex')}`;
const net = disableNetConnect();
const FIXTURES_DIR = fileURLToPath(new URL('../../../../examples/tools', import.meta.url));

let testDb: TestDatabase;
let worker: RunningWorker;
let appDatabase: Database;
let domain: Domain;
let config: ReturnType<typeof testConfig>;
let orgId = '';
let leadId = '';
let headId = '';
const requests: LlmRequest[] = [];
const owner = () => testDb.owner.db;

const INVESTIGATOR = {
  findings: [{ text: 'The knowledge base describes the check.', evidenceIds: ['ev-1'] }],
  likelyCause: null,
  confidence: 0.6,
  openQuestions: [],
  nextStep: { kind: 'reply', label: 'Reply to the customer' },
  checkAnswers: [
    { stepId: 'q1', answer: 'The article says to check the endpoint.', evidenceIds: ['ev-1'] },
  ],
};
const DRAFTER = {
  language: 'en',
  sentences: [
    { text: 'Thanks for writing to us.', kind: 'courtesy', evidenceIds: [] },
    {
      text: 'Please make sure the endpoint answers with a success status within ten seconds.',
      kind: 'instruction',
      evidenceIds: ['ev-1'],
    },
    { text: 'Our secret roadmap fixes this.', kind: 'fact', evidenceIds: ['ev-1'] },
  ],
};
const GRADER = {
  resolutionClass: 'contained',
  draftVerdict: 'partial',
  draftQuality: 0.6,
  policyViolations: [],
  kbGap: false,
  reasons: [],
};

function provider(): LlmProvider {
  const inner = new DevMockLlmProvider();
  const answer = (request: LlmRequest, body: unknown) =>
    Promise.resolve({
      text: JSON.stringify(body),
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 1 },
      model: request.model,
    });
  return {
    kind: 'mock',
    generate(request) {
      requests.push(request);
      switch (request.prompt.id) {
        case 'classifier':
          return answer(request, {
            type: 'new_customer_issue',
            intentKey: 'procedure_topic',
            confidence: 0.9,
            reason: 'pinned',
          });
        case 'investigator':
          return answer(request, INVESTIGATOR);
        case 'drafter':
          return answer(request, DRAFTER);
        case 'grader':
          return answer(request, GRADER);
        default:
          return inner.generate(request);
      }
    },
  };
}

const METRICS: ProcedureSimulationMetrics = {
  mode: 'instance',
  caseCount: 1,
  failedCases: 0,
  seededCases: 0,
  candidate: { editDistance: 10, uncitedClaims: 0, drafted: 1, violations: 0, disclosureLeaks: 0 },
  baseline: { editDistance: 10, uncitedClaims: 0, drafted: 1 },
  baselineVersionId: null,
  deadSteps: [],
  toolCalls: 1,
  failReasons: [],
  cases: [],
};

const LIVE_STEPS: ProcedureSteps = {
  schemaVersion: 1,
  autosend: 'never',
  steps: [
    { kind: 'tool', id: 'kb', tool: 'kb_search' },
    { kind: 'tool', id: 'org', tool: 'org_context' },
    {
      kind: 'check',
      id: 'q1',
      question: 'Does the article cover this case?',
      evidenceFrom: ['kb'],
    },
    { kind: 'reply_guideline', id: 'g1', text: 'Keep it to three sentences.', lang: 'en' },
    { kind: 'disclosure', id: 'd1', rule: 'never_mention', topic: 'secret roadmap' },
    {
      kind: 'escalate',
      id: 'e1',
      when: { all: [{ field: 'evidence.count', op: 'gte', value: 1 }] },
      to: { role: 'lead' },
      note: 'Ask a lead to look.',
    },
    {
      kind: 'require_human',
      id: 'h1',
      when: { all: [{ field: 'investigation.hasLikelyCause', op: 'eq', value: false }] },
      reason: 'No cause was found',
    },
  ],
};

let intentId = '';
let liveVersionId = '';

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  config = {
    ...testConfig({
      DATABASE_URL: testDb.appUrl,
      OUTBOX_POLL_INTERVAL_MS: '100',
      AI_DAILY_TOKEN_CAP: '100000',
      AI_TOOL_FIXTURES_DIR: FIXTURES_DIR,
      AI_TOOLS_WITHOUT_READONLY_LOGIN: 'true',
    }),
    listenPort: 0,
  };
  worker = await startWorker(config, createLogger(config), {
    queuePrefix: prefix,
    realtimeChannel: `watchtower:realtime:${prefix}`,
    overrides: {
      ingest: { store: createMemoryObjectStore() },
      ai: { providers: { mock: provider() } },
    },
  });
  appDatabase = createDatabase({ url: testDb.appUrl, max: 4, applicationName: 'wt-proc-test' });
  domain = createDomain({ ticketKeyPrefix: 'OPS', sealKey: testSealKey(config) });

  const [org] = await owner()
    .insert(schema.organization)
    .values({ name: 'Example Org' })
    .returning();
  orgId = org?.id ?? '';
  const staff = await owner()
    .insert(schema.users)
    .values([
      { email: 'lead@example.test', name: 'Lead One', role: 'lead' },
      { email: 'head@example.test', name: 'Head One', role: 'head' },
    ])
    .returning();
  leadId = staff.find((row) => row.role === 'lead')?.id ?? '';
  headId = staff.find((row) => row.role === 'head')?.id ?? '';
  const [intent] = await owner()
    .insert(schema.intent)
    .values([
      { key: 'procedure_topic', name: 'Procedure topic', autonomyStage: 2, allowedTools: [] },
      { key: 'plain_topic', name: 'Plain topic', autonomyStage: 2, allowedTools: [] },
    ])
    .returning();
  intentId = intent?.id ?? '';
  await publishedArticle();

  // A published procedure for `procedure_topic`: written, confirmed, simulated (passed) and published as people would.
  const lead = domain.context({ actor: { type: 'user', id: leadId } });
  const draft = await appDatabase.db.transaction((tx) =>
    domain.procedures.createDraft(tx, lead, {
      intentId,
      sourceMd: 'Look in the KB and the org record; ask a lead when there is evidence.',
      steps: LIVE_STEPS,
    }),
  );
  liveVersionId = draft.value.id;
  await appDatabase.db.transaction((tx) =>
    domain.procedures.confirm(tx, lead, { intentId, versionId: liveVersionId }),
  );
  // The schema owner writes this fixture (the application role goes through record_procedure_simulation(), which
  // wants the drafter runs of the version in ai_run: migration 0108).
  await owner().insert(schema.procedureSimulation).values({
    procedureVersionId: liveVersionId,
    passed: true,
    seedOnly: false,
    caseCount: 1,
    metrics: METRICS,
    ranBy: leadId,
  });
  await appDatabase.db.transaction((tx) =>
    domain.procedures.publish(tx, domain.context({ actor: { type: 'user', id: headId } }), {
      intentId,
      versionId: liveVersionId,
    }),
  );
});

afterAll(async () => {
  await worker.close();
  await appDatabase.close();
  const connection = parseRedisUrl(config.REDIS_URL);
  for (const name of [QUEUE_NAMES.ingest, QUEUE_NAMES.ai, QUEUE_NAMES.procedureSimulate]) {
    const queue = new Queue(name, { connection, prefix });
    await queue.obliterate({ force: true });
    await queue.close();
  }
  await testDb.cleanup();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

async function publishedArticle(): Promise<void> {
  const articleId = randomUUID();
  const versionId = randomUUID();
  const client = await testDb.owner.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO kb_article (id, slug, kind, lang, status, visibility, intent_tags, current_version_id, published_version_id)
       VALUES ($1, 'webhook-not-received', 'runbook', 'en', 'published', 'customer', ARRAY['procedure_topic'], $2, $2)`,
      [articleId, versionId],
    );
    await client.query(
      `INSERT INTO kb_article_version (id, article_id, version, title, body_md, content_hash)
       VALUES ($1, $2, 1, 'Webhook not received', 'body', $3)`,
      [versionId, articleId, 'a'.repeat(64)],
    );
    await client.query(
      `INSERT INTO kb_chunk (article_id, version_id, ordinal, section, text, char_start, char_end)
       VALUES ($1, $2, 0, 'Check the endpoint', 'If the webhook is not received, make sure the endpoint answers with a success status within ten seconds.', 0, 120)`,
      [articleId, versionId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function createTicket(intentKey: string): Promise<string> {
  const created = await appDatabase.db.transaction((tx) =>
    domain.tickets.create(tx, domain.context({ actor: { type: 'user', id: leadId } }), {
      orgId,
      subject: 'Webhook not received',
      body: 'Our webhook is not received since this morning.',
      requester: {
        email: `customer-${randomBytes(3).toString('hex')}@customer.example.test`,
        name: 'Pat Example',
      },
      intentKey,
    }),
  );
  return created.value.ticket.id;
}

const settled = (ticketId: string) =>
  waitFor(`the draft of ${ticketId}`, async () => {
    const [row] = await owner()
      .select()
      .from(schema.aiTicketInsight)
      .where(eq(schema.aiTicketInsight.ticketId, ticketId));
    return row?.state === 'draft_ready' ? row : undefined;
  });

describe('a published procedure in the investigation (T-303c)', () => {
  it('runs only its tools, answers its question, proposes the escalation, calls for a person and records its version on every run', async () => {
    requests.length = 0;
    const ticketId = await createTicket('procedure_topic');
    const row = await settled(ticketId);

    const tools = await owner()
      .select({ tool: schema.toolExecution.tool })
      .from(schema.toolExecution)
      .where(eq(schema.toolExecution.ticketId, ticketId));
    // The procedure names the knowledge base and the organization: not the similar-tickets tool of the default runbook.
    expect(tools.map((item) => item.tool).sort()).toEqual(['kb_search', 'org_context']);

    const report = row.report as AiReport;
    expect(report.procedure).toMatchObject({
      versionId: liveVersionId,
      autosend: 'never',
      checks: [{ stepId: 'q1', answer: 'The article says to check the endpoint.' }],
      escalations: [{ stepId: 'e1', to: { role: 'lead' } }],
      requireHuman: [{ stepId: 'h1', reason: 'No cause was found' }],
    });
    expect(report.promptVersion).toBe('v3');

    // Every run of the investigator and the drafter points at the version (ADR-026 section 5).
    const runs = await owner()
      .select()
      .from(schema.aiRun)
      .where(eq(schema.aiRun.ticketId, ticketId));
    const followed = runs.filter((run) => run.agent === 'investigator' || run.agent === 'drafter');
    expect(followed.map((run) => run.agent).sort()).toEqual(['drafter', 'investigator']);
    expect(followed.every((run) => run.procedureVersionId === liveVersionId)).toBe(true);
    // The classifier ran before any procedure was chosen.
    expect(runs.find((run) => run.agent === 'classifier')?.procedureVersionId).toBeNull();

    // The proposal and the call for a person stay with the ticket; nothing was done on the proposal.
    const events = await owner()
      .select()
      .from(schema.ticketEvent)
      .where(eq(schema.ticketEvent.ticketId, ticketId));
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        PROCEDURE_TICKET_EVENTS.procedureEscalationProposed,
        PROCEDURE_TICKET_EVENTS.procedureRequireHuman,
      ]),
    );
    const [ticket] = await owner()
      .select()
      .from(schema.ticket)
      .where(eq(schema.ticket.id, ticketId));
    expect(ticket?.tags).toContain(PROCEDURE_REQUIRE_HUMAN_TAG);
    expect(ticket?.status).not.toBe('escalated');

    // The question reached the investigator; the guideline reached the drafter below the rules; the forbidden topic is gone from the draft.
    expect(requests.find((r) => r.prompt.id === 'investigator')?.system).toContain(
      '[q1] Does the article cover this case?',
    );
    const drafterSystem = requests.find((r) => r.prompt.id === 'drafter')?.system ?? '';
    expect(drafterSystem).toContain('Keep it to three sentences.');
    expect(drafterSystem.indexOf('Disclosure level')).toBeLessThan(
      drafterSystem.indexOf('Keep it to three sentences.'),
    );
    const [draft] = await owner()
      .select()
      .from(schema.aiDraft)
      .where(eq(schema.aiDraft.ticketId, ticketId));
    expect(draft?.bodyText).toContain('ten seconds');
    expect(draft?.bodyText).not.toContain('roadmap');
  });

  it('an intent without a procedure keeps the default runbook, the same report and no version on its runs', async () => {
    const ticketId = await createTicket('plain_topic');
    const row = await settled(ticketId);
    const tools = await owner()
      .select({ tool: schema.toolExecution.tool })
      .from(schema.toolExecution)
      .where(eq(schema.toolExecution.ticketId, ticketId));
    expect(tools.map((item) => item.tool).sort()).toEqual([
      'kb_search',
      'org_context',
      'similar_tickets',
    ]);
    expect((row.report as AiReport).procedure).toBeUndefined();
    const runs = await owner()
      .select()
      .from(schema.aiRun)
      .where(and(eq(schema.aiRun.ticketId, ticketId), isNotNull(schema.aiRun.procedureVersionId)));
    expect(runs).toEqual([]);
  });
});

describe('simulation job (T-303d)', () => {
  it('replays resolved tickets of the intent with the new steps and the live version, writes the result and moves the version on', async () => {
    // Two resolved tickets with a person's reply: what the simulation replays.
    for (let index = 0; index < 2; index += 1) {
      const id = await createTicket('procedure_topic');
      await owner()
        .update(schema.ticket)
        .set({ status: 'resolved', resolvedAt: new Date() })
        .where(eq(schema.ticket.id, id));
      await owner()
        .insert(schema.message)
        .values({
          ticketId: id,
          direction: 'outbound',
          senderUserId: leadId,
          bodyText:
            'Thanks for writing to us. Please make sure the endpoint answers within ten seconds.',
          visibility: 'public',
          createdAt: new Date(Date.now() + 1000),
        });
    }

    const lead = domain.context({ actor: { type: 'user', id: leadId } });
    const next = await appDatabase.db.transaction((tx) =>
      domain.procedures.createDraft(tx, lead, {
        intentId,
        sourceMd: 'Only the knowledge base.',
        steps: {
          schemaVersion: 1,
          autosend: 'never',
          steps: [
            { kind: 'tool', id: 'kb', tool: 'kb_search' },
            { kind: 'reply_guideline', id: 'g1', text: 'Be brief.' },
          ],
        },
      }),
    );
    const versionId = next.value.id;
    await appDatabase.db.transaction((tx) =>
      domain.procedures.confirm(tx, lead, { intentId, versionId }),
    );

    const connection = parseRedisUrl(config.REDIS_URL);
    const queue = new Queue(QUEUE_NAMES.procedureSimulate, { connection, prefix });
    try {
      await queue.add('simulate', { versionId, requestedBy: leadId });
    } finally {
      await queue.close();
    }
    const simulation = await waitFor('the simulation', async () => {
      const [found] = await owner()
        .select()
        .from(schema.procedureSimulation)
        .where(eq(schema.procedureSimulation.procedureVersionId, versionId));
      return found;
    });

    expect(simulation.caseCount).toBe(2);
    expect(simulation.seedOnly).toBe(false);
    expect(simulation.ranBy).toBe(leadId);
    const metrics = simulation.metrics as ProcedureSimulationMetrics;
    expect(metrics).toMatchObject({
      mode: 'instance',
      caseCount: 2,
      baselineVersionId: liveVersionId,
      deadSteps: [],
    });
    expect(metrics.candidate.drafted).toBe(2);
    expect(metrics.toolCalls).toBeGreaterThan(0);
    // The version moved with the verdict, through the trigger of migration 0097.
    const [version] = await owner()
      .select()
      .from(schema.procedureVersion)
      .where(eq(schema.procedureVersion.id, versionId));
    expect(version?.status).toBe(simulation.passed ? 'simulated' : 'confirmed');
    expect(version?.simulationId).toBe(simulation.id);

    // Its own bucket of the tool ledger, and the runs point at the version they followed (candidate and baseline).
    const simulated = await owner()
      .select({ id: schema.toolExecution.id })
      .from(schema.toolExecution)
      .where(eq(schema.toolExecution.agent, 'simulation'));
    expect(simulated.length).toBeGreaterThan(0);
    const runs = await owner()
      .select({ version: schema.aiRun.procedureVersionId })
      .from(schema.aiRun)
      .where(isNotNull(schema.aiRun.procedureVersionId));
    expect(runs.some((run) => run.version === versionId)).toBe(true);
    expect(runs.some((run) => run.version === liveVersionId)).toBe(true);

    // Nothing was sent and no ticket changed: the simulated tickets are still resolved.
    const outbound = await owner()
      .select()
      .from(schema.message)
      .where(eq(schema.message.direction, 'outbound'));
    expect(outbound).toHaveLength(2);
  });

  it('also replays at stage 3 when a step applies only there, and the verdict covers both (C-7)', async () => {
    const lead = domain.context({ actor: { type: 'user', id: leadId } });
    const next = await appDatabase.db.transaction((tx) =>
      domain.procedures.createDraft(tx, lead, {
        intentId,
        sourceMd: 'Be brief; at stage 3 say more about the refund.',
        steps: {
          schemaVersion: 1,
          autosend: 'never',
          steps: [
            { kind: 'tool', id: 'kb', tool: 'kb_search' },
            { kind: 'reply_guideline', id: 'g1', text: 'Be brief.' },
            { kind: 'reply_guideline', id: 'g3', text: 'Mention the refund policy.', stages: [3] },
          ],
        },
      }),
    );
    const versionId = next.value.id;
    await appDatabase.db.transaction((tx) =>
      domain.procedures.confirm(tx, lead, { intentId, versionId }),
    );
    const connection = parseRedisUrl(config.REDIS_URL);
    const queue = new Queue(QUEUE_NAMES.procedureSimulate, { connection, prefix });
    try {
      await queue.add('simulate', { versionId, requestedBy: leadId });
    } finally {
      await queue.close();
    }
    const simulation = await waitFor('the simulation', async () => {
      const [found] = await owner()
        .select()
        .from(schema.procedureSimulation)
        .where(eq(schema.procedureSimulation.procedureVersionId, versionId));
      return found;
    });
    // The same two resolved tickets, once at stage 2 and once at stage 3 (a procedure that is the same at both
    // stages, like the one above, is replayed once).
    const metrics = simulation.metrics as ProcedureSimulationMetrics;
    expect(metrics.caseCount).toBe(4);
    expect(metrics.candidate.drafted).toBe(4);
    expect(simulation.caseCount).toBe(4);
  });
});
