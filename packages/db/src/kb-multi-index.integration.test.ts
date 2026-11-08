import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0119 (T-434b / ADR-033): Multi-index KB chunk embeddings table, triggers,
// version chunk manifests, and deterministic chunk fingerprinting.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const RESTRICT_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

let testDb: TestDatabase;
let app: Pool;
const owner = () => testDb.owner.pool;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
}, 60_000);

afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

const code = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const HASH = 'a'.repeat(64);

async function article(
  pool: Pool,
  fields: { slug: string; status?: string; visibility?: string; lang?: string } & {
    publish?: boolean;
    createdBy?: string;
  },
): Promise<{ articleId: string; versionId: string }> {
  const articleId = randomUUID();
  const versionId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO kb_article (id, slug, lang, status, visibility, current_version_id, published_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        articleId,
        fields.slug,
        fields.lang ?? 'en',
        fields.status ?? 'draft',
        fields.visibility ?? 'internal',
        versionId,
        fields.publish === true ? versionId : null,
      ],
    );
    await client.query(
      `INSERT INTO kb_article_version (id, article_id, version, title, body_md, content_hash, created_by)
       VALUES ($1, $2, 1, 'Title', 'Body', $3, $4)`,
      [versionId, articleId, HASH, fields.createdBy ?? null],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { articleId, versionId };
}

