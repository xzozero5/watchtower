import { createHash } from 'node:crypto';

import { schema } from '@watchtower/db';
import { KB_AUDIT_ACTIONS } from '@watchtower/shared';
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

export interface AcquireReembedLeaseInput {
  readonly targetIndexId: string;
  readonly workerId: string;
  readonly leaseDurationSeconds?: number;
}

export interface AcquireReembedLeaseResult {
  readonly acquired: boolean;
  readonly leaseToken?: string;
  readonly reason?: string;
}

/**
 * Acquires a durable lease for re-embedding (ADR-033 §5).
 * Enforces single-worker concurrency via advisory lock and DB clock `leased_until`.
 */
export async function acquireReembedLease(
  tx: DbTransaction,
  input: AcquireReembedLeaseInput,
): Promise<AcquireReembedLeaseResult> {
  const durationSeconds = input.leaseDurationSeconds ?? 300;

  // Serialize lease acquisition
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('kb_reembed_lease_singleton'))`);

  const [existing] = await tx
    .select({
      id: schema.kbReembedLease.id,
      leaseToken: schema.kbReembedLease.leaseToken,
      targetIndexId: schema.kbReembedLease.targetIndexId,
      workerId: schema.kbReembedLease.workerId,
      leasedUntil: schema.kbReembedLease.leasedUntil,
      completedAt: schema.kbReembedLease.completedAt,
    })
    .from(schema.kbReembedLease)
    .where(eq(schema.kbReembedLease.id, 'singleton'))
    .limit(1);

  if (existing === undefined) {
    const [inserted] = await tx
      .insert(schema.kbReembedLease)
      .values({
        id: 'singleton',
        leaseToken: sql`gen_random_uuid()`,
        targetIndexId: input.targetIndexId,
        workerId: input.workerId,
        leasedAt: sql`clock_timestamp()`,
        leasedUntil: sql`clock_timestamp() + (${durationSeconds} * interval '1 second')`,
        renewedAt: sql`clock_timestamp()`,
        completedAt: null,
      })
      .returning({ leaseToken: schema.kbReembedLease.leaseToken });
    return { acquired: true, leaseToken: inserted?.leaseToken };
  }

  // Active check against DB clock
  const isHeld = await tx.execute<{ is_active: boolean }>(sql`
    SELECT (completed_at IS NULL AND leased_until >= clock_timestamp()) AS is_active
      FROM kb_reembed_lease
     WHERE id = 'singleton'
  `);
  if (isHeld.rows[0]?.is_active) {
    return { acquired: false, reason: 'already_leased' };
  }

  const [updated] = await tx
    .update(schema.kbReembedLease)
    .set({
      leaseToken: sql`gen_random_uuid()`,
      targetIndexId: input.targetIndexId,
      workerId: input.workerId,
      leasedAt: sql`clock_timestamp()`,
      leasedUntil: sql`clock_timestamp() + (${durationSeconds} * interval '1 second')`,
      renewedAt: sql`clock_timestamp()`,
      completedAt: null,
    })
    .where(eq(schema.kbReembedLease.id, 'singleton'))
    .returning({ leaseToken: schema.kbReembedLease.leaseToken });

  return { acquired: true, leaseToken: updated?.leaseToken };
}

export interface RenewReembedLeaseInput {
  readonly leaseToken: string;
  readonly extendSeconds?: number;
}

export async function renewReembedLease(
  tx: DbTransaction,
  input: RenewReembedLeaseInput,
): Promise<boolean> {
  const extendSeconds = input.extendSeconds ?? 300;
  const result = await tx.execute<{ count: number }>(sql`
    UPDATE kb_reembed_lease
       SET leased_until = clock_timestamp() + (${extendSeconds} * interval '1 second'),
           renewed_at = clock_timestamp()
     WHERE id = 'singleton'
       AND lease_token = ${input.leaseToken}::uuid
       AND leased_until >= clock_timestamp()
       AND completed_at IS NULL
    RETURNING 1 AS count
  `);
  return result.rows.length > 0;
}

export interface ReleaseReembedLeaseInput {
  readonly leaseToken: string;
}

export async function releaseReembedLease(
  tx: DbTransaction,
  input: ReleaseReembedLeaseInput,
): Promise<boolean> {
  const result = await tx.execute<{ count: number }>(sql`
    UPDATE kb_reembed_lease
       SET completed_at = clock_timestamp()
     WHERE id = 'singleton'
       AND lease_token = ${input.leaseToken}::uuid
    RETURNING 1 AS count
  `);
  return result.rows.length > 0;
}

export interface ActivateIndexOptions {
  readonly leaseToken?: string;
  readonly actorId?: string;
}

/**
 * Makes `indexId` the active index, but only when every published article is embedded with it
 * (checked inside the transaction, so an article published a moment ago still counts). Returns
 * whether it is active afterwards. The previous index is deactivated first, so at most one index
 * is ever active.
 *
 * Enforces ADR-033 §5 fencing (rejects if leaseToken expired or usurped), ADR-033 §6 exclusive
 * advisory lock, and audit logging.
 */
export async function activateEmbeddingIndexIfComplete(
  tx: DbTransaction,
  indexId: string,
  options?: ActivateIndexOptions,
): Promise<boolean> {
  // ADR-033 §6: Exclusive advisory lock before row lock / switch
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('kb_article_publish_and_switch'))`);

  if (options?.leaseToken !== undefined) {
    const leaseCheck = await tx.execute<{ is_valid: boolean }>(sql`
      SELECT (target_index_id = ${indexId}::uuid AND completed_at IS NULL AND leased_until >= clock_timestamp()) AS is_valid
        FROM kb_reembed_lease
       WHERE id = 'singleton'
         AND lease_token = ${options.leaseToken}::uuid
    `);
    if (!leaseCheck.rows[0]?.is_valid) {
      return false; // Stale or usurped worker is fenced!
    }
  }

  const [row] = await tx
    .select({
      isActive: schema.kbEmbeddingIndex.isActive,
      provider: schema.kbEmbeddingIndex.provider,
      model: schema.kbEmbeddingIndex.model,
      dimensions: schema.kbEmbeddingIndex.dimensions,
    })
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
    .set({ isActive: true, activatedAt: sql`clock_timestamp()` })
    .where(eq(schema.kbEmbeddingIndex.id, indexId));

  // Sync newly active embeddings to kb_chunk for backward-compatibility dual-read
  await tx.execute(sql`
    UPDATE kb_chunk c
       SET embedding = ce.embedding,
           embedding_index_id = ce.index_id
      FROM kb_chunk_embedding ce
     WHERE ce.chunk_id = c.id
       AND ce.index_id = ${indexId}::uuid
  `);

  if (options?.leaseToken !== undefined) {
    await tx
      .update(schema.kbReembedLease)
      .set({ completedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(schema.kbReembedLease.id, 'singleton'),
          eq(schema.kbReembedLease.leaseToken, options.leaseToken),
        ),
      );
  }

  // Audit log for index activation (N4)
  await tx.insert(schema.auditLog).values({
    actorType: options?.actorId ? 'user' : 'system',
    actorId: options?.actorId ?? null,
    action: KB_AUDIT_ACTIONS.kbEmbeddingIndexActivate,
    outcome: 'success',
    targetType: 'kb_embedding_index',
    targetId: indexId,
    metadata: {
      provider: row.provider,
      model: row.model,
      dimensions: row.dimensions,
    },
  });

  return true;
}

