import { schema } from '@watchtower/db';
import type { CreateKbArticle } from '@watchtower/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addStaff, startDomainTest, type DomainTestEnv } from '../testing/support.js';
import {
  activateEmbeddingIndexIfComplete,
  articlesNeedingEmbedding,
  computeChunkSetFingerprint,
  ensureActiveEmbeddingIndex,
  replaceArticleChunks,
  resolveWriteIndex,
  type ChunkToStore,
} from './chunks.js';
import { searchKb, type KbAudience } from './search.js';

let env: DomainTestEnv;
let author: Awaited<ReturnType<typeof addStaff>>;
let lead: Awaited<ReturnType<typeof addStaff>>;
let slugCounter = 0;

beforeAll(async () => {
  env = await startDomainTest();
  author = await addStaff(env, 'agent');
  lead = await addStaff(env, 'lead');
}, 60_000);

afterAll(async () => {
  await env.close();
});

const staff: KbAudience = { kind: 'staff' };

const input = (fields: Partial<CreateKbArticle> = {}): CreateKbArticle => {
  slugCounter += 1;
  return {
    slug: `multi-index-${String(slugCounter)}`,
    title: 'Title',
    bodyMd: 'Body content',
    lang: 'en',
    kind: 'article',
    visibility: 'internal',
    orgIds: [],
    intentTags: [],
    sources: [],
    ...fields,
  };
};

const createAndPublish = async (fields: Partial<CreateKbArticle> = {}) => {
  const created = (
    await env.tx((tx) => env.domain.kb.create(tx, env.ctx(author.actor), input(fields)))
  ).value;
  await env.tx(async (tx) => {
    await env.domain.kb.transition(tx, env.ctx(author.actor), {
      articleId: created.articleId,
      to: 'in_review',
    });
    await env.domain.kb.publish(tx, env.ctx(lead.actor), {
      articleId: created.articleId,
      version: 1,
      audience: { visibility: fields.visibility ?? 'internal', orgIds: [] },
    });
  });
  return created;
};