async function embeddingIndex(dimensions: number, model = `m-${String(dimensions)}`) {
  const { rows } = await owner().query<{ id: string }>(
    `INSERT INTO kb_embedding_index (provider, model, dimensions) VALUES ('mock', $1, $2) RETURNING id`,
    [model, dimensions],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Failed to insert kb_embedding_index');
  return id;
}

describe('0119_kb_chunk_embeddings migration and constraints (ADR-033 §1, §2)', () => {
  it('creates tables with correct permissions for watchtower_app', async () => {
    const { articleId, versionId } = await article(app, { slug: 'multi-index-app' });
    const idxId = await embeddingIndex(4, 'app-test-idx-4d');

    // Insert chunk
    const chunkId = randomUUID();
    await app.query(
      `INSERT INTO kb_chunk (id, article_id, version_id, chunk_set_fingerprint, ordinal, text, char_start, char_end)
       VALUES ($1, $2, $3, 'fp-1', 0, 'sample chunk', 0, 12)`,
      [chunkId, articleId, versionId],
    );

    // App role can INSERT into kb_chunk_embedding
    await app.query(
      `INSERT INTO kb_chunk_embedding (chunk_id, index_id, embedding)
       VALUES ($1, $2, '[0.1, 0.2, 0.3, 0.4]')`,
      [chunkId, idxId],
    );

    // App role can SELECT from kb_chunk_embedding
    const read = await app.query<{ index_id: string }>(
      `SELECT chunk_id, index_id, embedding FROM kb_chunk_embedding WHERE chunk_id = $1`,
      [chunkId],
    );
    expect(read.rowCount).toBe(1);
    expect(read.rows[0]?.index_id).toBe(idxId);

    // App role can UPDATE kb_chunk_embedding
    await app.query(
      `UPDATE kb_chunk_embedding SET embedding = '[0.5, 0.6, 0.7, 0.8]' WHERE chunk_id = $1 AND index_id = $2`,
      [chunkId, idxId],
    );

    // App role can INSERT/SELECT/UPDATE on kb_version_chunk_manifest
    await app.query(
      `INSERT INTO kb_version_chunk_manifest (article_id, version_id, chunk_set_fingerprint, chunk_count, completed_index_ids)
       VALUES ($1, $2, 'fp-1', 1, ARRAY[$3]::uuid[])`,
      [articleId, versionId, idxId],
    );
    const manifest = await app.query<{ chunk_count: number }>(
      `SELECT chunk_count FROM kb_version_chunk_manifest WHERE version_id = $1`,
      [versionId],
    );
    expect(manifest.rows[0]?.chunk_count).toBe(1);

    // App role can DELETE
    await app.query(`DELETE FROM kb_chunk_embedding WHERE chunk_id = $1`, [chunkId]);
    await app.query(`DELETE FROM kb_version_chunk_manifest WHERE version_id = $1`, [versionId]);
    await app.query(`DELETE FROM kb_chunk WHERE id = $1`, [chunkId]);
  });

  it('validates vector dimensions against kb_embedding_index via trigger', async () => {
    const { articleId, versionId } = await article(app, { slug: 'dimension-trigger' });
    const idx4d = await embeddingIndex(4, 'idx-4d');
    const chunkId = randomUUID();

    await app.query(
      `INSERT INTO kb_chunk (id, article_id, version_id, chunk_set_fingerprint, ordinal, text, char_start, char_end)
       VALUES ($1, $2, $3, 'fp-dim', 0, 'chunk for trigger', 0, 17)`,
      [chunkId, articleId, versionId],
    );

    // Refuses mismatched dimensions (2 dimensions instead of 4)
    expect(
      await code(
        app.query(
          `INSERT INTO kb_chunk_embedding (chunk_id, index_id, embedding)
           VALUES ($1, $2, '[0.1, 0.2]')`,
          [chunkId, idx4d],
        ),
      ),
    ).toBe(CHECK_VIOLATION);

    // Refuses mismatched dimensions (5 dimensions instead of 4)
    expect(
      await code(
        app.query(
          `INSERT INTO kb_chunk_embedding (chunk_id, index_id, embedding)
           VALUES ($1, $2, '[0.1, 0.2, 0.3, 0.4, 0.5]')`,
          [chunkId, idx4d],
        ),
      ),
    ).toBe(CHECK_VIOLATION);

    // Accepts matching dimensions (4 dimensions)
    await app.query(
      `INSERT INTO kb_chunk_embedding (chunk_id, index_id, embedding)
       VALUES ($1, $2, '[0.1, 0.2, 0.3, 0.4]')`,
      [chunkId, idx4d],
    );
  });

  it('refuses non-finite vector components (NaN, Infinity)', async () => {
    const { articleId, versionId } = await article(app, { slug: 'finite-trigger' });
    const idx2d = await embeddingIndex(2, 'idx-2d');
    const chunkId = randomUUID();

    await app.query(
      `INSERT INTO kb_chunk (id, article_id, version_id, chunk_set_fingerprint, ordinal, text, char_start, char_end)
       VALUES ($1, $2, $3, 'fp-finite', 0, 'chunk for finite', 0, 16)`,
      [chunkId, articleId, versionId],
    );

    // Refuses NaN
    const nanCode = await code(
      app.query(
        `INSERT INTO kb_chunk_embedding (chunk_id, index_id, embedding)
         VALUES ($1, $2, '[NaN, 1.0]')`,
        [chunkId, idx2d],
      ),
    );
    expect(['22000', '23514']).toContain(nanCode);

    // Refuses Infinity
    const infCode = await code(
      app.query(
        `INSERT INTO kb_chunk_embedding (chunk_id, index_id, embedding)
         VALUES ($1, $2, '[Infinity, 1.0]')`,
        [chunkId, idx2d],
      ),
    );
    expect(['22000', '23514']).toContain(infCode);

    // Refuses -Infinity
    const negInfCode = await code(
      app.query(
        `INSERT INTO kb_chunk_embedding (chunk_id, index_id, embedding)
         VALUES ($1, $2, '[-Infinity, 1.0]')`,
        [chunkId, idx2d],
      ),
    );
    expect(['22000', '23514']).toContain(negInfCode);
  });

  it('enforces primary key uniqueness and foreign key constraints', async () => {
    const { articleId, versionId } = await article(app, { slug: 'fk-constraints' });
    const idxId = await embeddingIndex(3, 'idx-3d');
    const chunkId = randomUUID();

    await app.query(
      `INSERT INTO kb_chunk (id, article_id, version_id, chunk_set_fingerprint, ordinal, text, char_start, char_end)
       VALUES ($1, $2, $3, 'fp-fk', 0, 'chunk text', 0, 10)`,
      [chunkId, articleId, versionId],
    );

    await app.query(
      `INSERT INTO kb_chunk_embedding (chunk_id, index_id, embedding)
       VALUES ($1, $2, '[1, 2, 3]')`,
      [chunkId, idxId],
    );

    // Primary key violation: duplicate (chunk_id, index_id)
    expect(
      await code(
        app.query(
          `INSERT INTO kb_chunk_embedding (chunk_id, index_id, embedding)
           VALUES ($1, $2, '[4, 5, 6]')`,
          [chunkId, idxId],
        ),
      ),
    ).toBe(UNIQUE_VIOLATION);

    // Foreign key violation: non-existent chunk_id
    expect(
      await code(
        app.query(
          `INSERT INTO kb_chunk_embedding (chunk_id, index_id, embedding)
           VALUES ($1, $2, '[1, 2, 3]')`,
          [randomUUID(), idxId],
        ),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);

    // Restrict deletion of kb_embedding_index when referenced
    expect(await code(owner().query(`DELETE FROM kb_embedding_index WHERE id = $1`, [idxId]))).toBe(
      RESTRICT_VIOLATION,
    );

    // Cascade deletion: deleting kb_chunk removes kb_chunk_embedding
    await app.query(`DELETE FROM kb_chunk WHERE id = $1`, [chunkId]);
    const remaining = await app.query(`SELECT 1 FROM kb_chunk_embedding WHERE chunk_id = $1`, [
      chunkId,
    ]);
    expect(remaining.rowCount).toBe(0);
  });

  it('reverts cleanly with down migration and reapplies up', async () => {
    const later = await migrationsAfter('0119_kb_chunk_embeddings');
    const reverted = await migrateDown(owner(), { steps: 1 + later.length });
    expect(reverted).toEqual([...later.toReversed(), '0119_kb_chunk_embeddings']);

    // Check that tables and functions created in 0119 are removed
    const checkGone = await owner().query(
      `SELECT to_regclass('kb_chunk_embedding') AS t1,
              to_regclass('kb_version_chunk_manifest') AS t2,
              to_regprocedure('kb_chunk_embedding_check()') AS p1,
              (SELECT count(*) FROM information_schema.columns
                WHERE table_name = 'kb_chunk' AND column_name = 'chunk_set_fingerprint')::int AS col_count`,
    );
    expect(checkGone.rows[0]).toEqual({
      t1: null,
      t2: null,
      p1: null,
      col_count: 0,
    });

    // Reapply migration
    const reapplied = await migrateUp(owner());
    expect(reapplied).toEqual(['0119_kb_chunk_embeddings', ...later]);

    // Check that tables exist again
    const checkBack = await owner().query<{
      t1: string | null;
      t2: string | null;
      p1: string | null;
    }>(
      `SELECT to_regclass('kb_chunk_embedding') AS t1,
              to_regclass('kb_version_chunk_manifest') AS t2,
              to_regprocedure('kb_chunk_embedding_check()') AS p1`,
    );
    expect(checkBack.rows[0]?.t1).toBe('kb_chunk_embedding');
    expect(checkBack.rows[0]?.t2).toBe('kb_version_chunk_manifest');
    expect(checkBack.rows[0]?.p1).toBe('kb_chunk_embedding_check()');
  });

  it('backfills existing vectors from kb_chunk into kb_chunk_embedding preserving chunk IDs', async () => {
    // Step 1: Revert 0119
    const later = await migrationsAfter('0119_kb_chunk_embeddings');
    await migrateDown(owner(), { steps: 1 + later.length });

    // Step 2: Insert chunks with embeddings in kb_chunk prior to 0119
    const { articleId, versionId } = await article(owner(), { slug: 'backfill-test' });
    const idxId = await embeddingIndex(4, 'backfill-idx-4d');
    const chunkId1 = randomUUID();
    const chunkId2 = randomUUID();

    await owner().query(
      `INSERT INTO kb_chunk (id, article_id, version_id, ordinal, text, char_start, char_end, embedding, embedding_index_id)
       VALUES ($1, $2, $3, 0, 'Chunk 1', 0, 7, '[1, 0, 0, 0]', $4),
              ($5, $2, $3, 1, 'Chunk 2', 8, 15, '[0, 1, 0, 0]', $4)`,
      [chunkId1, articleId, versionId, idxId, chunkId2],
    );

    // Step 3: Run migrateUp to apply 0119
    await migrateUp(owner());

    // Step 4: Verify backfilled rows in kb_chunk_embedding
    const backfilled = await owner().query<{
      chunk_id: string;
      index_id: string;
      embedding: string;
    }>(
      `SELECT chunk_id, index_id, embedding::text
         FROM kb_chunk_embedding
        WHERE chunk_id IN ($1, $2)
        ORDER BY chunk_id`,
      [chunkId1, chunkId2],
    );

    expect(backfilled.rowCount).toBe(2);
    const c1 = backfilled.rows.find((r) => r.chunk_id === chunkId1);
    const c2 = backfilled.rows.find((r) => r.chunk_id === chunkId2);
    expect(c1).toBeDefined();
    expect(c1?.index_id).toBe(idxId);
    expect(c1?.embedding).toBe('[1,0,0,0]');
    expect(c2).toBeDefined();
    expect(c2?.index_id).toBe(idxId);
    expect(c2?.embedding).toBe('[0,1,0,0]');

    // Also verify that kb_chunk.chunk_set_fingerprint was backfilled with non-empty deterministic string
    const chunks = await owner().query<{ chunk_set_fingerprint: string }>(
      `SELECT chunk_set_fingerprint FROM kb_chunk WHERE id IN ($1, $2)`,
      [chunkId1, chunkId2],
    );
    expect(chunks.rows[0]?.chunk_set_fingerprint).toBeTruthy();
    expect(chunks.rows[0]?.chunk_set_fingerprint.length).toBe(64);
  });
});
