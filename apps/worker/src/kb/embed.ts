import { AuditWriteError } from '@watchtower/ai';
import { schema, type Database } from '@watchtower/db';
import {
  articlesNeedingEmbedding,
  chunkMarkdown,
  dropArticleChunksIfNotLive,
  ensureActiveEmbeddingIndex,
  replaceArticleChunks,
  type Chunk,
  type ChunkOptions,
  type ChunkToStore,
} from '@watchtower/domain';
import { and, eq } from 'drizzle-orm';

import type { AiRuntime } from '../ai/runtime.js';
import type { WorkerLogger } from '../logger.js';

export interface KbDeps {
  readonly database: Database;
  /** Absent when the provider is not wired: chunks are stored for keyword search, without vectors. */
  readonly ai: AiRuntime | undefined;
  readonly logger: Pick<WorkerLogger, 'info' | 'warn'>;
  readonly chunking: ChunkOptions;
}

/** Texts per embedding call `[ASSUMED]`: under the batch limits of the common embedding APIs. */
export const EMBED_BATCH = 32;

export type EmbedStatus =
  /** Chunks stored with vectors from the active embedding index. */
  | 'embedded'
  /** Chunks stored for keyword search; no vectors (provider off, kill switch, budget). */
  | 'keyword_only'
  /** The article is gone, or this version is no longer the live one: nothing was written. */
  | 'stale'
  /** The article is not published: its chunks were removed. */
  | 'dropped';

export interface EmbedResult {
  readonly status: EmbedStatus;
  readonly chunks: number;
  /** Why vectors are missing when `status` is `keyword_only`. */
  readonly reason?: string;
}

/** What the embedding model reads for a chunk: where it sits, then the passage itself. */
export function embeddingInput(title: string, chunk: Chunk): string {
  return chunk.section === ''
    ? `${title}\n\n${chunk.text}`
    : `${title}\n${chunk.section}\n\n${chunk.text}`;
}

/**
 * Builds the chunks of the live version of one article (T-107b): chunks the body, stores them so
 * keyword search works at once, embeds them through the audited embedder (guard, redaction, `ai_run`
 * metering), and stores them again with their vectors.
 *
 * - `versionId` is the version the job was queued for. When it is no longer the live one nothing is
 *   written (a newer job exists). When the article is not published, its chunks are removed.
 * - If the embedder is absent, refuses (kill switch, budget) or the article has no text, the chunks
 *   stay keyword-only; `reembed_all` fills the vectors in later.
 * - A provider failure throws after the keyword-only chunks are stored, so BullMQ retries the job.
 */
export async function embedArticle(
  deps: KbDeps,
  articleId: string,
  versionId: string,
): Promise<EmbedResult> {
  const db = deps.database.db;
  const [row] = await db
    .select({
      status: schema.kbArticle.status,
      publishedVersionId: schema.kbArticle.publishedVersionId,
    })
    .from(schema.kbArticle)
    .where(eq(schema.kbArticle.id, articleId))
    .limit(1);
  if (row === undefined) return { status: 'stale', chunks: 0 };
  if (row.status !== 'published') {
    const dropped = await db.transaction((tx) => dropArticleChunksIfNotLive(tx, articleId));
    return { status: dropped ? 'dropped' : 'stale', chunks: 0 };
  }
  if (row.publishedVersionId !== versionId) return { status: 'stale', chunks: 0 };

  const [version] = await db
    .select({ title: schema.kbArticleVersion.title, bodyMd: schema.kbArticleVersion.bodyMd })
    .from(schema.kbArticleVersion)
    .where(
      and(
        eq(schema.kbArticleVersion.id, versionId),
        eq(schema.kbArticleVersion.articleId, articleId),
      ),
    )
    .limit(1);
  if (version === undefined) return { status: 'stale', chunks: 0 };

  const chunks = chunkMarkdown(version.bodyMd, deps.chunking);
  const keywordOnly: ChunkToStore[] = chunks.map((chunk) => ({ ...chunk, embedding: null }));
  const stored = await db.transaction((tx) =>
    replaceArticleChunks(tx, { articleId, versionId, chunks: keywordOnly, embeddingIndexId: null }),
  );
  if (!stored) return { status: 'stale', chunks: 0 };
  if (chunks.length === 0) return { status: 'embedded', chunks: 0 };
  if (deps.ai === undefined) {
    return { status: 'keyword_only', chunks: chunks.length, reason: 'provider_unavailable' };
  }

  const vectors: number[][] = [];
  let spec:
    { provider: 'mock' | 'anthropic' | 'vertex'; model: string; dimensions: number } | undefined;
  for (let at = 0; at < chunks.length; at += EMBED_BATCH) {
    const batch = chunks.slice(at, at + EMBED_BATCH);
    const outcome = await deps.ai.embedder.embed({
      texts: batch.map((chunk) => embeddingInput(version.title, chunk)),
      scope: `kb:${articleId}`,
      action: 'kb_index',
    });
    if (outcome.status === 'skipped') {
      deps.logger.warn({ articleId, reason: outcome.reason }, 'knowledge base embedding skipped');
      return { status: 'keyword_only', chunks: chunks.length, reason: outcome.reason };
    }
    vectors.push(...outcome.embeddings);
    spec = { provider: outcome.provider, model: outcome.model, dimensions: outcome.dimensions };
  }
  if (spec === undefined) return { status: 'keyword_only', chunks: chunks.length };
  const indexSpec = spec;

  const done = await db.transaction(async (tx) => {
    const index = await ensureActiveEmbeddingIndex(tx, indexSpec);
    const withVectors: ChunkToStore[] = chunks.map((chunk, at) => ({
      ...chunk,
      embedding: vectors[at] ?? null,
    }));
    return replaceArticleChunks(tx, {
      articleId,
      versionId,
      chunks: withVectors,
      embeddingIndexId: index.id,
    });
  });
  return done ? { status: 'embedded', chunks: chunks.length } : { status: 'stale', chunks: 0 };
}

export interface ReembedResult {
  readonly queued: number;
  readonly embedded: number;
  readonly failed: number;
}

/**
 * Brings every published article up to the embedding model in settings: makes that model the active
 * index (a different model than before switches it, in one transaction), then embeds each article
 * whose chunks are missing, have no vector or have a vector from another index. One article's
 * failure does not stop the others; the job fails at the end if any failed, so it is retried.
 */
export async function reembedAll(deps: KbDeps): Promise<ReembedResult> {
  if (deps.ai === undefined) return { queued: 0, embedded: 0, failed: 0 };
  const { embedding } = await deps.ai.settings.load();
  const index = await deps.database.db.transaction((tx) =>
    ensureActiveEmbeddingIndex(tx, embedding),
  );
  if (index.activated) {
    deps.logger.info(
      { model: index.model, dimensions: index.dimensions },
      'embedding index changed',
    );
  }
  const targets = await articlesNeedingEmbedding(deps.database.db, index.id);
  let embedded = 0;
  let failed = 0;
  for (const target of targets) {
    try {
      const result = await embedArticle(deps, target.articleId, target.versionId);
      if (result.status === 'embedded') embedded += 1;
    } catch (error) {
      // A row that could not be audited must stop everything: the metering is not optional (N4).
      if (error instanceof AuditWriteError) throw error;
      failed += 1;
      deps.logger.warn({ articleId: target.articleId }, 'knowledge base re-embedding failed');
    }
  }
  return { queued: targets.length, embedded, failed };
}
