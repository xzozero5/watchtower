import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../client.js';
import { createTestDatabase, type TestDatabase } from '../testing.js';
import { parseKbFile } from './parse.js';
import { syncKbArticles } from './sync.js';

// The knowledge base folder import (ADR-019), against the compose Postgres or any Postgres in TEST_DATABASE_URL.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
let app: Database;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = createDatabase({ url: testDb.appUrl, max: 2, applicationName: 'wt-kb-sync-test' });
});
afterAll(async () => {
  await app.close();
  await testDb.cleanup();
});

const pool = () => testDb.owner.pool;
const file = (name: string, header: string, body: string) =>
  parseKbFile(`${name}.md`, `---\ntitle: ${name}\n${header}\n---\n${body}`);
const outcomes = async (...articles: ReturnType<typeof file>[]) =>
  (await syncKbArticles(app, articles)).entries.map((e) => `${e.slug}:${e.outcome}`);
const jobs = async () =>
  (
    await pool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE job_name = 'embed_article'`,
    )
  ).rows[0]?.n;

describe('syncKbArticles', () => {
  it('creates an internal article as published and an unreviewed customer article as draft', async () => {
    const internal = file('int-one', 'visibility: internal\ntags: probe_tag', 'Body one');
    const customer = file('cust-one', 'visibility: customer', 'Body two');
    expect(await outcomes(internal, customer)).toEqual(['int-one:created', 'cust-one:created']);
    const { rows } = await pool().query(
      `SELECT slug, status, visibility, published_version_id IS NOT NULL AS live, intent_tags
         FROM kb_article WHERE slug IN ('int-one', 'cust-one') ORDER BY slug`,
    );
    expect(rows).toEqual([
      { slug: 'cust-one', status: 'draft', visibility: 'customer', live: false, intent_tags: [] },
      {
        slug: 'int-one',
        status: 'published',
        visibility: 'internal',
        live: true,
        intent_tags: ['probe_tag'],
      },
    ]);
    expect(await jobs()).toBe(1);
  });

  it('is idempotent: a second run changes and queues nothing', async () => {
    const internal = file('int-one', 'visibility: internal\ntags: probe_tag', 'Body one');
    const customer = file('cust-one', 'visibility: customer', 'Body two');
    expect(await outcomes(internal, customer)).toEqual(['int-one:unchanged', 'cust-one:unchanged']);
    expect(await jobs()).toBe(1);
    const { rows } = await pool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM kb_article_version`,
    );
    expect(rows[0]?.n).toBe(2);
  });

  it('adds a version for changed text; internal goes live and is queued, customer does not', async () => {
    expect(
      await outcomes(
        file('int-one', 'visibility: internal\ntags: probe_tag', 'Body one, edited'),
        file('cust-one', 'visibility: customer', 'Body two, edited'),
      ),
    ).toEqual(['int-one:updated', 'cust-one:updated']);
    const { rows } = await pool().query(
      `SELECT a.slug, v.version AS current, p.version AS published
         FROM kb_article a
         JOIN kb_article_version v ON v.id = a.current_version_id
         LEFT JOIN kb_article_version p ON p.id = a.published_version_id
        WHERE a.slug IN ('int-one', 'cust-one') ORDER BY a.slug`,
    );
    expect(rows).toEqual([
      { slug: 'cust-one', current: 2, published: null },
      { slug: 'int-one', current: 2, published: 2 },
    ]);
    expect(await jobs()).toBe(2);
  });

  it('never widens the visibility of an existing article', async () => {
    const [entry] = (
      await syncKbArticles(app, [
        file('int-one', 'visibility: customer\ntags: probe_tag', 'Body one, edited'),
      ])
    ).entries;
    expect(entry).toMatchObject({ slug: 'int-one', outcome: 'skipped' });
    const { rows } = await pool().query<{ visibility: string }>(
      `SELECT visibility FROM kb_article WHERE slug = 'int-one'`,
    );
    expect(rows[0]?.visibility).toBe('internal');
  });

  it('deprecates the article of a file that is gone, only ones the import created (T-170)', async () => {
    const keep = file('gone-keep', 'visibility: internal', 'stays');
    const gone = file('gone-go', 'visibility: internal', 'leaves');
    await syncKbArticles(app, [keep, gone]);
    // An article written in the app, not by the import, is never touched.
    await pool().query(
      `INSERT INTO kb_article (id, slug, kind, lang, status, visibility)
       VALUES (gen_random_uuid(), 'gone-app', 'howto', 'en', 'published', 'internal')`,
    );
    const before = await jobs();
    const result = await syncKbArticles(app, [keep]);
    expect(result.entries.map((e) => `${e.slug}:${e.outcome}`)).toEqual([
      'gone-keep:unchanged',
      'gone-go:deprecated',
    ]);
    const { rows } = await pool().query(
      `SELECT slug, status, published_version_id IS NOT NULL AS live
         FROM kb_article WHERE slug LIKE 'gone-%' ORDER BY slug`,
    );
    expect(rows).toEqual([
      { slug: 'gone-app', status: 'published', live: false },
      { slug: 'gone-go', status: 'deprecated', live: false },
      { slug: 'gone-keep', status: 'published', live: true },
    ]);
    // The worker is asked to drop the chunks of the live article it took down.
    expect(await jobs()).toBe((before ?? 0) + 1);
    // Idempotent, and an empty folder deprecates nothing.
    expect((await syncKbArticles(app, [keep])).entries.map((e) => e.outcome)).toEqual([
      'unchanged',
    ]);
    expect((await syncKbArticles(app, [])).entries).toEqual([]);
    const { rows: still } = await pool().query(
      `SELECT status FROM kb_article WHERE slug = 'gone-keep'`,
    );
    expect(still).toEqual([{ status: 'published' }]);
  });

  it('rolls everything back when one file names an unknown organization', async () => {
    await expect(
      syncKbArticles(app, [
        file('rb-one', 'visibility: internal', 'x'),
        file('rb-two', 'visibility: orgs\norgs: No Such Organization', 'y'),
      ]),
    ).rejects.toThrow(/organization not found/);
    const { rows } = await pool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM kb_article WHERE slug = 'rb-one'`,
    );
    expect(rows[0]?.n).toBe(0);
  });
});
