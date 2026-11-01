import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  KB_JOBS,
  KB_OUTBOX_JOB_OPTIONS,
  KB_QUEUES,
  createKbArticleSchema,
  type CreateKbArticle,
} from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import type { Database } from '../client.js';
import { enqueueOutbox } from '../outbox.js';
import { kbArticle, kbArticleVersion } from '../schema/kb.js';
import { SeedError } from './common.js';

/**
 * Example knowledge base articles (T-107) from `examples/kb/*.md`, for development and demos. A file
 * is a small header between `---` lines (`key: value`, tags separated by commas) followed by the
 * Markdown body:
 *
 *     ---
 *     slug: reset-your-password
 *     title: Reset your password
 *     lang: en
 *     visibility: customer
 *     tags: password_reset, account_access
 *     ---
 *     # Reset your password
 *     ...
 *
 * Only `internal` and `customer` articles can be seeded (an `orgs` article needs real organization
 * ids). Each new article is written as published, version 1, and an `embed_article` job goes to the
 * outbox in the same transaction: the worker chunks and embeds it, so the article becomes searchable
 * once a worker runs. Existing slugs are left alone, so the seed is idempotent and never overwrites
 * an edit. Production refuses the whole seed (`assertSeedAllowed`).
 */

export interface KbSeedArticle extends CreateKbArticle {
  /** The file it came from, for error messages. */
  readonly file: string;
}

export interface KbSeedResult {
  readonly created: readonly string[];
  readonly existing: readonly string[];
}

const HEADER_KEYS = new Set(['slug', 'title', 'lang', 'kind', 'visibility', 'tags']);

/** Parses one example file. Throws `SeedError` naming the file and the problem. */
export function parseKbArticleFile(file: string, text: string): KbSeedArticle {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (match === null) throw new SeedError(`${file} needs a header between --- lines`);
  const header = new Map<string, string>();
  for (const line of (match[1] ?? '').split('\n')) {
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    const key = colon === -1 ? '' : line.slice(0, colon).trim();
    if (!HEADER_KEYS.has(key)) throw new SeedError(`${file} has an unknown header line "${key}"`);
    header.set(key, line.slice(colon + 1).trim());
  }
  const visibility = header.get('visibility') ?? 'internal';
  if (visibility !== 'internal' && visibility !== 'customer') {
    throw new SeedError(`${file}: only internal and customer articles can be seeded`);
  }
  const parsed = createKbArticleSchema.safeParse({
    slug: header.get('slug'),
    title: header.get('title'),
    lang: header.get('lang'),
    kind: header.get('kind') ?? 'article',
    visibility,
    intentTags: (header.get('tags') ?? '')
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== ''),
    bodyMd: (match[2] ?? '').trim(),
  });
  if (!parsed.success) {
    const problems = parsed.error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new SeedError(`${file} is not a valid article: ${problems}`);
  }
  return { ...parsed.data, file };
}

/** Reads every `*.md` file of a directory, in file-name order. A missing directory means none. */
export async function loadKbArticleFiles(dir: string): Promise<KbSeedArticle[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.md') && name !== 'README.md');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
  const articles: KbSeedArticle[] = [];
  const slugs = new Set<string>();
  for (const name of names.toSorted()) {
    const article = parseKbArticleFile(name, await readFile(join(dir, name), 'utf8'));
    if (slugs.has(article.slug)) throw new SeedError(`${name} repeats the slug "${article.slug}"`);
    slugs.add(article.slug);
    articles.push(article);
  }
  return articles;
}

const hashOf = (title: string, bodyMd: string): string =>
  createHash('sha256').update(title, 'utf8').update('\u0000').update(bodyMd, 'utf8').digest('hex');

export async function seedKbArticles(
  tx: Pick<Database['db'], 'select' | 'insert'>,
  articles: readonly KbSeedArticle[],
): Promise<KbSeedResult> {
  const created: string[] = [];
  const existing: string[] = [];
  for (const article of articles) {
    const [found] = await tx
      .select({ id: kbArticle.id })
      .from(kbArticle)
      .where(eq(kbArticle.slug, article.slug))
      .limit(1);
    if (found !== undefined) {
      existing.push(article.slug);
      continue;
    }
    const articleId = randomUUID();
    const versionId = randomUUID();
    const now = new Date();
    await tx.insert(kbArticle).values({
      id: articleId,
      slug: article.slug,
      kind: article.kind,
      lang: article.lang,
      status: 'published',
      visibility: article.visibility,
      intentTags: article.intentTags,
      currentVersionId: versionId,
      publishedVersionId: versionId,
      publishedAt: now,
      lastVerifiedAt: now,
    });
    await tx.insert(kbArticleVersion).values({
      id: versionId,
      articleId,
      version: 1,
      title: article.title,
      bodyMd: article.bodyMd,
      changeNote: 'Example article from the development seed',
      contentHash: hashOf(article.title, article.bodyMd),
    });
    await enqueueOutbox(tx, {
      queue: KB_QUEUES.kb,
      jobName: KB_JOBS.embedArticle,
      jobId: `kb-embed-${versionId}-seed`,
      payload: { articleId, versionId },
      options: { ...KB_OUTBOX_JOB_OPTIONS },
    });
    created.push(article.slug);
  }
  return { created, existing };
}