describe('KB Multi-Index Persistence & Active Query Routing (ADR-033 §1, §2, §3, §4)', () => {
  it('preserves immutable chunks when filling vectors for a second index (ADR-033 §2)', async () => {
    const article = await createAndPublish({
      title: 'Postgres Connection Pooling',
      bodyMd: 'Pgbouncer manages connections efficiently.',
    });

    // 1. Setup active index 1 (dim 4)
    const index1 = await env.tx((tx) =>
      ensureActiveEmbeddingIndex(tx, { provider: 'mock', model: 'mock-4d', dimensions: 4 }),
    );

    // 2. Setup inactive index 2 (dim 2)
    const index2 = await env.tx((tx) =>
      resolveWriteIndex(tx, { provider: 'mock', model: 'mock-2d', dimensions: 2 }),
    );
    expect(index2.active).toBe(false);

    const chunkList: ChunkToStore[] = [
      {
        ordinal: 0,
        section: 'Postgres Connection Pooling',
        text: 'Pgbouncer manages connections efficiently.',
        charStart: 0,
        charEnd: 42,
        embedding: [0.1, 0.2, 0.3, 0.4],
      },
    ];

    // Store chunks under active index 1
    const stored1 = await env.tx((tx) =>
      replaceArticleChunks(tx, {
        articleId: article.articleId,
        versionId: article.versionId,
        title: 'Postgres Connection Pooling',
        chunks: chunkList,
        embeddingIndexId: index1.id,
      }),
    );
    expect(stored1).toBe(true);

    const initialChunks = await env.database.db
      .select({ id: schema.kbChunk.id, fingerprint: schema.kbChunk.chunkSetFingerprint })
      .from(schema.kbChunk)
      .where(eq(schema.kbChunk.articleId, article.articleId));
    expect(initialChunks).toHaveLength(1);
    const chunkId = initialChunks[0]?.id;
    expect(chunkId).toBeDefined();

    // Verify index 1 vector is in kb_chunk_embedding
    const embeddingsIdx1 = await env.database.db
      .select()
      .from(schema.kbChunkEmbedding)
      .where(
        and(
          eq(schema.kbChunkEmbedding.chunkId, chunkId as string),
          eq(schema.kbChunkEmbedding.indexId, index1.id),
        ),
      );
    expect(embeddingsIdx1).toHaveLength(1);
    expect(embeddingsIdx1[0]?.embedding).toEqual([0.1, 0.2, 0.3, 0.4]);

    // Also check dual-write to kb_chunk for active index 1
    const [cRow1] = await env.database.db
      .select({ embedding: schema.kbChunk.embedding, indexId: schema.kbChunk.embeddingIndexId })
      .from(schema.kbChunk)
      .where(eq(schema.kbChunk.id, chunkId as string));
    expect(cRow1?.embedding).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(cRow1?.indexId).toBe(index1.id);

    // 3. Now fill vectors for inactive index 2 (without deleting/reinserting kb_chunk!)
    const chunkList2: ChunkToStore[] = [
      {
        ordinal: 0,
        section: 'Postgres Connection Pooling',
        text: 'Pgbouncer manages connections efficiently.',
        charStart: 0,
        charEnd: 42,
        embedding: [0.9, 0.8],
      },
    ];

    const stored2 = await env.tx((tx) =>
      replaceArticleChunks(tx, {
        articleId: article.articleId,
        versionId: article.versionId,
        title: 'Postgres Connection Pooling',
        chunks: chunkList2,
        embeddingIndexId: index2.id,
      }),
    );
    expect(stored2).toBe(true);

    // Verify that kb_chunk ID was PRESERVED and not deleted/reinserted
    const chunksAfter = await env.database.db
      .select({ id: schema.kbChunk.id })
      .from(schema.kbChunk)
      .where(eq(schema.kbChunk.articleId, article.articleId));
    expect(chunksAfter).toHaveLength(1);
    expect(chunksAfter[0]?.id).toBe(chunkId);

    // Verify kb_chunk_embedding has vectors for BOTH index 1 and index 2
    const allEmbeddings = await env.database.db
      .select()
      .from(schema.kbChunkEmbedding)
      .where(eq(schema.kbChunkEmbedding.chunkId, chunkId as string));
    expect(allEmbeddings).toHaveLength(2);

    const vec1 = allEmbeddings.find((e) => e.indexId === index1.id);
    const vec2 = allEmbeddings.find((e) => e.indexId === index2.id);
    expect(vec1?.embedding).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(vec2?.embedding).toEqual([0.9, 0.8]);

    // Active index 1 vector on kb_chunk was NOT overwritten by inactive index 2
    const [cRow2] = await env.database.db
      .select({ embedding: schema.kbChunk.embedding, indexId: schema.kbChunk.embeddingIndexId })
      .from(schema.kbChunk)
      .where(eq(schema.kbChunk.id, chunkId as string));
    expect(cRow2?.embedding).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(cRow2?.indexId).toBe(index1.id);

    // 4. Activate index 2 atomically
    const activated = await env.tx((tx) => activateEmbeddingIndexIfComplete(tx, index2.id));
    expect(activated).toBe(true);

    // After activation, kb_chunk.embedding reflects the newly active index 2
    const [cRowActive2] = await env.database.db
      .select({ embedding: schema.kbChunk.embedding, indexId: schema.kbChunk.embeddingIndexId })
      .from(schema.kbChunk)
      .where(eq(schema.kbChunk.id, chunkId as string));
    expect(cRowActive2?.embedding).toEqual([0.9, 0.8]);
    expect(cRowActive2?.indexId).toBe(index2.id);
  });

  it('handles empty articles without infinite embedding loop (ADR-033 §2)', async () => {
    // Create an empty article (0 chunks)
    const emptyArt = await createAndPublish({
      title: 'Empty Procedure Placeholder',
      bodyMd: '',
    });

    const index = await env.tx((tx) =>
      ensureActiveEmbeddingIndex(tx, { provider: 'mock', model: 'mock-empty-test', dimensions: 4 }),
    );

    // Replace chunks with 0 chunks and indexId
    const stored = await env.tx((tx) =>
      replaceArticleChunks(tx, {
        articleId: emptyArt.articleId,
        versionId: emptyArt.versionId,
        title: 'Empty Procedure Placeholder',
        chunks: [],
        embeddingIndexId: index.id,
      }),
    );
    expect(stored).toBe(true);

    // Manifest must record chunkCount = 0 and completedIndexIds including index.id
    const manifests = await env.database.db
      .select()
      .from(schema.kbVersionChunkManifest)
      .where(eq(schema.kbVersionChunkManifest.versionId, emptyArt.versionId));
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.chunkCount).toBe(0);
    expect(manifests[0]?.completedIndexIds).toContain(index.id);

    // articlesNeedingEmbedding must NOT report this empty article as needing embedding!
    const needing = await articlesNeedingEmbedding(env.database.db, index.id);
    const foundEmpty = needing.find((n) => n.articleId === emptyArt.articleId);
    expect(foundEmpty).toBeUndefined();

    // Activation succeeds without being blocked by empty article
    const canActivate = await env.tx((tx) => activateEmbeddingIndexIfComplete(tx, index.id));
    expect(canActivate).toBe(true);
  });

  it('joins published version and active index in search, never leaking V1 after V2 publish (ADR-033 §4)', async () => {
    // 1. Publish V1
    const created = await createAndPublish({
      title: 'Database Failover',
      bodyMd: 'Version 1: manual promotion via console.',
    });

    const index = await env.tx((tx) =>
      ensureActiveEmbeddingIndex(tx, { provider: 'mock', model: 'mock-search-4d', dimensions: 4 }),
    );

    await env.tx((tx) =>
      replaceArticleChunks(tx, {
        articleId: created.articleId,
        versionId: created.versionId,
        title: 'Database Failover',
        chunks: [
          {
            ordinal: 0,
            section: 'Database Failover',
            text: 'Version 1: manual promotion via console.',
            charStart: 0,
            charEnd: 41,
            embedding: [1, 0, 0, 0],
          },
        ],
        embeddingIndexId: index.id,
      }),
    );

    // Search finds V1 via hybrid
    const foundV1 = await searchKb(env.database.db, {
      query: 'manual promotion',
      audience: staff,
      limit: 5,
      embedding: { vector: [1, 0, 0, 0], indexId: index.id },
    });
    expect(foundV1.hits).toHaveLength(1);
    expect(foundV1.hits[0]?.snippet).toContain('Version 1');

    // 2. Publish V2
    const v2 = (
      await env.tx((tx) =>
        env.domain.kb.update(tx, env.ctx(author.actor), {
          articleId: created.articleId,
          canApprove: true,
          patch: { bodyMd: 'Version 2: automated failover via patroni.' },
        }),
      )
    ).value;

    await env.tx(async (tx) => {
      await env.domain.kb.transition(tx, env.ctx(author.actor), {
        articleId: created.articleId,
        to: 'in_review',
      });
      await env.domain.kb.publish(tx, env.ctx(lead.actor), {
        articleId: created.articleId,
        version: v2.version,
        audience: { visibility: 'internal', orgIds: [] },
      });
    });

    // Before V2 is embedded, store keyword chunks for V2 (without embedding)
    await env.tx((tx) =>
      replaceArticleChunks(tx, {
        articleId: created.articleId,
        versionId: v2.versionId,
        title: 'Database Failover',
        chunks: [
          {
            ordinal: 0,
            section: 'Database Failover',
            text: 'Version 2: automated failover via patroni.',
            charStart: 0,
            charEnd: 42,
            embedding: null,
          },
        ],
        embeddingIndexId: null,
      }),
    );

    // Search MUST NOT return V1 anymore!
    const searchAfterV2 = await searchKb(env.database.db, {
      query: 'manual promotion',
      audience: staff,
      limit: 5,
      embedding: { vector: [1, 0, 0, 0], indexId: index.id },
    });
    // V1 text is completely gone from published search results
    const foundOldV1 = searchAfterV2.hits.find((h) => h.snippet.includes('Version 1'));
    expect(foundOldV1).toBeUndefined();

    // V2 is searchable by keyword
    const searchV2Keyword = await searchKb(env.database.db, {
      query: 'patroni failover',
      audience: staff,
      limit: 5,
      embedding: { vector: [1, 0, 0, 0], indexId: index.id },
    });
    expect(searchV2Keyword.hits).toHaveLength(1);
    expect(searchV2Keyword.hits[0]?.snippet).toContain('Version 2');

    // 3. Now embed V2 with active index vector
    await env.tx((tx) =>
      replaceArticleChunks(tx, {
        articleId: created.articleId,
        versionId: v2.versionId,
        title: 'Database Failover',
        chunks: [
          {
            ordinal: 0,
            section: 'Database Failover',
            text: 'Version 2: automated failover via patroni.',
            charStart: 0,
            charEnd: 42,
            embedding: [0, 1, 0, 0],
          },
        ],
        embeddingIndexId: index.id,
      }),
    );

    // Search with V2 vector finds V2 via hybrid search
    const searchV2Hybrid = await searchKb(env.database.db, {
      query: 'automated failover',
      audience: staff,
      limit: 5,
      embedding: { vector: [0, 1, 0, 0], indexId: index.id },
    });
    expect(searchV2Hybrid.mode).toBe('hybrid');
    expect(searchV2Hybrid.hits).toHaveLength(1);
    expect(searchV2Hybrid.hits[0]?.snippet).toContain('Version 2');
  });

  it('computes deterministic chunkSetFingerprint', () => {
    const chunks = [
      { ordinal: 0, section: 'Intro', text: 'Text of intro' },
      { ordinal: 1, section: 'Body', text: 'Text of body' },
    ];
    const fp1 = computeChunkSetFingerprint(chunks, 'Article Title', 'v1');
    const fp2 = computeChunkSetFingerprint(chunks, 'Article Title', 'v1');
    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(64);

    // Changing title changes fingerprint
    const fp3 = computeChunkSetFingerprint(chunks, 'Different Title', 'v1');
    expect(fp3).not.toBe(fp1);

    // Changing text changes fingerprint
    const chunksChanged = [
      { ordinal: 0, section: 'Intro', text: 'Text of intro changed' },
      { ordinal: 1, section: 'Body', text: 'Text of body' },
    ];
    const fp4 = computeChunkSetFingerprint(chunksChanged, 'Article Title', 'v1');
    expect(fp4).not.toBe(fp1);
  });

  it('prevents different vector dimensions error in hybrid search when inactive index has different dimensions (C-1)', async () => {
    // 1. Setup active index (dim 4)
    const activeIndex = await env.tx((tx) =>
      ensureActiveEmbeddingIndex(tx, { provider: 'mock', model: 'mock-4d-c1', dimensions: 4 }),
    );

    // 2. Setup inactive index (dim 8)
    const inactiveIndex = await env.tx((tx) =>
      resolveWriteIndex(tx, { provider: 'mock', model: 'mock-8d-c1', dimensions: 8 }),
    );
    expect(inactiveIndex.active).toBe(false);

    // 3. Article A: published with active 4d vector
    const articleA = await createAndPublish({
      title: 'Active Article Architecture',
      bodyMd: 'Kubernetes cluster running redis and postgres.',
    });
    const [rowA] = await env.database.db
      .select({ publishedVersionId: schema.kbArticle.publishedVersionId })
      .from(schema.kbArticle)
      .where(eq(schema.kbArticle.id, articleA.articleId))
      .limit(1);
    const versionA = rowA?.publishedVersionId ?? '';

    await env.tx((tx) =>
      replaceArticleChunks(tx, {
        articleId: articleA.articleId,
        versionId: versionA,
        title: 'Active Article Architecture',
        chunks: [
          {
            ordinal: 0,
            section: 'Architecture',
            text: 'Kubernetes cluster running redis and postgres.',
            charStart: 0,
            charEnd: 46,
            embedding: [0.1, 0.2, 0.3, 0.4],
          },
        ],
        embeddingIndexId: activeIndex.id,
      }),
    );

    // 4. Article B: published, only embedded in the inactive 8d index
    const articleB = await createAndPublish({
      title: 'Inactive Target Article',
      bodyMd: 'Advanced telemetry processing pipeline in Golang.',
    });
    const [rowB] = await env.database.db
      .select({ publishedVersionId: schema.kbArticle.publishedVersionId })
      .from(schema.kbArticle)
      .where(eq(schema.kbArticle.id, articleB.articleId))
      .limit(1);
    const versionB = rowB?.publishedVersionId ?? '';

    await env.tx((tx) =>
      replaceArticleChunks(tx, {
        articleId: articleB.articleId,
        versionId: versionB,
        title: 'Inactive Target Article',
        chunks: [
          {
            ordinal: 0,
            section: 'Telemetry',
            text: 'Advanced telemetry processing pipeline in Golang.',
            charStart: 0,
            charEnd: 49,
            embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
          },
        ],
        embeddingIndexId: inactiveIndex.id,
      }),
    );

    // Verify C-1 requirement: inactive vector was NOT written to kb_chunk.embedding
    const chunkBRows = await env.database.db
      .select({
        embedding: schema.kbChunk.embedding,
        embeddingIndexId: schema.kbChunk.embeddingIndexId,
      })
      .from(schema.kbChunk)
      .where(eq(schema.kbChunk.articleId, articleB.articleId));

    expect(chunkBRows).toHaveLength(1);
    expect(chunkBRows[0]?.embedding).toBeNull();
    expect(chunkBRows[0]?.embeddingIndexId).toBeNull();

    // Verify 8d vector was stored in kb_chunk_embedding for the inactive index
    const chunkEmbeddingBRows = await env.database.db
      .select({ indexId: schema.kbChunkEmbedding.indexId })
      .from(schema.kbChunkEmbedding)
      .where(eq(schema.kbChunkEmbedding.indexId, inactiveIndex.id));
    expect(chunkEmbeddingBRows.length).toBeGreaterThanOrEqual(1);

    // 5. Query hybrid search with a 4d vector for the active index
    // Must NOT throw 500 / "ERROR: different vector dimensions"!
    const searchResult = await searchKb(env.database.db, {
      query: 'telemetry cluster',
      audience: staff,
      limit: 10,
      embedding: {
        vector: [0.1, 0.2, 0.3, 0.4],
        indexId: activeIndex.id,
      },
    });

    expect(searchResult.mode).toBe('hybrid');
    expect(searchResult.hits.length).toBeGreaterThanOrEqual(1);

    // Article A found via hybrid similarity, Article B found via keyword if query matched
    const foundA = searchResult.hits.find((h) => h.articleId === articleA.articleId);
    expect(foundA).toBeDefined();
    expect(foundA?.vectorRank).not.toBeNull();
  });
});
