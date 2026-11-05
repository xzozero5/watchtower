import { randomBytes } from 'node:crypto';

import { mockSettings, type EmbeddingProvider, type EmbeddingRequest } from '@watchtower/ai';
import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import {
  createDomain,
  readAiUsage,
  readEmbeddingTokens,
  searchKb,
  type Domain,
  type KbAudience,
} from '@watchtower/domain';
import { QUEUE_NAMES, parseRedisUrl, type CreateKbArticle } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiRuntime } from '../ai/runtime.js';
import { createLogger } from '../logger.js';
import { testConfig, testSealKey } from '../testing/support.js';
import { startWorker, type RunningWorker } from '../worker.js';
import { chunkOptionsFrom } from './processor.js';
import { reembedAll } from './embed.js';

// The knowledge base indexing through the real worker (T-107b): Postgres (restricted application
// role) and Redis from docker compose, the deterministic mock embedding provider, nothing else.
// disableNetConnect allows loopback only, so a provider call that tried the network would fail.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const prefix = `wt-kb-${randomBytes(4).toString('hex')}`;
const net = disableNetConnect();

let testDb: TestDatabase;
let worker: RunningWorker;
let appDatabase: Database;
let domain: Domain;
let config: ReturnType<typeof testConfig>;
let providerRequests: EmbeddingRequest[] = [];
let slugs = 0;

const owner = () => testDb.owner.db;
const staff: KbAudience = { kind: 'staff' };

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  config = {
    ...testConfig({
      DATABASE_URL: testDb.appUrl,
      OUTBOX_POLL_INTERVAL_MS: '100',
      AI_DAILY_TOKEN_CAP: '1000000',
      KB_CHUNK_TARGET_CHARS: '300',
      KB_CHUNK_MAX_CHARS: '450',
      KB_CHUNK_MIN_CHARS: '40',
      KB_CHUNK_OVERLAP_CHARS: '40',
    }),
    listenPort: 0,
  };
  const inner = new (await import('@watchtower/ai')).MockEmbeddingProvider();
  const recording: EmbeddingProvider = {
    kind: 'mock',
    embed(request) {
      providerRequests.push(request);
      return inner.embed(request);
    },
  };
  worker = await startWorker(config, createLogger(config), {
    queuePrefix: prefix,
    realtimeChannel: `watchtower:realtime:${prefix}`,
    overrides: { ai: { embeddingProviders: { mock: recording } } },
  });
  appDatabase = createDatabase({ url: testDb.appUrl, max: 4, applicationName: 'wt-kb-test' });
  domain = createDomain({ ticketKeyPrefix: 'OPS', sealKey: testSealKey(config) });
  const people = await owner()
    .insert(schema.users)
    .values([
      { email: 'writer@example.test', name: 'Writer', role: 'agent' },
      { email: 'approver@example.test', name: 'Approver', role: 'lead' },
    ])
    .returning({ id: schema.users.id, role: schema.users.role });
  writerId = people.find((person) => person.role === 'agent')?.id ?? '';
  approverId = people.find((person) => person.role === 'lead')?.id ?? '';
});

