import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KbSyncError, contentHashOf, loadKbFolder, parseKbFile, slugFromFile } from './parse.js';

const GOOD = `---
title: "Rotate an API key"
lang: en
visibility: internal
tags: [api_key, security]
intent: key_rotation, api_key
---
# Rotate an API key

Steps go here.
`;

describe('parseKbFile', () => {
  it('reads the header, merges tags and intent, and takes the slug from the file name', () => {
    const article = parseKbFile('Rotate Key.md', GOOD);
    expect(article).toMatchObject({
      slug: 'rotate-key',
      title: 'Rotate an API key',
      lang: 'en',
      kind: 'article',
      visibility: 'internal',
      intentTags: ['api_key', 'security', 'key_rotation'],
      orgNames: [],
    });
    expect(article.bodyMd.startsWith('# Rotate an API key')).toBe(true);
  });

  it('accepts CRLF and a BOM, and an explicit slug', () => {
    const bom = String.fromCharCode(0xfeff);
    const article = parseKbFile(
      'x.md',
      `${bom}---\r\ntitle: T\r\nslug: my-slug\r\n---\r\nBody\r\n`,
    );
    expect(article).toMatchObject({ slug: 'my-slug', title: 'T', bodyMd: 'Body' });
  });

  it('reads org names for visibility orgs and refuses them otherwise', () => {
    const orgs = parseKbFile('a.md', '---\ntitle: A\nvisibility: orgs\norgs: Org A, Org B\n---\nx');
    expect(orgs.orgNames).toEqual(['Org A', 'Org B']);
    expect(() => parseKbFile('a.md', '---\ntitle: A\norgs: Org A\n---\nx')).toThrow(KbSyncError);
    expect(() => parseKbFile('a.md', '---\ntitle: A\nvisibility: orgs\n---\nx')).toThrow(
      /not a valid article/,
    );
  });

  it('refuses a missing header, a missing title, an unknown key and a bad tag', () => {
    expect(() => parseKbFile('a.md', 'no header')).toThrow(/header/);
    expect(() => parseKbFile('a.md', '---\nlang: en\n---\nx')).toThrow(/not a valid article/);
    expect(() => parseKbFile('a.md', '---\ntitle: A\nowner: me\n---\nx')).toThrow(/unknown header/);
    expect(() => parseKbFile('a.md', '---\ntitle: A\ntags: Bad Tag\n---\nx')).toThrow(
      /not a valid article/,
    );
  });
});

describe('slugFromFile and contentHashOf', () => {
  it('makes a kebab slug from a path', () => {
    expect(slugFromFile('runbooks/Reset__Password v2.md')).toBe('reset-password-v2');
  });
  it('hashes title and body together and deterministically', () => {
    expect(contentHashOf('a', 'b')).toBe(contentHashOf('a', 'b'));
    expect(contentHashOf('a', 'b')).not.toBe(contentHashOf('ab', ''));
    expect(contentHashOf('a', 'b')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('loadKbFolder', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wt-kb-'));
    await mkdir(join(dir, 'sub'));
    await mkdir(join(dir, '_drafts'));
    await writeFile(join(dir, 'README.md'), 'not an article');
    await writeFile(join(dir, 'one.md'), '---\ntitle: One\n---\nFirst');
    await writeFile(join(dir, 'sub', 'two.md'), '---\ntitle: Two\n---\nSecond');
    await writeFile(join(dir, '_drafts', 'skip.md'), 'ignored, no header');
    await writeFile(join(dir, 'notes.txt'), 'ignored');
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('reads articles in path order and skips README, underscore folders and other files', async () => {
    const articles = await loadKbFolder(dir);
    expect(articles.map((a) => [a.file, a.slug])).toEqual([
      ['one.md', 'one'],
      ['sub/two.md', 'two'],
    ]);
  });

  it('refuses a repeated slug and a missing folder', async () => {
    await writeFile(join(dir, 'sub', 'dup.md'), '---\ntitle: Dup\nslug: one\n---\nx');
    await expect(loadKbFolder(dir)).rejects.toThrow(/repeats the slug "one"/);
    await rm(join(dir, 'sub', 'dup.md'));
    await expect(loadKbFolder(join(dir, 'missing'))).rejects.toThrow(/does not exist/);
  });
});
