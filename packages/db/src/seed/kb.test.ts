import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_EXAMPLES_DIR, SeedError } from './common.js';
import { loadIntentDefinitions } from './intents.js';
import { loadKbArticleFiles, parseKbArticleFile } from './kb.js';

const GOOD = `---
slug: reset-your-password
title: Reset your password
lang: en
visibility: customer
tags: password_reset, account_access
---
# Reset your password

Open the sign-in page.
`;

describe('parseKbArticleFile', () => {
  it('reads the header and the body', () => {
    const article = parseKbArticleFile('a.md', GOOD);
    expect(article).toMatchObject({
      slug: 'reset-your-password',
      title: 'Reset your password',
      lang: 'en',
      kind: 'article',
      visibility: 'customer',
      intentTags: ['password_reset', 'account_access'],
      file: 'a.md',
    });
    expect(article.bodyMd).toBe('# Reset your password\n\nOpen the sign-in page.');
  });

  it('defaults to an internal article with no tags, and reads Windows line endings', () => {
    const article = parseKbArticleFile(
      'b.md',
      '---\r\nslug: notes\r\ntitle: Notes\r\nlang: th\r\n---\r\nข้อความ\r\n',
    );
    expect(article).toMatchObject({ visibility: 'internal', intentTags: [], lang: 'th' });
    expect(article.bodyMd).toBe('ข้อความ');
  });

  it('names the file when the header is missing, unknown, or invalid', () => {
    expect(() => parseKbArticleFile('c.md', 'no header')).toThrow(/c\.md needs a header/);
    expect(() => parseKbArticleFile('c.md', '---\nauthor: x\n---\nbody')).toThrow(
      /unknown header line "author"/,
    );
    expect(() =>
      parseKbArticleFile('c.md', '---\nslug: Bad Slug\ntitle: T\nlang: en\n---\nb'),
    ).toThrow(/c\.md is not a valid article.*slug/);
    expect(() => parseKbArticleFile('c.md', '---\nslug: ok\ntitle: T\nlang: fr\n---\nb')).toThrow(
      SeedError,
    );
  });

  it('refuses a visibility that needs real organization ids', () => {
    expect(() =>
      parseKbArticleFile('d.md', '---\nslug: ok\ntitle: T\nlang: en\nvisibility: orgs\n---\nb'),
    ).toThrow(/only internal and customer/);
  });
});

describe('loadKbArticleFiles', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wt-kb-seed-'));
    await writeFile(join(dir, 'b-second.md'), GOOD.replace('reset-your-password', 'second'));
    await writeFile(join(dir, 'a-first.md'), GOOD);
    await writeFile(join(dir, 'README.md'), '# not an article');
    await writeFile(join(dir, 'ignored.json'), '{}');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads *.md files in file-name order and skips the README', async () => {
    const articles = await loadKbArticleFiles(dir);
    expect(articles.map((article) => article.slug)).toEqual(['reset-your-password', 'second']);
  });

  it('treats a missing directory as no articles', async () => {
    expect(await loadKbArticleFiles(join(dir, 'does-not-exist'))).toEqual([]);
  });

  it('refuses two files with one slug', async () => {
    await writeFile(join(dir, 'c-repeat.md'), GOOD);
    await expect(loadKbArticleFiles(dir)).rejects.toThrow(/repeats the slug "reset-your-password"/);
    await rm(join(dir, 'c-repeat.md'));
  });
});

describe('the example articles of this repository (examples/kb)', () => {
  const load = () => loadKbArticleFiles(join(DEFAULT_EXAMPLES_DIR, 'kb'));

  it('are valid, in both languages, with internal runbooks and customer articles', async () => {
    const articles = await load();
    expect(articles.length).toBeGreaterThanOrEqual(5);
    expect(new Set(articles.map((article) => article.lang))).toEqual(new Set(['en', 'th']));
    expect(articles.some((article) => article.visibility === 'internal')).toBe(true);
    expect(articles.some((article) => article.visibility === 'customer')).toBe(true);
    expect(articles.some((article) => article.kind === 'runbook')).toBe(true);
  });

  it('tag only intents that the starter intents define', async () => {
    const intents = await loadIntentDefinitions(join(DEFAULT_EXAMPLES_DIR, 'intents'));
    const keys = new Set(intents.map((definition) => definition.key));
    for (const article of await load()) {
      for (const tag of article.intentTags) {
        expect(keys.has(tag), `${article.slug}: ${tag}`).toBe(true);
      }
    }
  });

  it('name no real company: the only addresses are example domains', async () => {
    for (const article of await load()) {
      for (const address of article.bodyMd.match(/[\w.+-]+@[\w.-]+/g) ?? []) {
        expect(address, article.slug).toMatch(/@example\.(com|org|net|test)$/);
      }
    }
  });
});