afterAll(async () => {
  await worker.close();
  await appDatabase.close();
  const queue = new Queue(QUEUE_NAMES.kb, { connection: parseRedisUrl(config.REDIS_URL), prefix });
  await queue.obliterate({ force: true });
  await queue.close();
  await testDb.cleanup();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

beforeEach(async () => {
  providerRequests = [];
  await setKillSwitch(false);
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

const setKillSwitch = (on: boolean) =>
  testDb.owner.pool.query(
    `UPDATE ai_switch SET is_on = $1, reason = 'test' WHERE key = 'ai_kill_switch'`,
    [on],
  );

// Two different people: the one who writes and the approver who publishes (segregation of duties).
let writerId = '';
let approverId = '';
const ctx = (id = writerId) => domain.context({ actor: { type: 'user', id } });

async function article(fields: Partial<CreateKbArticle> = {}, publish = true) {
  slugs += 1;
  const created = (
    await appDatabase.db.transaction((tx) =>
      domain.kb.create(tx, ctx(), {
        slug: `worker-article-${String(slugs)}`,
        title: 'Title',
        bodyMd: 'Body',
        lang: 'en',
        kind: 'article',
        visibility: 'customer',
        orgIds: [],
        intentTags: [],
        sources: [],
        ...fields,
      }),
    )
  ).value;
  if (publish) {
    await appDatabase.db.transaction(async (tx) => {
      await domain.kb.transition(tx, ctx(), { articleId: created.articleId, to: 'in_review' });
      await domain.kb.publish(tx, ctx(approverId), {
        articleId: created.articleId,
        version: 1,
        audience: { visibility: fields.visibility ?? 'customer', orgIds: [] },
      });
    });
  }
  return created;
}

const chunksOf = (articleId: string) =>
  owner().select().from(schema.kbChunk).where(eq(schema.kbChunk.articleId, articleId));

const embeddedChunks = (articleId: string) =>
  waitFor('the chunks to be embedded', async () => {
    const rows = await chunksOf(articleId);
    return rows.length > 0 && rows.every((row) => row.embedding !== null) ? rows : undefined;
  });

const embedderRuns = () =>
  owner()
    .select()
    .from(schema.aiRun)
    .where(eq(schema.aiRun.agent, 'embedder'))
    .orderBy(schema.aiRun.createdAt);

const BODY = [
  '# Reset a password',
  '',
  'Open the sign-in page and choose Forgot password. A link is sent to the address on the account, for example a sample address.',
  '',
  '## Limits',
  '',
  'The link works once and expires after fifteen minutes. After five wrong tries the account is locked for an hour.',
].join('\n');

describe('knowledge base indexing, end to end on the mock provider', () => {
  it('chunks a published article and embeds the chunks with the active index, metered in ai_run', async () => {
    const before = (await embedderRuns()).length;
    const made = await article({ title: 'Reset', bodyMd: BODY });
    const rows = await embeddedChunks(made.articleId);

    expect(rows.map((row) => row.section)).toEqual([
      'Reset a password',
      'Reset a password > Limits',
    ]);
    expect(rows.every((row) => row.versionId === made.versionId)).toBe(true);
    expect(rows[0]?.embedding).toHaveLength(16);
    const [index] = await owner().select().from(schema.kbEmbeddingIndex);
    expect(index).toMatchObject({
      provider: 'mock',
      model: 'mock-embedding',
      dimensions: 16,
      isActive: true,
    });
    expect(rows.every((row) => row.embeddingIndexId === index?.id)).toBe(true);

    const runs = await embedderRuns();
    expect(runs.length).toBe(before + 1);
    expect(runs.at(-1)).toMatchObject({
      agent: 'embedder',
      status: 'ok',
      provider: 'mock',
      model: 'mock-embedding',
      ticketId: null,
    });
    expect(runs.at(-1)?.inputTokens).toBeGreaterThan(0);

    // The article is now found by both lists.
    const found = await searchKb(appDatabase.db, {
      query: 'forgot password',
      audience: staff,
      limit: 5,
    });
    expect(found.hits[0]).toMatchObject({ title: 'Reset', section: 'Reset a password' });
  });

  it('redacts personal data before the embedding provider sees any text (N4)', async () => {
    const made = await article({
      title: 'Escalations',
      bodyMd: 'For urgent cases write to oncall.person@example.com or call 0812345678 right away.',
    });
    await embeddedChunks(made.articleId);
    const sent = providerRequests.flatMap((request) => [...request.values]).join('\n');
    expect(sent).toContain('Escalations');
    expect(sent).not.toContain('oncall.person@example.com');
    expect(sent).not.toContain('0812345678');
    expect(sent).toContain('[EMAIL_1]');
    // The audit row holds counts, never the values.
    const run = (await embedderRuns()).at(-1);
    expect(JSON.stringify(run)).not.toContain('oncall.person');
    expect(run?.redaction).toMatchObject({ total: expect.any(Number) as number });
    expect((run?.redaction as { total: number }).total).toBeGreaterThanOrEqual(2);
    // The article's own text is stored as written: it is the staff's content, shown in citations.
    expect((await chunksOf(made.articleId))[0]?.text).toContain('oncall.person@example.com');
  });

  it('keeps the article searchable by keyword when the kill switch is on, then fills in vectors', async () => {
    await setKillSwitch(true);
    const runsBefore = (await embedderRuns()).length;
    const made = await article({
      title: 'Kill switch',
      bodyMd: 'The lanternfish procedure explains how to calibrate the beacon.',
    });
    const rows = await waitFor('keyword-only chunks', async () => {
      const found = await chunksOf(made.articleId);
      return found.length > 0 ? found : undefined;
    });
    // Give the job time to finish, then check that it did not embed or write an ai_run row.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(rows.every((row) => row.embedding === null && row.embeddingIndexId === null)).toBe(true);
    expect((await embedderRuns()).length).toBe(runsBefore);
    expect(providerRequests).toEqual([]);

    const keyword = await searchKb(appDatabase.db, {
      query: 'lanternfish',
      audience: staff,
      limit: 5,
    });
    expect(keyword.mode).toBe('keyword');
    expect(keyword.hits[0]?.title).toBe('Kill switch');

    await setKillSwitch(false);
    const runtime = createAiRuntime(config, appDatabase, createLogger(config));
    const result = await reembedAll({
      database: appDatabase,
      ai: runtime,
      logger: createLogger(config),
      chunking: chunkOptionsFrom(config),
    });
    expect(result).toMatchObject({ failed: 0 });
    expect(result.embedded).toBeGreaterThanOrEqual(1);
    await embeddedChunks(made.articleId);
  });

  it('replaces the chunks when a new version is published', async () => {
    const made = await article({ title: 'Versions', bodyMd: 'The old wording mentions pelicans.' });
    await embeddedChunks(made.articleId);
    await appDatabase.db.transaction(async (tx) => {
      await domain.kb.update(tx, ctx(), {
        articleId: made.articleId,
        patch: { bodyMd: 'The new wording mentions kestrels.' },
        canApprove: true,
      });
      // A new version of a live article is sent for review first; the article stays live meanwhile.
      await domain.kb.transition(tx, ctx(), { articleId: made.articleId, to: 'in_review' });
      await domain.kb.publish(tx, ctx(approverId), {
        articleId: made.articleId,
        version: 2,
        audience: { visibility: 'customer', orgIds: [] },
      });
    });
    const rows = await waitFor('the new text', async () => {
      const found = await chunksOf(made.articleId);
      return found.length > 0 &&
        found.every((row) => row.text.includes('kestrels') && row.embedding !== null)
        ? found
        : undefined;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.versionId).not.toBe(made.versionId);
  });

  it('removes the chunks of a deprecated article', async () => {
    const made = await article({ title: 'Retire', bodyMd: 'Text that will not stay for long.' });
    await embeddedChunks(made.articleId);
    await appDatabase.db.transaction((tx) =>
      domain.kb.transition(tx, ctx(approverId), { articleId: made.articleId, to: 'deprecated' }),
    );
    await waitFor('the chunks to be removed', async () =>
      (await chunksOf(made.articleId)).length === 0 ? true : undefined,
    );
  });
});

describe('re-embedding with a different model', () => {
  it('switches the active index and replaces the vectors of every published article', async () => {
    const made = await article({
      title: 'Model change',
      bodyMd: 'Albatross migration notes for the new model.',
    });
    const before = await embeddedChunks(made.articleId);
    const [oldIndex] = await owner()
      .select()
      .from(schema.kbEmbeddingIndex)
      .where(eq(schema.kbEmbeddingIndex.isActive, true));

    const settings = {
      ...mockSettings(),
      embedding: { provider: 'mock' as const, model: 'mock-embedding-v2', dimensions: 8 },
    };
    const runtime = createAiRuntime(config, appDatabase, createLogger(config), {
      settings: { load: () => Promise.resolve(settings) },
    });
    const result = await reembedAll({
      database: appDatabase,
      ai: runtime,
      logger: createLogger(config),
      chunking: chunkOptionsFrom(config),
    });
    expect(result.failed).toBe(0);
    expect(result.embedded).toBeGreaterThanOrEqual(1);

    const indexes = await owner().select().from(schema.kbEmbeddingIndex);
    const active = indexes.filter((index) => index.isActive);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ model: 'mock-embedding-v2', dimensions: 8 });
    expect(indexes.find((index) => index.id === oldIndex?.id)?.isActive).toBe(false);

    const after = await chunksOf(made.articleId);
    expect(after).toHaveLength(before.length);
    expect(after.every((row) => row.embeddingIndexId === active[0]?.id)).toBe(true);
    expect(after[0]?.embedding).toHaveLength(8);
    // Everything is on the new index now; a second pass has nothing to do.
    expect(
      (
        await reembedAll({
          database: appDatabase,
          ai: runtime,
          logger: createLogger(config),
          chunking: chunkOptionsFrom(config),
        })
      ).queued,
    ).toBe(0);
  });
});

describe('re-embedding into a local index (T-431, ADR-030)', () => {
  it('fills the new index first and switches it in only when every article is embedded', async () => {
    const made = await article({
      title: 'Local switch',
      bodyMd: 'Pangolin escalation notes for the local embedder.',
    });
    await embeddedChunks(made.articleId);
    const [before] = await owner()
      .select()
      .from(schema.kbEmbeddingIndex)
      .where(eq(schema.kbEmbeddingIndex.isActive, true));

    let healthy = false;
    const local: EmbeddingProvider = {
      kind: 'local',
      embed(request) {
        if (!healthy) return Promise.reject(new Error('embedder is down'));
        return Promise.resolve({
          embeddings: request.values.map(() => Array.from({ length: 8 }, () => 0.5)),
          usage: { tokens: 1 },
          model: request.model,
        });
      },
    };
    const settings = {
      ...mockSettings(),
      embedding: { provider: 'local' as const, model: 'local-test', dimensions: 8 },
    };
    const runtime = createAiRuntime(config, appDatabase, createLogger(config), {
      settings: { load: () => Promise.resolve(settings) },
      embeddingProviders: { local },
    });
    const run = () =>
      reembedAll({
        database: appDatabase,
        ai: runtime,
        logger: createLogger(config),
        chunking: chunkOptionsFrom(config),
      });
    const activeModel = async () =>
      (
        await owner()
          .select()
          .from(schema.kbEmbeddingIndex)
          .where(eq(schema.kbEmbeddingIndex.isActive, true))
      )[0]?.model;

    // The embedder is down: nothing switches, the old index stays active, the failure is counted.
    const down = await run();
    expect(down.failed).toBeGreaterThanOrEqual(1);
    expect(down.activated).toBe(false);
    expect(await activeModel()).toBe(before?.model);

    // It comes back: the next run embeds everything and switches in one step.
    healthy = true;
    const up = await run();
    expect(up.failed).toBe(0);
    expect(up.activated).toBe(true);
    expect(await activeModel()).toBe('local-test');
    const indexes = await owner().select().from(schema.kbEmbeddingIndex);
    expect(indexes.filter((index) => index.isActive)).toHaveLength(1);
    expect(indexes.find((index) => index.model === 'local-test')?.provider).toBe('local');
    const after = await chunksOf(made.articleId);
    expect(after[0]?.embedding).toHaveLength(8);

    // The calls are metered as ai_run rows of provider local; nothing is left to do.
    const runs = await owner()
      .select()
      .from(schema.aiRun)
      .where(eq(schema.aiRun.provider, 'local'));
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.every((row) => row.agent === 'embedder')).toBe(true);
    expect((await run()).queued).toBe(0);
  });
});

describe('re-embedding against the embedding cap (T-435 C-1)', () => {
  it('stops at its own cap without failing, keeps the LLM budget untouched and the old index active, then finishes after the cap is raised', async () => {
    const made = await article({
      title: 'Cap one',
      bodyMd: 'Quokka capacity notes for the embedding cap test.',
    });
    await article({
      title: 'Cap two',
      bodyMd: 'Numbat capacity notes for the embedding cap test.',
    });
    await embeddedChunks(made.articleId);
    const now = new Date();
    const llmBefore = await readAiUsage(owner(), now);
    const usedBefore = await readEmbeddingTokens(owner(), now);
    const activeModel = async () =>
      (
        await owner()
          .select()
          .from(schema.kbEmbeddingIndex)
          .where(eq(schema.kbEmbeddingIndex.isActive, true))
      )[0]?.model;
    const modelBefore = await activeModel();

    let calls = 0;
    const local: EmbeddingProvider = {
      kind: 'local',
      embed(request) {
        calls += 1;
        return Promise.resolve({
          embeddings: request.values.map(() => Array.from({ length: 8 }, () => 0.25)),
          // A call that alone passes the cap: the next call must be refused.
          usage: { tokens: 1_000 },
          model: request.model,
        });
      },
    };
    const settings = {
      ...mockSettings(),
      embedding: { provider: 'local' as const, model: 'local-cap-test', dimensions: 8 },
    };
    const runtimeWith = (cap: number) =>
      createAiRuntime(
        { ...config, EMBEDDING_DAILY_TOKEN_CAP: cap },
        appDatabase,
        createLogger(config),
        { settings: { load: () => Promise.resolve(settings) }, embeddingProviders: { local } },
      );
    const run = (cap: number) =>
      reembedAll({
        database: appDatabase,
        ai: runtimeWith(cap),
        logger: createLogger(config),
        chunking: chunkOptionsFrom(config),
      });

    const capped = await run(usedBefore + 1);
    expect(capped).toMatchObject({ failed: 0, activated: false, deferred: 'budget_stop' });
    expect(capped.embedded).toBe(1);
    expect(calls).toBe(1);
    // The old index is still the active one and the LLM budget did not move.
    expect(await activeModel()).toBe(modelBefore);
    const llmAfter = await readAiUsage(owner(), new Date());
    expect(llmAfter.tokens).toBe(llmBefore.tokens);
    expect(llmAfter.costUsd).toBe(llmBefore.costUsd);
    expect(await readEmbeddingTokens(owner(), new Date())).toBeGreaterThan(usedBefore);

    // The run did not strip the articles it never reached: every chunk still has a vector.
    const all = await owner().select().from(schema.kbChunk);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((row) => row.embedding !== null)).toBe(true);

    // With room again the run finishes and the index switches.
    const done = await run(usedBefore + 10_000_000);
    expect(done).toMatchObject({ failed: 0, activated: true });
    expect(done.deferred).toBeUndefined();
    expect(await activeModel()).toBe('local-cap-test');
    expect((await run(usedBefore + 10_000_000)).queued).toBe(0);
  });
});

describe('without an AI runtime (provider not wired)', () => {
  it('stores keyword-only chunks and never calls a provider', async () => {
    const made = await article({ title: 'No runtime', bodyMd: 'Quokka handling guide.' });
    await waitFor('chunks', async () =>
      (await chunksOf(made.articleId)).length > 0 ? true : undefined,
    );
    const { embedArticle } = await import('./embed.js');
    const result = await embedArticle(
      {
        database: appDatabase,
        ai: undefined,
        logger: createLogger(config),
        chunking: chunkOptionsFrom(config),
      },
      made.articleId,
      made.versionId,
    );
    expect(result).toMatchObject({ status: 'keyword_only', reason: 'provider_unavailable' });
    const rows = await chunksOf(made.articleId);
    expect(rows.every((row) => row.embedding === null)).toBe(true);
  });

  it('ignores a job for a version that is no longer live', async () => {
    const made = await article({ title: 'Stale job', bodyMd: 'Version one text.' });
    await embeddedChunks(made.articleId);
    const { embedArticle } = await import('./embed.js');
    const result = await embedArticle(
      {
        database: appDatabase,
        ai: createAiRuntime(config, appDatabase, createLogger(config)),
        logger: createLogger(config),
        chunking: chunkOptionsFrom(config),
      },
      made.articleId,
      '5b0b8f0e-6c6e-4f5e-9d6e-1b2c3d4e5f60',
    );
    expect(result.status).toBe('stale');
  });
});
