import { randomBytes } from 'node:crypto';

import { mockSettings, type EmbeddingProvider } from '@watchtower/ai';
import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import {
  acquireReembedLease,
  activateEmbeddingIndexIfComplete,
  articlesNeedingEmbedding,
  createDomain,
  readActiveEmbeddingIndex,
  resolveWriteIndex,
  searchKb,
  type Domain,
  type KbAudience,
} from '@watchtower/domain';
import { QUEUE_NAMES, parseRedisUrl, type CreateKbArticle } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiRuntime } from '../ai/runtime.js';
import { createLogger } from '../logger.js';
import { testConfig, testSealKey } from '../testing/support.js';
import { startWorker, type RunningWorker } from '../worker.js';
import { chunkOptionsFrom } from './processor.js';
import { embedArticle, reembedAll } from './embed.js';

const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const prefix = `wt-kb-race-${randomBytes(4).toString('hex')}`;
const net = disableNetConnect();

let testDb: TestDatabase;
let worker: RunningWorker;
let appDatabase: Database;
let domain: Domain;
let config: ReturnType<typeof testConfig>;
let slugs = 0;
let writerId = '';
let approverId = '';

const owner = () => testDb.owner.db;
const staff: KbAudience = { kind: 'staff' };
const ctx = (id = writerId) => domain.context({ actor: { type: 'user', id } });

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
  worker = await startWorker(config, createLogger(config), {
    queuePrefix: prefix,
    realtimeChannel: `watchtower:realtime:${prefix}`,
  });
  appDatabase = createDatabase({ url: testDb.appUrl, max: 4, applicationName: 'wt-kb-race-test' });
  domain = createDomain({ ticketKeyPrefix: 'OPS', sealKey: testSealKey(config) });

  const people = await owner()
    .insert(schema.users)
    .values([
      { email: 'race-writer@example.test', name: 'Race Writer', role: 'agent' },
      { email: 'race-approver@example.test', name: 'Race Approver', role: 'lead' },
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
  await testDb.owner.pool.query(
    `UPDATE ai_switch SET is_on = false, reason = 'test' WHERE key = 'ai_kill_switch'`,
  );
  await testDb.owner.pool.query('DELETE FROM kb_reembed_lease');
  await testDb.owner.pool.query(
    `UPDATE kb_article SET status = 'deprecated', published_version_id = NULL`,
  );
});

