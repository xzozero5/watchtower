import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0019 (T-107a): knowledge base articles, immutable versions, chunks with pgvector
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
  return rows[0]?.id ?? '';
}

describe('0019_kb', () => {
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
  it('keeps a pending break-glass publication tied to a real publication', async () => {
    const { articleId, versionId } = await article(app, {
      slug: 'glass',
      publish: true,
      status: 'published',
    });
    const { rows } = await owner().query<{ id: string }>(
      `INSERT INTO users (email, name, role) VALUES ($1, 'Glass publisher', 'head') RETURNING id`,
      [`${randomUUID()}@example.test`],
    );
    const head = rows[0]?.id ?? '';
    const pending = (set: string, params: unknown[] = []) =>
      app.query(`UPDATE kb_article SET break_glass_pending = true${set} WHERE id = $1`, [
        articleId,
        ...params,
      ]);
    expect(await code(pending(''))).toBe(CHECK_VIOLATION);
    expect(await code(pending(", break_glass_by = $2, break_glass_reason = '  '", [head]))).toBe(
      CHECK_VIOLATION,
    );
    // Without the version that went live and the one before it, the reviewer cannot be checked.
    expect(
      await code(pending(", break_glass_by = $2, break_glass_reason = 'outage'", [head])),
    ).toBe(CHECK_VIOLATION);
    // All the columns, but the live version did not change: nobody published anything.
    expect(
      await code(
        pending(
          `, break_glass_by = $2, break_glass_reason = 'outage', break_glass_version_id = $3,
             break_glass_prev_version = 0, break_glass_at = now(), break_glass_publishers = ARRAY[$2]::uuid[]`,
          [head, versionId],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
    // A new article carries no record at all.
    expect(
      await code(
        app.query(
          `INSERT INTO kb_article (slug, lang, current_version_id, break_glass_reason)
           VALUES ('born-flagged', 'en', $1, 'x')`,
          [randomUUID()],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  describe('the break-glass guard trigger (P3-D, P2)', () => {
    let publisher = '';
    let otherPublisher = '';
    let writer = '';
    let reviewer = '';

    const makeUser = async (role: string): Promise<string> => {
      const { rows } = await owner().query<{ id: string }>(
        `INSERT INTO users (email, name, role) VALUES ($1, 'KB test user', $2) RETURNING id`,
        [`${randomUUID()}@example.test`, role],
      );
      return rows[0]?.id ?? '';
    };
    beforeAll(async () => {
      publisher = await makeUser('head');
      otherPublisher = await makeUser('head');
      writer = await makeUser('lead');
      reviewer = await makeUser('lead');
    });

    const addVersion = async (
      articleId: string,
      version: number,
      createdBy: string | null,
      ai = false,
    ): Promise<string> => {
      const id = randomUUID();
      await app.query(
        `INSERT INTO kb_article_version (id, article_id, version, title, body_md, content_hash, created_by, authored_by_machine)
         VALUES ($1, $2, $3, 'Title', $4, $5, $6, $7)`,
        [id, articleId, version, `Body ${String(version)}`, HASH, createdBy, ai],
      );
      return id;
    };

    /** What `publishKbArticleBreakGlass` writes, with the knobs a forger would turn. */
    const glass = (
      articleId: string,
      versionId: string,
      fields: {
        by: string;
        prev: number;
        publishers: string[];
        atOffsetMs?: number;
        reason?: string;
      },
    ) =>
      app.query(
        `UPDATE kb_article SET status = 'published', current_version_id = $2, published_version_id = $2,
                break_glass_pending = true, break_glass_by = $3, break_glass_at = $4,
                break_glass_reason = $5, break_glass_version_id = $2, break_glass_prev_version = $6,
                break_glass_publishers = $7::uuid[], break_glass_reviewed_by = NULL,
                break_glass_reviewed_at = NULL
         WHERE id = $1`,
        [
          articleId,
          versionId,
          fields.by,
          new Date(Date.now() + (fields.atOffsetMs ?? 0)),
          fields.reason ?? 'outage',
          fields.prev,
          fields.publishers,
        ],
      );

    /** v1 (by `firstWriter`) is live; v2 by `writer` went live break-glass through `publisher`. */
    async function glassArticle(
      slug: string,
      firstWriter: string | null = null,
    ): Promise<{ articleId: string; v1: string; v2: string }> {
      const { articleId, versionId: v1 } = await article(app, {
        slug,
        publish: true,
        status: 'published',
        ...(firstWriter === null ? {} : { createdBy: firstWriter }),
      });
      const v2 = await addVersion(articleId, 2, writer);
      await glass(articleId, v2, { by: publisher, prev: 1, publishers: [publisher] });
      return { articleId, v1, v2 };
    }

    const clear = (articleId: string, by: string | null, extra = '') =>
      app.query(
        `UPDATE kb_article SET break_glass_pending = false, break_glass_reviewed_by = $2,
                break_glass_reviewed_at = CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END${extra}
         WHERE id = $1`,
        [articleId, by],
      );
    const pendingOf = async (articleId: string): Promise<boolean | undefined> =>
      (
        await app.query<{ break_glass_pending: boolean }>(
          'SELECT break_glass_pending FROM kb_article WHERE id = $1',
          [articleId],
        )
      ).rows[0]?.break_glass_pending;

    it('clears only with a review from somebody else than the publisher', async () => {
      const { articleId } = await glassArticle('guard-publisher');
      expect(await code(clear(articleId, null))).toBe(CHECK_VIOLATION);
      expect(await code(clear(articleId, publisher))).toBe(CHECK_VIOLATION);
      expect(
        await code(
          app.query('UPDATE kb_article SET break_glass_pending = false WHERE id = $1', [articleId]),
        ),
      ).toBe(CHECK_VIOLATION);
      expect(await code(clear(articleId, reviewer))).toBeUndefined();
    });

    it('does not clear for somebody who wrote the text that went live (P2-A)', async () => {
      const { articleId } = await glassArticle('guard-writer');
      expect(await code(clear(articleId, writer))).toBe(CHECK_VIOLATION);
      expect(await pendingOf(articleId)).toBe(true);
      expect(await code(clear(articleId, reviewer))).toBeUndefined();
    });

    it('lets somebody who wrote only a version that was live before review', async () => {
      const older = await makeUser('lead');
      const { articleId } = await glassArticle('guard-older', older);
      expect(await code(clear(articleId, older))).toBeUndefined();
    });

    it('refuses a reviewer who is not a user (P3-D)', async () => {
      const { articleId } = await glassArticle('guard-ghost');
      expect(await code(clear(articleId, randomUUID()))).toBe(CHECK_VIOLATION);
      expect(await pendingOf(articleId)).toBe(true);
      expect(await code(clear(articleId, reviewer))).toBeUndefined();
    });

    it('freezes who, when, why and which version while the flag is up and nothing new went live', async () => {
      const { articleId } = await glassArticle('guard-frozen');
      const edit = (set: string) =>
        app.query(`UPDATE kb_article SET ${set} WHERE id = $1`, [articleId]);
      expect(await code(edit(`break_glass_reason = 'something else'`))).toBe(CHECK_VIOLATION);
      expect(await code(edit(`break_glass_by = '${reviewer}'`))).toBe(CHECK_VIOLATION);
      expect(await code(edit(`break_glass_at = now() + interval '1 hour'`))).toBe(CHECK_VIOLATION);
      expect(await code(edit('break_glass_prev_version = 0'))).toBe(CHECK_VIOLATION);
      expect(await code(edit('break_glass_version_id = NULL'))).toBe(CHECK_VIOLATION);
      expect(await code(edit('break_glass_publishers = ARRAY[]::uuid[]'))).toBe(CHECK_VIOLATION);
      // Clearing cannot rewrite the record either.
      expect(await code(clear(articleId, reviewer, `, break_glass_reason = 'rewritten'`))).toBe(
        CHECK_VIOLATION,
      );
      expect(await code(clear(articleId, reviewer, `, break_glass_prev_version = 5`))).toBe(
        CHECK_VIOLATION,
      );
      expect(
        await code(clear(articleId, reviewer, `, break_glass_publishers = ARRAY[]::uuid[]`)),
      ).toBe(CHECK_VIOLATION);
      // Unrelated columns stay free.
      expect(await code(edit(`updated_at = now()`))).toBeUndefined();
    });

    it('freezes the record after the review: nobody edits the reason or the publisher (P3-D)', async () => {
      const { articleId } = await glassArticle('guard-after-review');
      expect(await code(clear(articleId, reviewer))).toBeUndefined();
      const edit = (set: string) =>
        app.query(`UPDATE kb_article SET ${set} WHERE id = $1`, [articleId]);
      for (const set of [
        `break_glass_reason = 'rewritten'`,
        `break_glass_by = '${reviewer}'`,
        `break_glass_at = now()`,
        `break_glass_reviewed_by = '${publisher}'`,
        `break_glass_publishers = ARRAY['${reviewer}']::uuid[]`,
        'break_glass_prev_version = 2',
        'break_glass_pending = true',
      ]) {
        expect(await code(edit(set)), set).toBe(CHECK_VIOLATION);
      }
      expect(await code(edit(`updated_at = now()`))).toBeUndefined();
    });

    it('does not let a record be made up on an article that never had one', async () => {
      const { articleId } = await article(app, {
        slug: 'guard-never',
        publish: true,
        status: 'published',
      });
      for (const set of [
        `break_glass_reason = 'because'`,
        `break_glass_by = '${publisher}'`,
        `break_glass_publishers = ARRAY['${publisher}']::uuid[]`,
        `break_glass_reviewed_by = '${reviewer}'`,
      ]) {
        expect(
          await code(app.query(`UPDATE kb_article SET ${set} WHERE id = $1`, [articleId])),
          set,
        ).toBe(CHECK_VIOLATION);
      }
    });

    it('lets a newer break-glass publication replace the one waiting, and only that way', async () => {
      const { articleId } = await glassArticle('guard-replace');
      const v3 = await addVersion(articleId, 3, writer);
      await glass(articleId, v3, {
        by: publisher,
        prev: 1,
        publishers: [publisher],
        atOffsetMs: 60_000,
        reason: 'again',
      });
      const { rows } = await app.query<{ break_glass_reason: string }>(
        'SELECT break_glass_reason FROM kb_article WHERE id = $1',
        [articleId],
      );
      expect(rows[0]?.break_glass_reason).toBe('again');
    });

    it('keeps the earlier range and every publisher when a second one replaces the first (P2)', async () => {
      const { articleId } = await glassArticle('guard-window');
      const v3 = await addVersion(articleId, 3, writer);
      // The overwrite that let the author of v2 clear the flag: prev moved from 1 to 2.
      expect(
        await code(
          glass(articleId, v3, {
            by: publisher,
            prev: 2,
            publishers: [publisher],
            atOffsetMs: 60_000,
          }),
        ),
      ).toBe(CHECK_VIOLATION);
      // Dropping the first publisher, or not adding the second one, is refused too.
      expect(
        await code(
          glass(articleId, v3, {
            by: otherPublisher,
            prev: 1,
            publishers: [otherPublisher],
            atOffsetMs: 60_000,
          }),
        ),
      ).toBe(CHECK_VIOLATION);
      expect(
        await code(
          glass(articleId, v3, {
            by: otherPublisher,
            prev: 1,
            publishers: [publisher],
            atOffsetMs: 60_000,
          }),
        ),
      ).toBe(CHECK_VIOLATION);
      // The honest one: same range, both publishers, a later time.
      expect(
        await code(
          glass(articleId, v3, {
            by: otherPublisher,
            prev: 1,
            publishers: [publisher, otherPublisher],
            atOffsetMs: 60_000,
          }),
        ),
      ).toBeUndefined();
      // Neither publisher, nor the writer of v2 or v3, clears it.
      for (const blocked of [publisher, otherPublisher, writer]) {
        expect(await code(clear(articleId, blocked)), blocked).toBe(CHECK_VIOLATION);
      }
      expect(await code(clear(articleId, reviewer))).toBeUndefined();
    });

    it('refuses the two-step forgery: change the live version, restore it, then clear as the publisher (P3-D)', async () => {
      const { articleId, v1, v2 } = await glassArticle('guard-forgery');
      const v3 = await addVersion(articleId, 3, writer);
      // Step 1: the live version really changes, with forged record columns.
      expect(
        await code(
          glass(articleId, v3, {
            by: reviewer,
            prev: 3,
            publishers: [reviewer],
            atOffsetMs: 60_000,
          }),
        ),
      ).toBe(CHECK_VIOLATION);
      // Step 1 (variant): change the live version alone (no record column changes: allowed) ...
      await app.query(
        'UPDATE kb_article SET published_version_id = $2, current_version_id = $3 WHERE id = $1',
        [articleId, v1, v3],
      );
      // ... then forge the record while restoring the live version. v2 is no longer the newest.
      expect(
        await code(
          app.query(
            `UPDATE kb_article SET published_version_id = $2, break_glass_by = $3,
                    break_glass_prev_version = 2, break_glass_publishers = ARRAY[$3]::uuid[],
                    break_glass_at = now() + interval '1 minute'
             WHERE id = $1`,
            [articleId, v2, reviewer],
          ),
        ),
      ).toBe(CHECK_VIOLATION);
      // The real publisher (and the writer of v2) still cannot clear it.
      expect(await code(clear(articleId, publisher))).toBe(CHECK_VIOLATION);
      expect(await code(clear(articleId, writer))).toBe(CHECK_VIOLATION);
      expect(await pendingOf(articleId)).toBe(true);
    });

    it('records a publication only for the newest version, with a live version that really changed', async () => {
      const { articleId, v2 } = await glassArticle('guard-newest');
      const v3 = await addVersion(articleId, 3, writer);
      // v2 is no longer the newest version.
      expect(
        await code(
          app.query(`UPDATE kb_article SET current_version_id = $2 WHERE id = $1`, [articleId, v3]),
        ),
      ).toBeUndefined();
      expect(
        await code(
          app.query(
            `UPDATE kb_article SET break_glass_at = now() + interval '2 minutes', break_glass_reason = 'again',
                    break_glass_by = $2, break_glass_publishers = ARRAY[$3, $2]::uuid[]
             WHERE id = $1`,
            [articleId, otherPublisher, publisher],
          ),
        ),
      ).toBe(CHECK_VIOLATION);
      // The live version has to differ from the one that was live.
      expect(
        await code(
          glass(articleId, v2, {
            by: otherPublisher,
            prev: 1,
            publishers: [publisher, otherPublisher],
            atOffsetMs: 120_000,
          }),
        ),
      ).toBe(CHECK_VIOLATION);
    });

    it('does not put AI-written text live by break-glass, and does not mind an AI version that was live before', async () => {
      const { articleId } = await article(app, {
        slug: 'guard-ai',
        publish: true,
        status: 'published',
      });
      const ai2 = await addVersion(articleId, 2, null, true);
      // v2 was written by an AI: no break-glass for it.
      expect(
        await code(glass(articleId, ai2, { by: publisher, prev: 1, publishers: [publisher] })),
      ).toBe(CHECK_VIOLATION);
      // A person's v3 on top of it: still in the range (1, 3].
      const v3 = await addVersion(articleId, 3, writer);
      expect(
        await code(glass(articleId, v3, { by: publisher, prev: 1, publishers: [publisher] })),
      ).toBe(CHECK_VIOLATION);
      // Once v3 is live (normal publication, no record), the AI version is behind it.
      await app.query(
        'UPDATE kb_article SET current_version_id = $2, published_version_id = $2 WHERE id = $1',
        [articleId, v3],
      );
      const v4 = await addVersion(articleId, 4, writer);
      expect(
        await code(glass(articleId, v4, { by: publisher, prev: 3, publishers: [publisher] })),
      ).toBeUndefined();
    });

    it('points only at versions of its own article', async () => {
      const mine = await article(app, { slug: 'guard-fk-a', publish: true, status: 'published' });
      const other = await article(app, { slug: 'guard-fk-b' });
      expect(
        await code(
          app.query('UPDATE kb_article SET review_version_id = $2 WHERE id = $1', [
            mine.articleId,
            other.versionId,
          ]),
        ),
      ).toBe(FOREIGN_KEY_VIOLATION);
      // The trigger refuses a record that no publication wrote before the foreign key is looked at;
      // the key stays as the second line.
      expect(
        await code(
          app.query('UPDATE kb_article SET break_glass_version_id = $2 WHERE id = $1', [
            mine.articleId,
            other.versionId,
          ]),
        ),
      ).toBe(CHECK_VIOLATION);
      expect(
        await code(
          app.query('UPDATE kb_article SET review_version_id = $2 WHERE id = $1', [
            mine.articleId,
            mine.versionId,
          ]),
        ),
      ).toBeUndefined();
    });
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
    const later = await migrationsAfter('0019_kb');
    expect(await migrateDown(owner(), { steps: 1 + later.length })).toEqual([
      ...later.toReversed(),
      '0019_kb',
    ]);
    const gone = await owner().query(
      `SELECT to_regclass('kb_article') AS a, to_regclass('kb_article_version') AS b,
              to_regclass('kb_chunk') AS c, to_regclass('kb_embedding_index') AS d,
              to_regclass('kb_article_org') AS e,
              to_regprocedure('kb_article_guard_break_glass()') AS f,
              (SELECT count(*) FROM permissions WHERE key IN ('kb.read.customer', 'kb.publish.break_glass'))::int AS p`,
    );
    expect(gone.rows[0]).toEqual({
      a: null,
      b: null,
      c: null,
      d: null,
      e: null,
      f: null,
      p: 0,
    });
    expect(await migrateUp(owner())).toEqual(['0019_kb', ...later]);
    const back = await owner().query(`SELECT to_regclass('kb_chunk') AS c`);
    expect(back.rows[0]).toEqual({ c: 'kb_chunk' });
  });
});
