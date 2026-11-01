import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../client.js';
import { createTestDatabase, type TestDatabase } from '../testing.js';
import { parseKbArticleFile, seedKbArticles } from './kb.js';

// The knowledge base part of the development seed (T-107), against the compose Postgres.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
let app: Database;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = createDatabase({ url: testDb.appUrl, max: 2, applicationName: 'wt-kb-seed-test' });
});
afterAll(async () => {
  await app.close();
  await testDb.cleanup();
});

const articles = [
  parseKbArticleFile(
    'one.md',
    '---\nslug: seed-one\ntitle: Seed one\nlang: en\nvisibility: customer\ntags: seed_probe\n---\nFirst body.',
  ),
  parseKbArticleFile(
    'two.md',
    '---\nslug: seed-two\ntitle: บทความตัวอย่าง\nlang: th\n---\nเนื้อหาตัวอย่าง',
  ),
];

const pool = () => testDb.owner.pool;

describe('seedKbArticles', () => {
  it('writes published articles with version 1 and queues an embed job for each', async () => {
    const result = await app.db.transaction((tx) => seedKbArticles(tx, articles));
    expect(result).toEqual({ created: ['seed-one', 'seed-two'], existing: [] });

    const { rows } = await pool().query(
      `SELECT a.slug, a.status, a.visibility, a.lang, a.published_version_id = a.current_version_id AS live,
              v.version, v.title, a.reviewer_id, a.author_id
         FROM kb_article a JOIN kb_article_version v ON v.id = a.current_version_id
        ORDER BY a.slug`,
    );
    expect(rows).toEqual([
      {
        slug: 'seed-one',
        status: 'published',
        visibility: 'customer',
        lang: 'en',
        live: true,
        version: 1,
        title: 'Seed one',
        reviewer_id: null,
        author_id: null,
      },
      {
        slug: 'seed-two',
        status: 'published',
        visibility: 'internal',
        lang: 'th',
        live: true,
        version: 1,
        title: 'บทความตัวอย่าง',
        reviewer_id: null,
        author_id: null,
      },
    ]);
    const jobs = await pool().query<{ payload: { articleId: string; versionId: string } }>(
      `SELECT payload FROM outbox WHERE queue = 'kb' AND job_name = 'embed_article'`,
    );
    expect(jobs.rows).toHaveLength(2);
    const live = await pool().query<{ id: string }>(
      'SELECT published_version_id AS id FROM kb_article',
    );
    expect(jobs.rows.map((job) => job.payload.versionId).toSorted()).toEqual(
      live.rows.map((row) => row.id).toSorted(),
    );
  });

  it('creates nothing the second time and never overwrites an edit', async () => {
    await pool().query(`UPDATE kb_article SET intent_tags = '{edited}' WHERE slug = 'seed-one'`);
    const result = await app.db.transaction((tx) => seedKbArticles(tx, articles));
    expect(result).toEqual({ created: [], existing: ['seed-one', 'seed-two'] });
    const { rows } = await pool().query(
      `SELECT intent_tags FROM kb_article WHERE slug = 'seed-one'`,
    );
    expect(rows[0]).toEqual({ intent_tags: ['edited'] });
    expect((await pool().query('SELECT 1 FROM kb_article_version')).rowCount).toBe(2);
    expect((await pool().query(`SELECT 1 FROM outbox WHERE queue = 'kb'`)).rowCount).toBe(2);
  });
});
