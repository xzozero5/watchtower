import { schema } from '@watchtower/db';
import { and, eq, ne, sql } from 'drizzle-orm';

import type { DbTransaction, ReadExecutor } from '../types.js';
import type { Chunk } from './chunker.js';

export interface EmbeddingIndexSpec {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
}

export interface EmbeddingIndexRef {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
}

/** The index query vectors must come from; undefined before anything was ever embedded. */
export async function readActiveEmbeddingIndex(
  executor: ReadExecutor,
): Promise<EmbeddingIndexRef | undefined> {
  const [row] = await executor
    .select({
      id: schema.kbEmbeddingIndex.id,
      provider: schema.kbEmbeddingIndex.provider,
      model: schema.kbEmbeddingIndex.model,
      dimensions: schema.kbEmbeddingIndex.dimensions,
    })
    .from(schema.kbEmbeddingIndex)
    .where(eq(schema.kbEmbeddingIndex.isActive, true))
    .limit(1);
  return row;
}

/**
 * Makes the embedding model in settings the active index, creating its row on first use. When the
 * model changed, the previous index is deactivated in the same transaction; its vectors stay on
 * their chunks (they are simply not searched) until `reembed_all` replaces them. Calling it again
 * with the same model changes nothing.
 */
export async function ensureActiveEmbeddingIndex(
  tx: DbTransaction,
  spec: EmbeddingIndexSpec,
): Promise<EmbeddingIndexRef & { readonly activated: boolean }> {
  const same = and(
    eq(schema.kbEmbeddingIndex.provider, spec.provider),
    eq(schema.kbEmbeddingIndex.model, spec.model),
    eq(schema.kbEmbeddingIndex.dimensions, spec.dimensions),
  );
  await tx
    .insert(schema.kbEmbeddingIndex)
    .values({ provider: spec.provider, model: spec.model, dimensions: spec.dimensions })
    .onConflictDoNothing();
  const [row] = await tx.select().from(schema.kbEmbeddingIndex).where(same).limit(1);
  if (row === undefined) throw new Error('kb_embedding_index row vanished');
  let activated = false;
  if (!row.isActive) {
    // Deactivate first: at most one index may be active.
    await tx
      .update(schema.kbEmbeddingIndex)
      .set({ isActive: false })
      .where(
        and(eq(schema.kbEmbeddingIndex.isActive, true), ne(schema.kbEmbeddingIndex.id, row.id)),
      );
    await tx
      .update(schema.kbEmbeddingIndex)
      .set({ isActive: true, activatedAt: new Date() })
      .where(eq(schema.kbEmbeddingIndex.id, row.id));
    activated = true;
  }
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    dimensions: row.dimensions,
    activated,
  };
}

export interface WriteIndexRef extends EmbeddingIndexRef {
  /** True when this is the index search reads; false for a new one that is still being filled. */
  readonly active: boolean;
}

/**
 * The index new vectors are written under (T-431, ADR-030). With no active index yet, the spec
 * becomes active at once (nothing is searched by vector, so nothing can degrade). With the same
 * model already active it is that one. With a different model the new index is created inactive
 * and filled first. A chunk holds one vector (`embedding_index_id`), so an article written under
 * the new index is no longer found by vector under the active one: it is keyword-only until
 * `activateEmbeddingIndexIfComplete` switches the new index in one transaction (T-435 C-8).
 */
export async function resolveWriteIndex(
  tx: DbTransaction,
  spec: EmbeddingIndexSpec,
): Promise<WriteIndexRef> {
  const active = await readActiveEmbeddingIndex(tx);
  if (active === undefined) {
    const made = await ensureActiveEmbeddingIndex(tx, spec);
    return { ...made, active: true };
  }
  if (
    active.provider === spec.provider &&
    active.model === spec.model &&
    active.dimensions === spec.dimensions
  ) {
    return { ...active, active: true };
  }
  await tx
    .insert(schema.kbEmbeddingIndex)
    .values({ provider: spec.provider, model: spec.model, dimensions: spec.dimensions })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(schema.kbEmbeddingIndex)
    .where(
      and(
        eq(schema.kbEmbeddingIndex.provider, spec.provider),
        eq(schema.kbEmbeddingIndex.model, spec.model),
        eq(schema.kbEmbeddingIndex.dimensions, spec.dimensions),
      ),
    )
    .limit(1);
  if (row === undefined) throw new Error('kb_embedding_index row vanished');
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    dimensions: row.dimensions,
    active: row.isActive,
  };
}

/**
 * Makes `indexId` the active index, but only when every published article is embedded with it
 * (checked inside the transaction, so an article published a moment ago still counts). Returns
 * whether it is active afterwards. The previous index is deactivated first, so at most one index
 * is ever active.
 */
