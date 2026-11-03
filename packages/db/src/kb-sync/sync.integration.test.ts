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
