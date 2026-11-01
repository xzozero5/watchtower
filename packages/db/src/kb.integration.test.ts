import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0013 (T-107a): knowledge base articles, immutable versions, chunks with pgvector
// embeddings and the embedding-index registry.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const INSUFFICIENT_PRIVILEGE = '42501';
const RESTRICT_VIOLATION = '23001';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

let testDb: TestDatabase;
let app: Pool;
const owner = () => testDb.owner.pool;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
});
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

/** An article with one version, written the way the domain does (deferred pointer, one transaction). */
async function article(
  pool: Pool,
  fields: { slug: string; status?: string; visibility?: string; lang?: string } & {
    publish?: boolean;
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
      `INSERT INTO kb_article_version (id, article_id, version, title, body_md, content_hash)
       VALUES ($1, $2, 1, 'Title', 'Body', $3)`,
      [versionId, articleId, HASH],
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
  return rows[0]?.id ?? '';
}

describe('0013_kb', () => {
  it('creates the tables, with the app role able to write articles and chunks', async () => {
    const { articleId, versionId } = await article(app, { slug: 'app-writes' });
    await app.query(`UPDATE kb_article SET status = 'in_review' WHERE id = $1`, [articleId]);
    await app.query(
      `INSERT INTO kb_chunk (article_id, version_id, ordinal, text, char_start, char_end)
       VALUES ($1, $2, 0, 'hello', 0, 5)`,
      [articleId, versionId],
    );
    await app.query(`DELETE FROM kb_chunk WHERE article_id = $1`, [articleId]);
  });

  it('keeps versions immutable: no UPDATE or DELETE for the app role, a trigger for everyone', async () => {
    const { versionId } = await article(app, { slug: 'immutable' });
    expect(
      await code(app.query(`UPDATE kb_article_version SET title = 'x' WHERE id = $1`, [versionId])),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await code(app.query(`DELETE FROM kb_article_version WHERE id = $1`, [versionId]))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await code(app.query('TRUNCATE kb_article_version'))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await code(
        owner().query(`UPDATE kb_article_version SET title = 'x' WHERE id = $1`, [versionId]),
      ),
    ).toBe(RESTRICT_VIOLATION);
    expect(
      await code(owner().query(`DELETE FROM kb_article_version WHERE id = $1`, [versionId])),
    ).toBe(RESTRICT_VIOLATION);
  });

  it('never lets the app role delete an article', async () => {
    const { articleId } = await article(app, { slug: 'no-delete' });
    expect(await code(app.query(`DELETE FROM kb_article WHERE id = $1`, [articleId]))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('numbers versions per article', async () => {
    const { articleId } = await article(app, { slug: 'numbered' });
    expect(
      await code(
        app.query(
          `INSERT INTO kb_article_version (article_id, version, title, body_md, content_hash)
           VALUES ($1, 1, 'Again', 'Body', $2)`,
          [articleId, HASH],
        ),
      ),
    ).toBe(UNIQUE_VIOLATION);
  });

  it('refuses a pointer to a version of another article, and a published status without a version', async () => {
    const one = await article(app, { slug: 'pointer-one' });
    const two = await article(app, { slug: 'pointer-two' });
    expect(
      await code(
        app.query(`UPDATE kb_article SET published_version_id = $1 WHERE id = $2`, [
          two.versionId,
          one.articleId,
        ]),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
    expect(
      await code(
        app.query(`UPDATE kb_article SET status = 'published' WHERE id = $1`, [one.articleId]),
      ),
    ).toBe(CHECK_VIOLATION);
    await app.query(
      `UPDATE kb_article SET status = 'published', published_version_id = $1 WHERE id = $2`,
      [one.versionId, one.articleId],
    );
  });

  it('refuses an article whose current version does not exist (deferred check at commit)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO kb_article (slug, lang, current_version_id) VALUES ('orphan', 'en', $1)`,
        [randomUUID()],
      );
      expect(await code(client.query('COMMIT'))).toBe(FOREIGN_KEY_VIOLATION);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('constrains slug, language, status, visibility and kind', async () => {
    for (const [column, value] of [
      ['slug', 'Not A Slug'],
      ['lang', 'fr'],
      ['status', 'archived'],
      ['visibility', 'public'],
      ['kind', 'page'],
    ] as const) {
      const fields = {
        slug: 'ok-slug',
        lang: 'en',
        status: 'draft',
        visibility: 'internal',
        kind: 'article',
      };
      const merged = { ...fields, [column]: value };
      expect(
        await code(
          app.query(
            `INSERT INTO kb_article (slug, lang, status, visibility, kind, current_version_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [merged.slug, merged.lang, merged.status, merged.visibility, merged.kind, randomUUID()],
          ),
        ),
        column,
      ).toBe(CHECK_VIOLATION);
    }
  });

  it('allows one active embedding index and one row per model', async () => {
    const first = await embeddingIndex(4, 'active-a');
    const second = await embeddingIndex(4, 'active-b');
    await owner().query('UPDATE kb_embedding_index SET is_active = true WHERE id = $1', [first]);
    expect(
      await code(
        owner().query('UPDATE kb_embedding_index SET is_active = true WHERE id = $1', [second]),
      ),
    ).toBe(UNIQUE_VIOLATION);
    expect(
      await code(
        owner().query(
          `INSERT INTO kb_embedding_index (provider, model, dimensions) VALUES ('mock', 'active-a', 4)`,
        ),
      ),
    ).toBe(UNIQUE_VIOLATION);
    await owner().query('UPDATE kb_embedding_index SET is_active = false WHERE id = $1', [first]);
  });

  it('checks the dimensions of an embedding against its index, and that the two columns go together', async () => {
    const index = await embeddingIndex(3, 'dims-3');
    const { articleId, versionId } = await article(app, { slug: 'dims' });
    const insert = (embedding: string | null, indexId: string | null, ordinal: number) =>
      app.query(
        `INSERT INTO kb_chunk (article_id, version_id, ordinal, text, char_start, char_end, embedding, embedding_index_id)
         VALUES ($1, $2, $3, 'chunk', 0, 5, $4::vector, $5)`,
        [articleId, versionId, ordinal, embedding, indexId],
      );
    expect(await code(insert('[1,2,3,4]', index, 0))).toBe(CHECK_VIOLATION);
    expect(await code(insert('[1,2,3]', null, 1))).toBe(CHECK_VIOLATION);
    expect(await code(insert(null, index, 2))).toBe(CHECK_VIOLATION);
    expect(await code(insert('[1,2,3]', index, 3))).toBeUndefined();
    expect(await code(insert(null, null, 4))).toBeUndefined();
    // Changing the vector later is checked too.
    expect(
      await code(
        app.query(
          `UPDATE kb_chunk SET embedding = '[1,2]'::vector WHERE ordinal = 3 AND article_id = $1`,
          [articleId],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('ranks chunks by cosine distance within one index', async () => {
    const index = await embeddingIndex(3, 'cosine-3');
    const { articleId, versionId } = await article(app, { slug: 'cosine' });
    const vectors = ['[1,0,0]', '[0,1,0]', '[0.9,0.1,0]'];
    for (const [ordinal, vector] of vectors.entries()) {
      await app.query(
        `INSERT INTO kb_chunk (article_id, version_id, ordinal, text, char_start, char_end, embedding, embedding_index_id)
         VALUES ($1, $2, $3, $4, 0, 1, $5::vector, $6)`,
        [articleId, versionId, 10 + ordinal, `v${String(ordinal)}`, vector, index],
      );
    }
    const { rows } = await app.query<{ text: string }>(
      `SELECT text FROM kb_chunk WHERE embedding_index_id = $1 ORDER BY embedding <=> '[1,0,0]'::vector LIMIT 3`,
      [index],
    );
    expect(rows.map((row) => row.text)).toEqual(['v0', 'v2', 'v1']);
  });

  it('finds Thai and English passages by trigram word similarity and uses the trigram index', async () => {
    const { articleId, versionId } = await article(app, { slug: 'trgm' });
    const texts = [
      'วิธีการรีเซ็ตรหัสผ่านของผู้ใช้ในระบบ',
      'How to reset a user password in the console',
      'Invoices are sent on the first day of the month',
    ];
    for (const [ordinal, text] of texts.entries()) {
      await app.query(
        `INSERT INTO kb_chunk (article_id, version_id, ordinal, text, char_start, char_end)
         VALUES ($1, $2, $3, $4, 0, $5)`,
        [articleId, versionId, 20 + ordinal, text, text.length],
      );
    }
    const search = async (query: string) =>
      (
        await app.query<{ text: string }>(
          `SELECT text FROM kb_chunk WHERE $1 <% text AND article_id = $2 ORDER BY word_similarity($1, text) DESC`,
          [query, articleId],
        )
      ).rows.map((row) => row.text);
    expect(await search('รหัสผ่าน')).toEqual([texts[0]]);
    expect(await search('reset password')).toEqual([texts[1]]);
    expect(await search('invoices')).toEqual([texts[2]]);

    await owner().query('SET enable_seqscan = off');
    const plan = await owner().query<Record<string, string>>(
      `EXPLAIN SELECT id FROM kb_chunk WHERE 'password' <% text`,
    );
    expect(plan.rows.map((row) => Object.values(row)[0]).join('\n')).toContain(
      'kb_chunk_text_trgm_idx',
    );
  });

  it('seeds kb.read.customer for the client role only', async () => {
    const { rows } = await owner().query<{ role: string }>(
      `SELECT role FROM role_permissions WHERE permission = 'kb.read.customer' ORDER BY role`,
    );
    expect(rows.map((row) => row.role)).toEqual(['client']);
  });

  it('seeds kb.publish.break_glass for the head only', async () => {
    const { rows } = await owner().query<{ role: string }>(
      `SELECT role FROM role_permissions WHERE permission = 'kb.publish.break_glass' ORDER BY role`,
    );
    expect(rows.map((row) => row.role)).toEqual(['head']);
  });

  it('keeps a pending break-glass publication tied to who did it and why', async () => {
    const { articleId } = await article(app, { slug: 'glass', publish: true, status: 'published' });
    const pending = (set: string, params: unknown[] = []) =>
      app.query(`UPDATE kb_article SET break_glass_pending = true${set} WHERE id = $1`, [
        articleId,
        ...params,
      ]);
    expect(await code(pending(''))).toBe(CHECK_VIOLATION);
    expect(
      await code(pending(", break_glass_by = $2, break_glass_reason = '  '", [randomUUID()])),
    ).toBe(CHECK_VIOLATION);
    expect(
      await code(pending(", break_glass_by = $2, break_glass_reason = 'outage'", [randomUUID()])),
    ).toBeUndefined();
  });

  it('removes an organization from the audience of its articles when the organization goes', async () => {
    const { articleId } = await article(app, { slug: 'orgs', visibility: 'orgs' });
    const org = await owner().query<{ id: string }>(
      `INSERT INTO organization (name) VALUES ('KB Org') RETURNING id`,
    );
    await owner().query('INSERT INTO kb_article_org (article_id, org_id) VALUES ($1, $2)', [
      articleId,
      org.rows[0]?.id,
    ]);
    await owner().query('DELETE FROM organization WHERE id = $1', [org.rows[0]?.id]);
    const left = await owner().query('SELECT 1 FROM kb_article_org WHERE article_id = $1', [
      articleId,
    ]);
    expect(left.rowCount).toBe(0);
  });

  it('reverts and applies again', async () => {
    const later = await migrationsAfter('0013_kb');
    expect(await migrateDown(owner(), { steps: 1 + later.length })).toEqual([
      ...later.toReversed(),
      '0013_kb',
    ]);
    const gone = await owner().query(
      `SELECT to_regclass('kb_article') AS a, to_regclass('kb_article_version') AS b,
              to_regclass('kb_chunk') AS c, to_regclass('kb_embedding_index') AS d,
              to_regclass('kb_article_org') AS e,
              (SELECT count(*) FROM permissions WHERE key IN ('kb.read.customer', 'kb.publish.break_glass'))::int AS p`,
    );
    expect(gone.rows[0]).toEqual({ a: null, b: null, c: null, d: null, e: null, p: 0 });
    expect(await migrateUp(owner())).toEqual(['0013_kb', ...later]);
    const back = await owner().query(`SELECT to_regclass('kb_chunk') AS c`);
    expect(back.rows[0]).toEqual({ c: 'kb_chunk' });
  });
});