export async function activateEmbeddingIndexIfComplete(
  tx: DbTransaction,
  indexId: string,
): Promise<boolean> {
  // Serialize two switches; the partial unique index would fail the second one anyway.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('kb_embedding_index_switch'))`);
  const [row] = await tx
    .select({ isActive: schema.kbEmbeddingIndex.isActive })
    .from(schema.kbEmbeddingIndex)
    .where(eq(schema.kbEmbeddingIndex.id, indexId))
    .limit(1);
  if (row === undefined) return false;
  if (row.isActive) return true;
  const pending = await articlesNeedingEmbedding(tx, indexId);
  if (pending.length > 0) return false;
  await tx
    .update(schema.kbEmbeddingIndex)
    .set({ isActive: false })
    .where(
      and(eq(schema.kbEmbeddingIndex.isActive, true), ne(schema.kbEmbeddingIndex.id, indexId)),
    );
  await tx
    .update(schema.kbEmbeddingIndex)
    .set({ isActive: true, activatedAt: new Date() })
    .where(eq(schema.kbEmbeddingIndex.id, indexId));
  return true;
}

export interface ChunkToStore extends Chunk {
  /** Null when no embedding could be made; the chunk is still found by keyword search. */
  readonly embedding: readonly number[] | null;
}

export interface ReplaceChunksInput {
  readonly articleId: string;
  readonly versionId: string;
  readonly chunks: readonly ChunkToStore[];
  /** The index the embeddings come from; null when none of the chunks has one. */
  readonly embeddingIndexId: string | null;
}

const BATCH = 100;

/**
 * Stores the chunks of the live version of an article, replacing every earlier chunk of the
 * article. Returns `false`, writing nothing, when the version is not live any more (published
 * again meanwhile, or deprecated): the job that produced these chunks is stale. The article row is
 * locked for the write, so a publish and a stale job cannot interleave.
 */
export async function replaceArticleChunks(
  tx: DbTransaction,
  input: ReplaceChunksInput,
): Promise<boolean> {
  const [article] = await tx
    .select({
      status: schema.kbArticle.status,
      publishedVersionId: schema.kbArticle.publishedVersionId,
    })
    .from(schema.kbArticle)
    .where(eq(schema.kbArticle.id, input.articleId))
    .for('update')
    .limit(1);
  if (
    article === undefined ||
    article.status !== 'published' ||
    article.publishedVersionId !== input.versionId
  ) {
    return false;
  }
  await tx.delete(schema.kbChunk).where(eq(schema.kbChunk.articleId, input.articleId));
  for (let at = 0; at < input.chunks.length; at += BATCH) {
    await tx.insert(schema.kbChunk).values(
      input.chunks.slice(at, at + BATCH).map((chunk) => ({
        articleId: input.articleId,
        versionId: input.versionId,
        ordinal: chunk.ordinal,
        section: chunk.section,
        text: chunk.text,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
        embedding: chunk.embedding === null ? null : [...chunk.embedding],
        embeddingIndexId: chunk.embedding === null ? null : input.embeddingIndexId,
      })),
    );
  }
  return true;
}

/** Removes every chunk of an article that is not live (deprecated). Idempotent. */
export async function dropArticleChunksIfNotLive(
  tx: DbTransaction,
  articleId: string,
): Promise<boolean> {
  const [article] = await tx
    .select({ status: schema.kbArticle.status })
    .from(schema.kbArticle)
    .where(eq(schema.kbArticle.id, articleId))
    .for('update')
    .limit(1);
  if (article === undefined || article.status === 'published') return false;
  await tx.delete(schema.kbChunk).where(eq(schema.kbChunk.articleId, articleId));
  return true;
}

export interface ReembedTarget {
  readonly articleId: string;
  readonly versionId: string;
}

/**
 * Published articles whose live chunks are missing, or have no vector, or have a vector from
 * another index than the active one. `reembed_all` queues each of them again.
 */
export async function articlesNeedingEmbedding(
  executor: ReadExecutor,
  activeIndexId: string,
): Promise<ReembedTarget[]> {
  const rows = await executor
    .select({
      articleId: schema.kbArticle.id,
      versionId: schema.kbArticle.publishedVersionId,
    })
    .from(schema.kbArticle)
    .where(
      and(
        eq(schema.kbArticle.status, 'published'),
        sql`${schema.kbArticle.publishedVersionId} IS NOT NULL`,
        sql`(
          NOT EXISTS (SELECT 1 FROM kb_chunk c WHERE c.article_id = ${schema.kbArticle.id})
          OR EXISTS (
            SELECT 1 FROM kb_chunk c
             WHERE c.article_id = ${schema.kbArticle.id}
               AND (c.embedding_index_id IS NULL OR c.embedding_index_id <> ${activeIndexId}::uuid)
          )
        )`,
      ),
    );
  const targets: ReembedTarget[] = [];
  for (const row of rows) {
    if (row.versionId !== null)
      targets.push({ articleId: row.articleId, versionId: row.versionId });
  }
  return targets;
}