export interface ChunkToStore extends Chunk {
  /** Null when no embedding could be made; the chunk is still found by keyword search. */
  readonly embedding: readonly number[] | null;
}

export interface ReplaceChunksInput {
  readonly articleId: string;
  readonly versionId: string;
  readonly title?: string;
  readonly chunks: readonly ChunkToStore[];
  readonly chunkSetFingerprint?: string;
  /** The index the embeddings come from; null when none of the chunks has one. */
  readonly embeddingIndexId: string | null;
  /** Optional secondary index for dual embedding during rebuild (ADR-033 §4) */
  readonly secondaryEmbeddingIndexId?: string | null;
  readonly secondaryChunks?: readonly ChunkToStore[] | null;
}

const BATCH = 100;

/**
 * Computes a deterministic SHA-256 fingerprint from the chunker version, title and chunk list
 * (ADR-033 §2).
 */
export function computeChunkSetFingerprint(
  chunks: readonly Pick<Chunk, 'ordinal' | 'section' | 'text'>[],
  title = '',
  chunkerVersion = 'v1',
): string {
  const hash = createHash('sha256');
  hash.update(chunkerVersion).update('\u0000');
  hash.update(title).update('\u0000');
  for (const chunk of chunks) {
    hash.update(String(chunk.ordinal)).update('\u0000');
    hash.update(chunk.section).update('\u0000');
    hash.update(chunk.text).update('\u0000');
  }
  return hash.digest('hex');
}

