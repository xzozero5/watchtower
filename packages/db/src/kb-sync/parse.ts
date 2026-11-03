import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createKbArticleSchema } from '@watchtower/shared';

/**
 * The knowledge base folder (ADR-019): Markdown files kept outside the repository (the owner's
 * instance points `WATCHTOWER_KB_DIR` at it). A file is a header between `---` lines followed by the
 * Markdown body:
 *
 *     ---
 *     title: Reset your password        (required)
 *     slug: reset-your-password         (optional; default: the file name without .md)
 *     lang: en                          (en | th, default en)
 *     kind: article                     (article | runbook, default article)
 *     visibility: internal              (internal | customer | orgs, default internal)
 *     tags: password_reset, account     (intent tags; `[a, b]` also works)
 *     intent: password_reset            (one or more intent keys; merged into tags)
 *     orgs: Org A, Org B                (organization names; only for visibility: orgs)
 *     ---
 *     body...
 *
 * Parsing is pure (no database, no network) so it is unit tested without either.
 */

export class KbSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KbSyncError';
  }
}

export interface KbFolderArticle {
  /** Path relative to the folder, for messages. */
  readonly file: string;
  readonly slug: string;
  readonly title: string;
  readonly lang: 'en' | 'th';
  readonly kind: 'article' | 'runbook';
  readonly visibility: 'internal' | 'customer' | 'orgs';
  readonly intentTags: readonly string[];
  /** Organization names (resolved to ids by the sync). */
  readonly orgNames: readonly string[];
  readonly bodyMd: string;
}

const HEADER_KEYS = new Set([
  'title',
  'slug',
  'lang',
  'kind',
  'visibility',
  'tags',
  'intent',
  'orgs',
]);

const unquote = (value: string): string => {
  const v = value.trim();
  return v.length >= 2 && /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v;
};

const list = (value: string | undefined): string[] => {
  if (value === undefined) return [];
  const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  return inner
    .split(',')
    .map((item) => unquote(item))
    .filter((item) => item !== '');
};

/** `Reset Password.md` is not a slug; `reset-password` is. */
export const slugFromFile = (file: string): string =>
  (file.split('/').pop() ?? file)
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export function parseKbFile(file: string, text: string): KbFolderArticle {
  const unBommed = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const normalized = unBommed.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (match === null) throw new KbSyncError(`${file} needs a header between --- lines`);
  const header = new Map<string, string>();
  for (const line of (match[1] ?? '').split('\n')) {
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    const key = colon === -1 ? '' : line.slice(0, colon).trim();
    if (!HEADER_KEYS.has(key)) throw new KbSyncError(`${file} has an unknown header line "${key}"`);
    header.set(key, line.slice(colon + 1).trim());
  }
  const orgNames = list(header.get('orgs'));
  const intentTags = [...new Set([...list(header.get('tags')), ...list(header.get('intent'))])];
  const visibility = header.get('visibility') ?? 'internal';
  if (visibility !== 'orgs' && orgNames.length > 0) {
    throw new KbSyncError(`${file}: orgs is only for visibility: orgs`);
  }
  const parsed = createKbArticleSchema.safeParse({
    slug: unquote(header.get('slug') ?? slugFromFile(file)),
    title: unquote(header.get('title') ?? ''),
    lang: header.get('lang') ?? 'en',
    kind: header.get('kind') ?? 'article',
    visibility,
    // Names are resolved later; a placeholder id only satisfies "orgs needs at least one".
    orgIds: orgNames.map(() => '00000000-0000-4000-8000-000000000000'),
    intentTags,
    bodyMd: (match[2] ?? '').trim(),
  });
  if (!parsed.success) {
    const problems = parsed.error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new KbSyncError(`${file} is not a valid article: ${problems}`);
  }
  const data = parsed.data;
  return {
    file,
    slug: data.slug,
    title: data.title,
    lang: data.lang,
    kind: data.kind,
    visibility: data.visibility,
    intentTags: data.intentTags,
    orgNames,
    bodyMd: data.bodyMd,
  };
}

/** Same hash the seed uses for a version, so the two never disagree about "changed". */
export const contentHashOf = (title: string, bodyMd: string): string =>
  createHash('sha256').update(title, 'utf8').update('\u0000').update(bodyMd, 'utf8').digest('hex');

/** Every `*.md` under the folder (not README.md, not dot or underscore directories), sorted by path. */
export async function loadKbFolder(dir: string): Promise<KbFolderArticle[]> {
  const files: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(dir, relative), { withFileTypes: true });
    for (const entry of entries) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !entry.name.startsWith('_')) await walk(path);
      } else if (entry.isFile() && /\.md$/i.test(entry.name) && entry.name !== 'README.md') {
        files.push(path);
      }
    }
  };
  try {
    await walk('');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      throw new KbSyncError('the knowledge base folder does not exist');
    }
    throw error;
  }
  const articles: KbFolderArticle[] = [];
  const seen = new Map<string, string>();
  for (const file of files.toSorted()) {
    const article = parseKbFile(file, await readFile(join(dir, file), 'utf8'));
    const earlier = seen.get(article.slug);
    if (earlier !== undefined) {
      throw new KbSyncError(`${file} repeats the slug "${article.slug}" of ${earlier}`);
    }
    seen.set(article.slug, file);
    articles.push(article);
  }
  return articles;
}