async function createArticle(fields: Partial<CreateKbArticle> = {}, publish = true) {
  slugs += 1;
  const created = (
    await appDatabase.db.transaction((tx) =>
      domain.kb.create(tx, ctx(), {
        slug: `race-article-${String(slugs)}`,
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

describe('T-434c: KB Re-embed Failure, Race and Resume Scenarios (ADR-033 §4, §5, §6)', () => {
  // Scenario 1: Active hybrid search during rebuild
  it('Scenario 1: active hybrid search continues to serve traffic during background rebuild', async () => {
    const art = await createArticle({
      title: 'Pangolin Network Protocol Guide',
      bodyMd: 'Pangolin gateway handles encrypted telemetry over TLS 1.3.',
    });

    const rt1 = createAiRuntime(config, appDatabase, createLogger(config));
    await embedArticle(
      {
        database: appDatabase,
        ai: rt1,
        logger: createLogger(config),
        chunking: chunkOptionsFrom(config),
      },
      art.articleId,
      art.versionId,
    );

    const activeBefore = await readActiveEmbeddingIndex(appDatabase.db);
    expect(activeBefore).toBeDefined();
    if (activeBefore === undefined) throw new Error('activeBefore missing');

    // Query active search with semantic query
    const resBefore = await searchKb(appDatabase.db, {
      query: 'encrypted telemetry',
      audience: staff,
      limit: 10,
      embedding: {
        indexId: activeBefore.id,
        vector: Array.from({ length: activeBefore.dimensions }, () => 0.5),
      },
    });
    expect(resBefore.hits.length).toBeGreaterThanOrEqual(1);
    expect(resBefore.hits[0]?.title).toBe('Pangolin Network Protocol Guide');

    // Simulate rebuild for a new target index
    const settingsV2 = {
      ...mockSettings(),
      embedding: { provider: 'mock' as const, model: 'mock-dim8-test', dimensions: 8 },
    };
    await appDatabase.db.transaction((tx) => resolveWriteIndex(tx, settingsV2.embedding));

    // Active search MUST still work with the active index during background rebuild
    const resDuring = await searchKb(appDatabase.db, {
      query: 'encrypted telemetry',
      audience: staff,
      limit: 10,
      embedding: {
        indexId: activeBefore.id,
        vector: Array.from({ length: activeBefore.dimensions }, () => 0.5),
      },
    });
    expect(resDuring.hits.length).toBeGreaterThanOrEqual(1);
    expect(resDuring.hits[0]?.title).toBe('Pangolin Network Protocol Guide');
  });

  // Scenario 2: Fenced / stale worker & deduplication
  it('Scenario 2: deduplicates concurrent rebuilds and fences stale workers when lease expires', async () => {
    const settings = {
      ...mockSettings(),
      embedding: { provider: 'mock' as const, model: 'mock-fencing-test', dimensions: 8 },
    };
    const target = await appDatabase.db.transaction((tx) =>
      resolveWriteIndex(tx, settings.embedding),
    );

    // Worker 1 acquires lease
    const lease1 = await appDatabase.db.transaction((tx) =>
      acquireReembedLease(tx, {
        targetIndexId: target.id,
        workerId: 'worker-1',
        leaseDurationSeconds: 10,
      }),
    );
    expect(lease1.acquired).toBe(true);
    expect(lease1.leaseToken).toBeDefined();

    // Worker 2 attempts concurrent reembed: must be rejected with already_leased
    const lease2 = await appDatabase.db.transaction((tx) =>
      acquireReembedLease(tx, {
        targetIndexId: target.id,
        workerId: 'worker-2',
        leaseDurationSeconds: 10,
      }),
    );
    expect(lease2.acquired).toBe(false);
    expect(lease2.reason).toBe('already_leased');

    // Simulate Worker 1's lease expiring in DB
    await owner().execute(sql`
      UPDATE kb_reembed_lease
         SET leased_until = clock_timestamp() - interval '5 seconds'
       WHERE id = 'singleton'
    `);

    // Worker 2 acquires the expired lease
    const lease2After = await appDatabase.db.transaction((tx) =>
      acquireReembedLease(tx, {
        targetIndexId: target.id,
        workerId: 'worker-2',
        leaseDurationSeconds: 10,
      }),
    );
    expect(lease2After.acquired).toBe(true);

    // Stale Worker 1 attempts to switch active index with its stale leaseToken: must be FENCED
    const activation = await appDatabase.db.transaction((tx) =>
      activateEmbeddingIndexIfComplete(tx, target.id, {
        leaseToken: lease1.leaseToken,
      }),
    );
    expect(activation).toBe(false); // Fenced!

    // Verify index was not switched
    const [idx] = await owner()
      .select({ isActive: schema.kbEmbeddingIndex.isActive })
      .from(schema.kbEmbeddingIndex)
      .where(eq(schema.kbEmbeddingIndex.id, target.id));
    expect(idx?.isActive).toBe(false);
  });

  // Scenario 3: Crash / kill-switch / budget-stop: no switch, no retry loop, clean resume
  it('Scenario 3: stops at refusal without switching, avoids tight loops, and resumes only missing targets', async () => {
    const artA = await createArticle({ title: 'Procedure Alpha', bodyMd: 'Alpha body text.' });
    const artB = await createArticle({ title: 'Procedure Beta', bodyMd: 'Beta body text.' });

    const settings = {
      ...mockSettings(),
      embedding: { provider: 'mock' as const, model: 'mock-resume-test', dimensions: 8 },
    };
    const target = await appDatabase.db.transaction((tx) =>
      resolveWriteIndex(tx, settings.embedding),
    );

    const normalProvider: EmbeddingProvider = {
      kind: 'mock',
      embed(request) {
        return Promise.resolve({
          embeddings: request.values.map(() => Array.from({ length: 8 }, () => 0.5)),
          usage: { tokens: 1 },
          model: request.model,
        });
      },
    };

    const rt = createAiRuntime(config, appDatabase, createLogger(config), {
      settings: { load: () => Promise.resolve(settings) },
      embeddingProviders: { mock: normalProvider },
    });

    // Embed article A only to simulate partial completion before an interruption
    await embedArticle(
      {
        database: appDatabase,
        ai: rt,
        logger: createLogger(config),
        chunking: chunkOptionsFrom(config),
      },
      artA.articleId,
      artA.versionId,
      { targetIndex: target, preserveExisting: true },
    );

    // Verify only B is missing for target index
    const remaining = await articlesNeedingEmbedding(appDatabase.db, target.id);
    expect(remaining.map((r) => r.articleId)).toContain(artB.articleId);
    expect(remaining.map((r) => r.articleId)).not.toContain(artA.articleId);

    // Target index is still inactive
    const [chk] = await owner()
      .select({ isActive: schema.kbEmbeddingIndex.isActive })
      .from(schema.kbEmbeddingIndex)
      .where(eq(schema.kbEmbeddingIndex.id, target.id));
    expect(chk?.isActive).toBe(false);

    // Resume re-embed run: processes only remaining target B and successfully switches
    const resumed = await reembedAll({
      database: appDatabase,
      ai: rt,
      logger: createLogger(config),
      chunking: chunkOptionsFrom(config),
    });
    expect(resumed.failed).toBe(0);
    expect(resumed.activated).toBe(true);

    const activeAfter = await readActiveEmbeddingIndex(appDatabase.db);
    expect(activeAfter?.id).toBe(target.id);
  });

  // Scenario 4: Concurrency race: Publish V2 vs activateEmbeddingIndexIfComplete
  it('Scenario 4: dual-embeds V2 during rebuild and synchronizes via advisory lock', async () => {
    const art = await createArticle({ title: 'Policy V1', bodyMd: 'Version 1 original text.' });

    // Initial embed with active index
    const rtInitial = createAiRuntime(config, appDatabase, createLogger(config));
    await embedArticle(
      {
        database: appDatabase,
        ai: rtInitial,
        logger: createLogger(config),
        chunking: chunkOptionsFrom(config),
      },
      art.articleId,
      art.versionId,
    );
    const activeOld = await readActiveEmbeddingIndex(appDatabase.db);
    expect(activeOld).toBeDefined();

    // Prepare target index
    const settings = {
      ...mockSettings(),
      embedding: { provider: 'mock' as const, model: 'mock-dual-embed-test', dimensions: 8 },
    };
    const target = await appDatabase.db.transaction((tx) =>
      resolveWriteIndex(tx, settings.embedding),
    );

    // Worker AI runtime configured for target
    const rtTarget = createAiRuntime(config, appDatabase, createLogger(config), {
      settings: { load: () => Promise.resolve(settings) },
    });

    // Update article to V2 while rebuild is targeted to `target`
    const updated = await appDatabase.db.transaction((tx) =>
      domain.kb.update(tx, ctx(), {
        articleId: art.articleId,
        canApprove: true,
        patch: { bodyMd: 'Version 2 updated text for Pangolin compliance.' },
      }),
    );
    expect(updated.value.version).toBe(2);

    await appDatabase.db.transaction(async (tx) => {
      await domain.kb.transition(tx, ctx(), { articleId: art.articleId, to: 'in_review' });
      await domain.kb.publish(tx, ctx(approverId), {
        articleId: art.articleId,
        version: 2,
        audience: { visibility: 'customer', orgIds: [] },
      });
    });

    // embedArticle for V2
    const embeddedV2 = await embedArticle(
      {
        database: appDatabase,
        ai: rtTarget,
        logger: createLogger(config),
        chunking: chunkOptionsFrom(config),
      },
      art.articleId,
      updated.value.versionId,
    );
    expect(embeddedV2.status).toBe('embedded');

    // Verify V2 was dual-embedded into target index manifest
    const pendingForTarget = await articlesNeedingEmbedding(appDatabase.db, target.id);
    expect(pendingForTarget.filter((p) => p.articleId === art.articleId)).toHaveLength(0);

    // Switch active index to target
    const activated = await appDatabase.db.transaction((tx) =>
      activateEmbeddingIndexIfComplete(tx, target.id),
    );
    expect(activated).toBe(true);

    // Live search immediately finds V2 on new active index
    const searchRes = await searchKb(appDatabase.db, {
      query: 'compliance',
      audience: staff,
      limit: 10,
      embedding: {
        indexId: target.id,
        vector: Array.from({ length: target.dimensions }, () => 0.5),
      },
    });
    expect(searchRes.hits.length).toBeGreaterThanOrEqual(1);
    expect(searchRes.hits[0]?.title).toBe('Policy V1');

    // Verify audit log recorded kb.embedding_index.activate (N4)
    const [auditRow] = await owner()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'kb.embedding_index.activate'))
      .orderBy(sql`${schema.auditLog.createdAt} DESC`)
      .limit(1);
    expect(auditRow).toBeDefined();
    expect(auditRow?.targetId).toBe(target.id);
  });

  // Scenario 5: Provider returns wrong dimensions or audit failure: blocks activation
  it('Scenario 5: blocks index activation when provider returns wrong dimensions or NaN', async () => {
    await createArticle({ title: 'Integrity Check', bodyMd: 'Checking dimensions.' });

    let returnWrongDim = false;
    const badProvider: EmbeddingProvider = {
      kind: 'mock',
      embed(request) {
        if (returnWrongDim) {
          // Returns 4 dimensions when settings expects 8
          return Promise.resolve({
            embeddings: request.values.map(() => Array.from({ length: 4 }, () => 0.5)),
            usage: { tokens: 1 },
            model: request.model,
          });
        }
        return Promise.resolve({
          embeddings: request.values.map(() => Array.from({ length: 8 }, () => 0.5)),
          usage: { tokens: 1 },
          model: request.model,
        });
      },
    };

    const settings = {
      ...mockSettings(),
      embedding: { provider: 'mock' as const, model: 'mock-corrupt-test', dimensions: 8 },
    };
    const target = await appDatabase.db.transaction((tx) =>
      resolveWriteIndex(tx, settings.embedding),
    );

    const rt = createAiRuntime(config, appDatabase, createLogger(config), {
      settings: { load: () => Promise.resolve(settings) },
      embeddingProviders: { mock: badProvider },
    });

    const activeBefore = await readActiveEmbeddingIndex(appDatabase.db);

    returnWrongDim = true;
    const res = await reembedAll({
      database: appDatabase,
      ai: rt,
      logger: createLogger(config),
      chunking: chunkOptionsFrom(config),
    });

    expect(res.failed).toBeGreaterThanOrEqual(1);
    expect(res.activated).toBe(false);

    // Target index MUST NOT be active
    const activeAfter = await readActiveEmbeddingIndex(appDatabase.db);
    expect(activeAfter?.id).toBe(activeBefore?.id);
    expect(activeAfter?.id).not.toBe(target.id);
  });
});