/**
 * Stores the chunks of the live version of an article and their vectors in kb_chunk_embedding.
 * - Idempotent and multi-index safe (ADR-033 §2):
 *   If chunks with the same (versionId, chunkSetFingerprint) exist, kb_chunk rows are PRESERVED
 *   (retaining their immutable IDs) and new vectors are upserted into kb_chunk_embedding.
 * - Supports empty articles (0 chunks) by recording completion in kb_version_chunk_manifest.
 * - Returns `false` without writing when the version is no longer live (stale).
 */
export async function replaceArticleChunks(
  tx: DbTransaction,
  input: ReplaceChunksInput,
): Promise<boolean> {
  // ADR-033 §6: Shared advisory lock before row lock
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtext('kb_article_publish_and_switch'))`,
  );
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

  const fingerprint =
    input.chunkSetFingerprint ?? computeChunkSetFingerprint(input.chunks, input.title ?? '');

  const [primaryIdx] = input.embeddingIndexId
    ? await tx
        .select({ isActive: schema.kbEmbeddingIndex.isActive })
        .from(schema.kbEmbeddingIndex)
        .where(eq(schema.kbEmbeddingIndex.id, input.embeddingIndexId))
        .limit(1)
    : [];

  const [secondaryIdx] = input.secondaryEmbeddingIndexId
    ? await tx
        .select({ isActive: schema.kbEmbeddingIndex.isActive })
        .from(schema.kbEmbeddingIndex)
        .where(eq(schema.kbEmbeddingIndex.id, input.secondaryEmbeddingIndexId))
        .limit(1)
    : [];

  // Handle empty articles (0 chunks)
  if (input.chunks.length === 0) {
    await tx.delete(schema.kbChunk).where(eq(schema.kbChunk.articleId, input.articleId));
    const initialCompleted = [
      ...(input.embeddingIndexId ? [input.embeddingIndexId] : []),
      ...(input.secondaryEmbeddingIndexId ? [input.secondaryEmbeddingIndexId] : []),
    ];
    await tx
      .insert(schema.kbVersionChunkManifest)
      .values({
        articleId: input.articleId,
        versionId: input.versionId,
        chunkSetFingerprint: fingerprint,
        chunkCount: 0,
        completedIndexIds: initialCompleted,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          schema.kbVersionChunkManifest.versionId,
          schema.kbVersionChunkManifest.chunkSetFingerprint,
        ],
        set: {
          chunkCount: 0,
          updatedAt: new Date(),
          ...(input.embeddingIndexId
            ? {
                completedIndexIds: sql`array_append(array_remove(${schema.kbVersionChunkManifest.completedIndexIds}, ${input.embeddingIndexId}::uuid), ${input.embeddingIndexId}::uuid)`,
              }
            : {}),
        },
      });

    if (input.secondaryEmbeddingIndexId) {
      await tx
        .update(schema.kbVersionChunkManifest)
        .set({
          completedIndexIds: sql`array_append(array_remove(${schema.kbVersionChunkManifest.completedIndexIds}, ${input.secondaryEmbeddingIndexId}::uuid), ${input.secondaryEmbeddingIndexId}::uuid)`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.kbVersionChunkManifest.versionId, input.versionId),
            eq(schema.kbVersionChunkManifest.chunkSetFingerprint, fingerprint),
          ),
        );
    }
    return true;
  }

  // Check if existing chunks for this (versionId, fingerprint) exist
  const existingChunks = await tx
    .select({ id: schema.kbChunk.id, ordinal: schema.kbChunk.ordinal })
    .from(schema.kbChunk)
    .where(
      and(
        eq(schema.kbChunk.versionId, input.versionId),
        eq(schema.kbChunk.chunkSetFingerprint, fingerprint),
      ),
    )
    .orderBy(schema.kbChunk.ordinal);

  if (existingChunks.length === input.chunks.length) {
    if (input.embeddingIndexId === null) {
      // Caller requested keyword-only chunks: clear embeddings on kb_chunk
      await tx
        .update(schema.kbChunk)
        .set({
          embedding: null,
          embeddingIndexId: null,
        })
        .where(eq(schema.kbChunk.articleId, input.articleId));
      return true;
    }

    // Chunks already present: do NOT reinsert kb_chunk; upsert vectors into kb_chunk_embedding
    for (const chunk of input.chunks) {
      if (chunk.embedding !== null) {
        const chunkId = existingChunks[chunk.ordinal]?.id;
        if (chunkId !== undefined) {
          await tx
            .insert(schema.kbChunkEmbedding)
            .values({
              chunkId,
              indexId: input.embeddingIndexId,
              embedding: [...chunk.embedding],
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [schema.kbChunkEmbedding.chunkId, schema.kbChunkEmbedding.indexId],
              set: {
                embedding: [...chunk.embedding],
                updatedAt: new Date(),
              },
            });

          // Backward compatibility dual-write to kb_chunk:
          // Write to kb_chunk ONLY when this index is currently active! Never write inactive index vectors.
          if (primaryIdx?.isActive === true) {
            await tx
              .update(schema.kbChunk)
              .set({
                embedding: [...chunk.embedding],
                embeddingIndexId: input.embeddingIndexId,
              })
              .where(eq(schema.kbChunk.id, chunkId));
          }
        }
      }
    }

    // Record completion in manifest
    await tx
      .insert(schema.kbVersionChunkManifest)
      .values({
        articleId: input.articleId,
        versionId: input.versionId,
        chunkSetFingerprint: fingerprint,
        chunkCount: input.chunks.length,
        completedIndexIds: [input.embeddingIndexId],
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          schema.kbVersionChunkManifest.versionId,
          schema.kbVersionChunkManifest.chunkSetFingerprint,
        ],
        set: {
          chunkCount: input.chunks.length,
          updatedAt: new Date(),
          completedIndexIds: sql`array_append(array_remove(${schema.kbVersionChunkManifest.completedIndexIds}, ${input.embeddingIndexId}::uuid), ${input.embeddingIndexId}::uuid)`,
        },
      });

    if (
      input.secondaryEmbeddingIndexId &&
      input.secondaryChunks &&
      input.secondaryChunks.length > 0
    ) {
      const secondaryList = input.secondaryChunks;
      for (const chunk of secondaryList) {
        if (chunk.embedding !== null) {
          const chunkId = existingChunks[chunk.ordinal]?.id;
          if (chunkId !== undefined) {
            await tx
              .insert(schema.kbChunkEmbedding)
              .values({
                chunkId,
                indexId: input.secondaryEmbeddingIndexId,
                embedding: [...chunk.embedding],
                updatedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: [schema.kbChunkEmbedding.chunkId, schema.kbChunkEmbedding.indexId],
                set: {
                  embedding: [...chunk.embedding],
                  updatedAt: new Date(),
                },
              });

            // Backward compatibility dual-write to kb_chunk:
            // Write to kb_chunk ONLY when secondary index is currently active!
            if (secondaryIdx?.isActive === true) {
              await tx
                .update(schema.kbChunk)
                .set({
                  embedding: [...chunk.embedding],
                  embeddingIndexId: input.secondaryEmbeddingIndexId,
                })
                .where(eq(schema.kbChunk.id, chunkId));
            }
          }
        }
      }
      await tx
        .insert(schema.kbVersionChunkManifest)
        .values({
          articleId: input.articleId,
          versionId: input.versionId,
          chunkSetFingerprint: fingerprint,
          chunkCount: input.chunks.length,
          completedIndexIds: [input.secondaryEmbeddingIndexId],
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            schema.kbVersionChunkManifest.versionId,
            schema.kbVersionChunkManifest.chunkSetFingerprint,
          ],
          set: {
            updatedAt: new Date(),
            completedIndexIds: sql`array_append(array_remove(${schema.kbVersionChunkManifest.completedIndexIds}, ${input.secondaryEmbeddingIndexId}::uuid), ${input.secondaryEmbeddingIndexId}::uuid)`,
          },
        });
    }

    return true;
  }

  // Chunks missing or re-chunked with new fingerprint:
  // Clean up any stale chunks of other versions or previous fingerprint of this version
  await tx.delete(schema.kbChunk).where(eq(schema.kbChunk.articleId, input.articleId));
  await tx
    .delete(schema.kbVersionChunkManifest)
    .where(
      and(
        eq(schema.kbVersionChunkManifest.articleId, input.articleId),
        sql`(${schema.kbVersionChunkManifest.versionId} != ${input.versionId}::uuid OR ${schema.kbVersionChunkManifest.chunkSetFingerprint} != ${fingerprint})`,
      ),
    );

  const insertedChunkIds: { id: string; ordinal: number }[] = [];
  for (let at = 0; at < input.chunks.length; at += BATCH) {
    const batch = input.chunks.slice(at, at + BATCH);
    const rows = await tx
      .insert(schema.kbChunk)
      .values(
        batch.map((chunk) => {
          let chunkEmbedding: number[] | null = null;
          let chunkEmbeddingIndexId: string | null = null;
          const secChunk =
            secondaryIdx?.isActive === true && input.secondaryChunks
              ? input.secondaryChunks[chunk.ordinal]
              : undefined;
          if (primaryIdx?.isActive === true && chunk.embedding !== null) {
            chunkEmbedding = [...chunk.embedding];
            chunkEmbeddingIndexId = input.embeddingIndexId;
          } else if (secChunk?.embedding !== null && secChunk?.embedding !== undefined) {
            chunkEmbedding = [...secChunk.embedding];
            chunkEmbeddingIndexId = input.secondaryEmbeddingIndexId ?? null;
          }

          return {
            articleId: input.articleId,
            versionId: input.versionId,
            chunkSetFingerprint: fingerprint,
            ordinal: chunk.ordinal,
            section: chunk.section,
            text: chunk.text,
            charStart: chunk.charStart,
            charEnd: chunk.charEnd,
            embedding: chunkEmbedding,
            embeddingIndexId: chunkEmbeddingIndexId,
          };
        }),
      )
      .returning({ id: schema.kbChunk.id, ordinal: schema.kbChunk.ordinal });
    insertedChunkIds.push(...rows);
  }

  // Populate kb_chunk_embedding if index and vectors provided
  if (input.embeddingIndexId !== null) {
    const embeddingsToInsert: { chunkId: string; indexId: string; embedding: number[] }[] = [];
    for (const row of insertedChunkIds) {
      const chunk = input.chunks[row.ordinal];
      if (chunk?.embedding !== null && chunk?.embedding !== undefined) {
        embeddingsToInsert.push({
          chunkId: row.id,
          indexId: input.embeddingIndexId,
          embedding: [...chunk.embedding],
        });
      }
    }

    if (embeddingsToInsert.length > 0) {
      await tx
        .insert(schema.kbChunkEmbedding)
        .values(embeddingsToInsert)
        .onConflictDoUpdate({
          target: [schema.kbChunkEmbedding.chunkId, schema.kbChunkEmbedding.indexId],
          set: {
            embedding: sql`excluded.embedding`,
            updatedAt: new Date(),
          },
        });
    }

    await tx
      .insert(schema.kbVersionChunkManifest)
      .values({
        articleId: input.articleId,
        versionId: input.versionId,
        chunkSetFingerprint: fingerprint,
        chunkCount: input.chunks.length,
        completedIndexIds: [input.embeddingIndexId],
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          schema.kbVersionChunkManifest.versionId,
          schema.kbVersionChunkManifest.chunkSetFingerprint,
        ],
        set: {
          chunkCount: input.chunks.length,
          updatedAt: new Date(),
          completedIndexIds: sql`array_append(array_remove(${schema.kbVersionChunkManifest.completedIndexIds}, ${input.embeddingIndexId}::uuid), ${input.embeddingIndexId}::uuid)`,
        },
      });
    if (
      input.secondaryEmbeddingIndexId &&
      input.secondaryChunks &&
      input.secondaryChunks.length > 0
    ) {
      const secondaryList = input.secondaryChunks;
      const secondaryToInsert: { chunkId: string; indexId: string; embedding: number[] }[] = [];
      for (const row of insertedChunkIds) {
        const chunk = secondaryList[row.ordinal];
        if (chunk?.embedding !== null && chunk?.embedding !== undefined) {
          secondaryToInsert.push({
            chunkId: row.id,
            indexId: input.secondaryEmbeddingIndexId,
            embedding: [...chunk.embedding],
          });
        }
      }
      if (secondaryToInsert.length > 0) {
        await tx
          .insert(schema.kbChunkEmbedding)
          .values(secondaryToInsert)
          .onConflictDoUpdate({
            target: [schema.kbChunkEmbedding.chunkId, schema.kbChunkEmbedding.indexId],
            set: {
              embedding: sql`excluded.embedding`,
              updatedAt: new Date(),
            },
          });
      }
      await tx
        .insert(schema.kbVersionChunkManifest)
        .values({
          articleId: input.articleId,
          versionId: input.versionId,
          chunkSetFingerprint: fingerprint,
          chunkCount: input.chunks.length,
          completedIndexIds: [input.secondaryEmbeddingIndexId],
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            schema.kbVersionChunkManifest.versionId,
            schema.kbVersionChunkManifest.chunkSetFingerprint,
          ],
          set: {
            updatedAt: new Date(),
            completedIndexIds: sql`array_append(array_remove(${schema.kbVersionChunkManifest.completedIndexIds}, ${input.secondaryEmbeddingIndexId}::uuid), ${input.secondaryEmbeddingIndexId}::uuid)`,
          },
        });
    }
  }

  return true;
}

/** Removes every chunk of an article that is not live (deprecated). Idempotent. */
export async function dropArticleChunksIfNotLive(
  tx: DbTransaction,
  articleId: string,
): Promise<boolean> {
  // ADR-033 §6: Shared advisory lock before row lock
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtext('kb_article_publish_and_switch'))`,
  );
  const [article] = await tx
    .select({ status: schema.kbArticle.status })
    .from(schema.kbArticle)
    .where(eq(schema.kbArticle.id, articleId))
    .for('update')
    .limit(1);

  if (article === undefined || article.status === 'published') return false;
  await tx.delete(schema.kbChunk).where(eq(schema.kbChunk.articleId, articleId));
  await tx
    .delete(schema.kbVersionChunkManifest)
    .where(eq(schema.kbVersionChunkManifest.articleId, articleId));
  return true;
}

export interface ReembedTarget {
  readonly articleId: string;
  readonly versionId: string;
}

/**
 * Published articles whose live chunks are missing, or have not yet been embedded under
 * the given index. Uses completion manifests to safely handle 0-chunk articles without
 * infinite retry loops (ADR-033 §2).
 */
export async function articlesNeedingEmbedding(
  executor: ReadExecutor,
  targetIndexId: string,
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
          NOT EXISTS (
            SELECT 1 FROM kb_version_chunk_manifest m
             WHERE m.version_id = ${schema.kbArticle.publishedVersionId}
               AND ${targetIndexId}::uuid = ANY(m.completed_index_ids)
          )
          OR EXISTS (
            SELECT 1 FROM kb_chunk c
             WHERE c.version_id = ${schema.kbArticle.publishedVersionId}
               AND NOT EXISTS (
                 SELECT 1 FROM kb_chunk_embedding ce
                  WHERE ce.chunk_id = c.id
                    AND ce.index_id = ${targetIndexId}::uuid
               )
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
