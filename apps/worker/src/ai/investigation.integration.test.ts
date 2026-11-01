import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { DevMockLlmProvider, type LlmProvider, type LlmRequest } from '@watchtower/ai';
import { createDatabase, enqueueOutbox, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { createDomain, type Domain } from '@watchtower/domain';
import {
  AI_INVESTIGATION_DEADLINE_MS,
  AI_JOBS,
  AI_OUTBOX_JOB_OPTIONS,
  AI_INTENT_SCOPE_MIN_CONFIDENCE,
  AI_TOOL_BUDGETS,
  KB_AUTHOR_DELAY_MS,
  QUEUE_NAMES,
  parseRedisUrl,
  type AiReport,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMemoryObjectStore } from '../ingest/object-store.js';
import { createLogger } from '../logger.js';
import { testConfig, testSealKey } from '../testing/support.js';
import { startWorker, type RunningWorker } from '../worker.js';

// T-108 through the real worker: the investigator, the drafter and the KB author on the offline mock
// provider, Postgres (restricted application role) and Redis from docker compose. Nothing here can
// reach a customer: the test also checks that no message and no delivery was made.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const prefix = `wt-inv-${randomBytes(4).toString('hex')}`;
const net = disableNetConnect();
const FIXTURES_DIR = fileURLToPath(new URL('../../../../examples/tools', import.meta.url));

let testDb: TestDatabase;
let worker: RunningWorker;
let appDatabase: Database;
let domain: Domain;
let config: ReturnType<typeof testConfig>;
let orgId = '';
let staffId = '';
const requests: LlmRequest[] = [];
/** Confidence the classifier answers with; a test sets it before it creates a ticket. */
let classifierConfidence = 0.9;
let classifierIntent: string | null = 'webhook_not_received';

const owner = () => testDb.owner.db;

/** The dev mock, except the classifier, whose intent and confidence a test pins. */
function provider(): LlmProvider {
  const inner = new DevMockLlmProvider();
  return {
    kind: 'mock',
    generate(request) {
      requests.push(request);
      if (request.prompt.id === 'classifier') {
        return Promise.resolve({
          text: JSON.stringify({
            type: 'new_customer_issue',
            intentKey: classifierIntent,
            confidence: classifierConfidence,
            reason: 'pinned by the test',
          }),
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1 },
          model: request.model,
        });
      }
      return inner.generate(request);
    },
  };
}

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  config = {
    ...testConfig({
      DATABASE_URL: testDb.appUrl,
      OUTBOX_POLL_INTERVAL_MS: '100',
      AI_DAILY_TOKEN_CAP: '100000',
      AI_TOOL_FIXTURES_DIR: FIXTURES_DIR,
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
  appDatabase = createDatabase({ url: testDb.appUrl, max: 4, applicationName: 'wt-inv-test' });
  domain = createDomain({ ticketKeyPrefix: 'OPS', sealKey: testSealKey(config) });

  const [org] = await owner()
    .insert(schema.organization)
    .values({ name: 'Example Org' })
    .returning();
  orgId = org?.id ?? '';
  const [staff] = await owner()
    .insert(schema.users)
    .values({ email: 'agent@example.test', name: 'Agent One', role: 'agent' })
    .returning();
  staffId = staff?.id ?? '';
  await owner()
    .insert(schema.intent)
    .values([
      {
        key: 'webhook_not_received',
        name: 'Webhook not received',
        allowedTools: ['gcp_logs', 'bigquery_query', 'repo_changes'],
        autonomyStage: 2,
      },
      { key: 'stage_one', name: 'Stage one topic', autonomyStage: 1 },
      { key: 'stage_zero', name: 'Stage zero topic', autonomyStage: 0 },
    ]);
  await publishedArticle();
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

/** One published, customer-visible runbook with one chunk, so the keyword search finds it. */
async function publishedArticle(): Promise<void> {
  const articleId = randomUUID();
  const versionId = randomUUID();
  const client = await testDb.owner.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO kb_article (id, slug, kind, lang, status, visibility, intent_tags, current_version_id, published_version_id)
       VALUES ($1, 'webhook-not-received', 'runbook', 'en', 'published', 'customer', ARRAY['webhook_not_received'], $2, $2)`,
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
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type Actor = { type: 'system' | 'user'; id: string | null };

async function createTicket(
  subject: string,
  body: string,
  options: { intentKey?: string; actor?: Actor } = {},
): Promise<string> {
  const created = await appDatabase.db.transaction((tx) =>
    domain.tickets.create(
      tx,
      domain.context({ actor: options.actor ?? { type: 'system', id: null } }),
      {
        orgId,
        subject,
        body,
        requester: { email: `customer-${randomBytes(3).toString('hex')}@customer.example.test`, name: 'Pat Example' },
        ...(options.intentKey === undefined ? {} : { intentKey: options.intentKey }),
      },
    ),
  );
  return created.value.ticket.id;
}

const insightRow = async (ticketId: string) =>
  (
    await owner()
      .select()
      .from(schema.aiTicketInsight)
      .where(eq(schema.aiTicketInsight.ticketId, ticketId))
  )[0];

/** Waits until the insight is out of the working states. */
async function settled(ticketId: string, state?: string) {
  return waitFor(`the insight of ${ticketId}`, async () => {
    const row = await insightRow(ticketId);
    if (row === undefined) return undefined;
    if (state !== undefined) return row.state === state ? row : undefined;
    return row.investigatedAt !== null || row.state === 'needs_human' || row.state === 'failed'
      ? row
      : undefined;
  });
}

const runsOf = (ticketId: string) =>
  owner().select().from(schema.aiRun).where(eq(schema.aiRun.ticketId, ticketId));
const draftsOf = (ticketId: string) =>
  owner().select().from(schema.aiDraft).where(eq(schema.aiDraft.ticketId, ticketId));
const toolRowsOf = (ticketId: string) =>
  owner().select().from(schema.toolExecution).where(eq(schema.toolExecution.ticketId, ticketId));

async function enqueueAi(name: string, payload: Record<string, unknown>): Promise<void> {
  await appDatabase.db.transaction((tx) =>
    enqueueOutbox(tx, {
      queue: QUEUE_NAMES.ai,
      jobName: name,
      jobId: `test-${name}-${randomUUID()}`,
      payload,
      options: { ...AI_OUTBOX_JOB_OPTIONS },
    }),
  );
}

describe('investigator and drafter, end to end on the mock provider (stage 2)', () => {
  it('a new ticket gets evidence, a report and a draft that waits for a person, and nothing is sent', async () => {
    classifierConfidence = 0.9;
    classifierIntent = 'webhook_not_received';
    const started = Date.now();
    const ticketId = await createTicket(
      'Webhook not received',
      'Our webhook is not received since this morning. Please check; reach me at pat.example@customer.example.test',
      { intentKey: 'webhook_not_received' },
    );
    const ready = await settled(ticketId, 'draft_ready');
    expect(Date.now() - started).toBeLessThan(AI_INVESTIGATION_DEADLINE_MS);

    // Evidence: knowledge base, similar tickets, organization, and the three mock tools of the intent.
    const evidence = ready.evidence as { id: string; kind: string; title: string; tool: string; mock: boolean }[];
    expect(evidence.map((card) => card.kind)).toEqual(expect.arrayContaining(['kb', 'data', 'log']));
    expect(evidence.find((card) => card.kind === 'log')).toMatchObject({ mock: true, tool: 'gcp_logs' });
    const report = ready.report as AiReport;
    expect(report.scope).toEqual({ intent: 'webhook_not_received', basis: 'confidence' });
    expect(report.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['kb_search', 'org_context', 'gcp_logs', 'bigquery_query']),
    );
    expect(report.findings.length).toBeGreaterThan(0);
    expect(ready.nextStepKind).toBe('approve_draft');
    expect(ready.progress).toBeNull();
    expect(ready.draftId).not.toBeNull();

    // The draft: waits as `draft`, cites evidence that exists, in the customer's language.
    const [draft] = await draftsOf(ticketId);
    expect(draft).toMatchObject({
      id: ready.draftId,
      status: 'draft',
      language: 'en',
      customerLanguage: 'en',
      disclosureLevel: 'restricted',
      promptId: 'drafter',
    });
    expect(draft?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const ids = new Set(evidence.map((card) => card.id));
    for (const citation of draft?.citations ?? []) expect(ids.has(citation.evidenceId)).toBe(true);
    expect(draft?.bodyText).not.toContain('pat.example@customer.example.test');

    // N3: no message to the customer, no delivery, no approval.
    const outbound = (await owner().select().from(schema.message).where(eq(schema.message.ticketId, ticketId))).filter(
      (message) => message.direction === 'outbound',
    );
    expect(outbound).toEqual([]);
    expect(await owner().select().from(schema.outboundDelivery)).toEqual([]);
    expect(draft?.approvedBy).toBeNull();

    // Every run is on record, and the tool calls are on the ledger with hashes, never inputs.
    const runs = await runsOf(ticketId);
    expect(runs.map((run) => run.agent).toSorted()).toEqual(['classifier', 'drafter', 'investigator', 'summarizer']);
    const investigatorRun = runs.find((run) => run.agent === 'investigator');
    expect(investigatorRun?.tools).toEqual(expect.arrayContaining(['kb_search', 'gcp_logs']));
    expect(investigatorRun?.model).toBe('mock-deep');
    expect(draft?.aiRunId).toBe(runs.find((run) => run.agent === 'drafter')?.id);
    const tools = await toolRowsOf(ticketId);
    expect(tools.length).toBeGreaterThanOrEqual(report.tools.length);
    expect(tools.every((row) => row.status === 'ok' && /^[0-9a-f]{64}$/.test(row.inputHash))).toBe(true);
    expect(tools.find((row) => row.tool === 'gcp_logs')).toMatchObject({ mock: true, intent: 'webhook_not_received' });
    expect(tools.length).toBeLessThanOrEqual(AI_TOOL_BUDGETS.perRun);
    expect(JSON.stringify(tools)).not.toContain('webhook is not received');

    // The model never saw the address (N4), in the ticket or anywhere.
    expect(JSON.stringify(requests)).not.toContain('pat.example@customer.example.test');
  });

  it('scopes the system tools to an intent only when the model is sure or a person chose it (SR106-R8)', async () => {
    // Unsure classifier, no person: only the generic tools run.
    classifierConfidence = AI_INTENT_SCOPE_MIN_CONFIDENCE - 0.2;
    const unsure = await createTicket('Webhook not received', 'webhook is not received', {
      intentKey: 'webhook_not_received',
    });
    const unsureInsight = await settled(unsure);
    const unsureReport = unsureInsight.report as AiReport;
    expect(unsureReport.scope).toEqual({ intent: null, basis: 'none' });
    expect(unsureReport.tools.map((tool) => tool.name)).not.toContain('gcp_logs');
    expect((await toolRowsOf(unsure)).map((row) => row.tool)).not.toContain('gcp_logs');

    // A person created the ticket with the intent: trusted whatever the classifier said.
    const confirmed = await createTicket('Webhook not received', 'webhook is not received', {
      intentKey: 'webhook_not_received',
      actor: { type: 'user', id: staffId },
    });
    const confirmedReport = (await settled(confirmed)).report as AiReport;
    expect(confirmedReport.scope).toEqual({ intent: 'webhook_not_received', basis: 'human_confirmed' });
    expect(confirmedReport.tools.map((tool) => tool.name)).toContain('gcp_logs');
  });

  it('keeps the tool budget across jobs for one ticket', async () => {
    classifierConfidence = 0.9;
    const ticketId = await createTicket('Webhook not received', 'webhook is not received', {
      intentKey: 'webhook_not_received',
    });
    await settled(ticketId, 'draft_ready');
    const first = (await toolRowsOf(ticketId)).length;
    // Asking again and again cannot go past the ticket's hour: the extra calls are recorded as denied.
    const rounds = Math.ceil(AI_TOOL_BUDGETS.perTicketPerHour / first) + 1;
    for (let round = 0; round < rounds; round += 1) {
      await enqueueAi(AI_JOBS.investigate, { ticketId, requestedBy: staffId });
    }
    await waitFor('the denials', async () =>
      (await toolRowsOf(ticketId)).some((row) => row.status === 'denied') ? true : undefined,
    );
    const rows = await toolRowsOf(ticketId);
    expect(rows.filter((row) => row.status !== 'denied').length).toBeLessThanOrEqual(
      AI_TOOL_BUDGETS.perTicketPerHour,
    );
    expect(rows.find((row) => row.status === 'denied')?.errorCode).toMatch(/budget|rate/);
  });
});

describe('stages decide whether a draft is made (N3)', () => {
  it('stage 1 investigates but drafts only when asked; stage 0 never drafts', async () => {
    classifierIntent = 'stage_one';
    const one = await createTicket('Stage one topic', 'something about stage one', {
      intentKey: 'stage_one',
    });
    const investigated = await settled(one);
    expect(investigated.state).toBe('classified');
    expect(await draftsOf(one)).toEqual([]);

    await enqueueAi(AI_JOBS.draft, { ticketId: one, requestedBy: staffId });
    const drafted = await settled(one, 'draft_ready');
    expect(drafted.draftId).not.toBeNull();
    expect((await draftsOf(one)).map((draft) => draft.requestedBy)).toEqual([staffId]);

    classifierIntent = 'stage_zero';
    const zero = await createTicket('Stage zero topic', 'something about stage zero', {
      intentKey: 'stage_zero',
    });
    await settled(zero);
    await enqueueAi(AI_JOBS.draft, { ticketId: zero, requestedBy: staffId });
    await waitFor('the request to be closed', async () => {
      const row = await insightRow(zero);
      return row?.state === 'classified' && row.progress === null ? row : undefined;
    });
    expect(await draftsOf(zero)).toEqual([]);
    // A new draft replaces the one that waited.
    await enqueueAi(AI_JOBS.draft, { ticketId: one, requestedBy: staffId });
    await waitFor('the second draft', async () => {
      const rows = await draftsOf(one);
      return rows.length === 2 ? rows : undefined;
    });
    expect((await draftsOf(one)).map((draft) => draft.status).toSorted()).toEqual(['draft', 'superseded']);
  });

  it('kill switch: the investigation makes no model call and says why', async () => {
    classifierIntent = 'webhook_not_received';
    const ticketId = await createTicket('Webhook not received', 'webhook is not received', {
      intentKey: 'webhook_not_received',
    });
    await settled(ticketId, 'draft_ready');
    await testDb.owner.pool.query(
      `UPDATE ai_switch SET is_on = true, reason = 'test' WHERE key = 'ai_kill_switch'`,
    );
    try {
      const before = (await runsOf(ticketId)).length;
      await enqueueAi(AI_JOBS.investigate, { ticketId, requestedBy: null });
      const row = await waitFor('needs_human', async () => {
        const current = await insightRow(ticketId);
        return current?.state === 'needs_human' ? current : undefined;
      });
      expect(row.reasonCode).toBe('kill_switch_on');
      expect((await runsOf(ticketId)).length).toBe(before);
    } finally {
      await testDb.owner.pool.query(`UPDATE ai_switch SET is_on = false WHERE key = 'ai_kill_switch'`);
    }
  });
});

describe('KB author (AC-4)', () => {
  async function resolvedTicket(): Promise<string> {
    const ticketId = await createTicket('Export is empty', 'The export file is empty for last week.');
    await appDatabase.db.transaction(async (tx) => {
      const ctx = domain.context({ actor: { type: 'user', id: staffId } });
      await domain.tickets.reply(tx, ctx, {
        ref: ticketId,
        reply: { body: 'Clear the date filter and run the export again. That fixed it.' },
        sender: { kind: 'staff', userId: staffId },
      });
      await domain.tickets.changeStatus(tx, ctx, { ref: ticketId, status: 'resolved' });
    });
    return ticketId;
  }

  it('resolving a ticket queues the job for after a short wait, and names the person who resolved it', async () => {
    const ticketId = await resolvedTicket();
    const [job] = (await owner().select().from(schema.outbox)).filter(
      (row) => row.jobName === AI_JOBS.kbAuthor && (row.payload as { ticketId?: string }).ticketId === ticketId,
    );
    expect(job).toBeDefined();
    expect((job?.payload as { requestedBy: string }).requestedBy).toBe(staffId);
    const wait = (job?.nextAttemptAt.getTime() ?? 0) - (job?.createdAt.getTime() ?? 0);
    expect(wait).toBeGreaterThanOrEqual(KB_AUTHOR_DELAY_MS - 5000);
    expect(wait).toBeLessThan(KB_AUTHOR_DELAY_MS + 5000);
  });

  it('writes a draft article in review that the requester cannot publish, and does it once', async () => {
    const ticketId = await resolvedTicket();
    await enqueueAi(AI_JOBS.kbAuthor, { ticketId, requestedBy: staffId });
    const article = await waitFor('the draft article', async () => {
      const rows = await owner().select().from(schema.kbArticle);
      return rows.find((row) => row.sources.some((source) => source.ref === ticketId));
    });
    expect(article).toMatchObject({ status: 'in_review', visibility: 'internal', authorId: null });
    expect(article.publishedVersionId).toBeNull();
    const [version] = await owner()
      .select()
      .from(schema.kbArticleVersion)
      .where(eq(schema.kbArticleVersion.articleId, article.id));
    expect(version).toMatchObject({ authoredByMachine: true, requestedBy: staffId, createdBy: null });
    expect(version?.bodyMd).not.toMatch(/\[[A-Z_]+_\d+\]/);
    const [run] = (await runsOf(ticketId)).filter((row) => row.agent === 'kb_author');
    expect(run).toMatchObject({ status: 'ok', model: 'mock-standard' });

    // Once per ticket: a second job finds the article and makes no model call.
    const authorRuns = async () => (await runsOf(ticketId)).filter((row) => row.agent === 'kb_author').length;
    const before = await authorRuns();
    await enqueueAi(AI_JOBS.kbAuthor, { ticketId, requestedBy: staffId });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await authorRuns()).toBe(before);
    expect((await owner().select().from(schema.kbArticle)).filter((row) => row.sources.some((s) => s.ref === ticketId))).toHaveLength(1);
  });

  it('does nothing for a ticket that cited a knowledge base article', async () => {
    const ticketId = await resolvedTicket();
    const [draft] = await owner()
      .insert(schema.aiDraft)
      .values({
        ticketId,
        bodyText: 'Hello',
        status: 'sent',
        approvedBy: staffId,
        approvedAt: new Date(),
        disposition: 'approved',
        citations: [{ evidenceId: 'ev-1', sentence: 0, kind: 'kb' }],
      })
      .returning();
    expect(draft).toBeDefined();
    const authorCalls = () => requests.filter((request) => request.prompt.id === 'kb_author').length;
    const before = authorCalls();
    await enqueueAi(AI_JOBS.kbAuthor, { ticketId, requestedBy: staffId });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(authorCalls()).toBe(before);
    expect((await owner().select().from(schema.kbArticle)).filter((row) => row.sources.some((s) => s.ref === ticketId))).toEqual([]);
  });
});
