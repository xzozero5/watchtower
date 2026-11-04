import { randomUUID } from 'node:crypto';

import { KB_JOBS, KB_OUTBOX_JOB_OPTIONS, KB_QUEUES } from '@watchtower/shared';
import { and, desc, eq, inArray, like, ne } from 'drizzle-orm';

import type { Database } from '../client.js';
import { enqueueOutbox } from '../outbox.js';
import { kbArticle, kbArticleOrg, kbArticleVersion } from '../schema/kb.js';
import { organization } from '../schema/ticketing.js';
import { KbSyncError, contentHashOf, type KbFolderArticle } from './parse.js';

/**
 * Imports the articles of the knowledge base folder (ADR-019). Idempotent: running it twice changes
 * nothing the second time.
 *
 * - A new `internal` article is written published, version 1, and an `embed_article` job goes to the
 *   outbox in the same transaction (the worker chunks and embeds it; same path as the dev seed).
 * - A new `customer` or `orgs` article is written as a `draft`: text that customers may read is
 *   published by a person in the app, never by a file sync.
 * - A changed title or body adds the next version and makes it current. It goes live only for an
 *   `internal` article that is published; for any other it waits for a person to publish it.
 * - Visibility is never widened on an existing article (internal to customer or orgs): it is
 *   reported as `skipped` and has to be changed in the app. Narrowing is applied.
 * - A file that disappears deprecates the article it created (T-170); an empty folder deprecates nothing.
 */

export type KbSyncOutcome = 'created' | 'updated' | 'unchanged' | 'skipped' | 'deprecated';

export interface KbSyncEntry {
  readonly slug: string;
  readonly outcome: KbSyncOutcome;
  /** What happened beyond the outcome, for the log. Never article text. */
  readonly note?: string;
}

export interface KbSyncResult {
  readonly entries: readonly KbSyncEntry[];
}

const RANK = { internal: 0, orgs: 1, customer: 2 } as const;

type Tx = Pick<Database['db'], 'select' | 'insert' | 'update' | 'delete'>;

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].toSorted().join('\n') === [...b].toSorted().join('\n');

async function resolveOrgs(tx: Tx, names: readonly string[], file: string): Promise<string[]> {
  if (names.length === 0) return [];
  const rows = await tx
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .where(inArray(organization.name, [...names]));
  const byName = new Map(rows.map((row) => [row.name, row.id]));
  const missing = names.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new KbSyncError(`${file}: organization not found: ${missing.join(', ')}`);
  }
  return names.map((name) => byName.get(name) ?? '');
}

async function syncOne(tx: Tx, article: KbFolderArticle): Promise<KbSyncEntry> {
  const orgIds = await resolveOrgs(tx, article.orgNames, article.file);
  const hash = contentHashOf(article.title, article.bodyMd);
  const [existing] = await tx
    .select({
      id: kbArticle.id,
      status: kbArticle.status,
      visibility: kbArticle.visibility,
      kind: kbArticle.kind,
      lang: kbArticle.lang,
      intentTags: kbArticle.intentTags,
      publishedVersionId: kbArticle.publishedVersionId,
    })
    .from(kbArticle)
    .where(eq(kbArticle.slug, article.slug))
    .limit(1);
  const changeNote = `${IMPORT_NOTE_PREFIX}${article.file})`;
  const embed = (articleId: string, versionId: string) =>
    enqueueOutbox(tx, {
      queue: KB_QUEUES.kb,
      jobName: KB_JOBS.embedArticle,
      jobId: `kb-embed-${versionId}-sync`,
      payload: { articleId, versionId },
      options: { ...KB_OUTBOX_JOB_OPTIONS },
    });

  if (existing === undefined) {
    const articleId = randomUUID();
    const versionId = randomUUID();
    const live = article.visibility === 'internal';
    const now = new Date();
    await tx.insert(kbArticle).values({
      id: articleId,
      slug: article.slug,
      kind: article.kind,
      lang: article.lang,
      status: live ? 'published' : 'draft',
      visibility: article.visibility,
      intentTags: [...article.intentTags],
      currentVersionId: versionId,
      publishedVersionId: live ? versionId : null,
      publishedAt: live ? now : null,
      lastVerifiedAt: live ? now : null,
    });
    await tx.insert(kbArticleVersion).values({
      id: versionId,
      articleId,
      version: 1,
      title: article.title,
      bodyMd: article.bodyMd,
      changeNote,
      contentHash: hash,
    });
    if (orgIds.length > 0) {
      await tx.insert(kbArticleOrg).values(orgIds.map((orgId) => ({ articleId, orgId })));
    }
    if (live) await embed(articleId, versionId);
    return {
      slug: article.slug,
      outcome: 'created',
      ...(live ? {} : { note: 'draft: a person publishes customer-visible text' }),
    };
  }

  const [latest] = await tx
    .select({
      id: kbArticleVersion.id,
      version: kbArticleVersion.version,
      hash: kbArticleVersion.contentHash,
    })
    .from(kbArticleVersion)
    .where(eq(kbArticleVersion.articleId, existing.id))
    .orderBy(desc(kbArticleVersion.version))
    .limit(1);
  if (latest === undefined) {
    throw new KbSyncError(`${article.file}: article "${article.slug}" has no version`);
  }
  const currentOrgs = (
    await tx
      .select({ orgId: kbArticleOrg.orgId })
      .from(kbArticleOrg)
      .where(eq(kbArticleOrg.articleId, existing.id))
  ).map((row) => row.orgId);

  const widens = RANK[article.visibility] > RANK[existing.visibility as keyof typeof RANK];
  const visibility = widens ? existing.visibility : article.visibility;
  const orgsChanged = !widens && !sameSet(currentOrgs, orgIds);
  const textChanged = latest.hash !== hash;
  const metaChanged =
    visibility !== existing.visibility ||
    existing.kind !== article.kind ||
    existing.lang !== article.lang ||
    !sameSet(existing.intentTags, article.intentTags);

  if (!textChanged && !metaChanged && !orgsChanged) {
    return widens
      ? {
          slug: article.slug,
          outcome: 'skipped',
          note: 'visibility would widen: change it in the app',
        }
      : { slug: article.slug, outcome: 'unchanged' };
  }

  let versionId = latest.id;
  let goesLive = false;
  if (textChanged) {
    versionId = randomUUID();
    await tx.insert(kbArticleVersion).values({
      id: versionId,
      articleId: existing.id,
      version: latest.version + 1,
      title: article.title,
      bodyMd: article.bodyMd,
      changeNote,
      contentHash: hash,
    });
    // Only internal text that is already live goes live by itself.
    goesLive = existing.status === 'published' && visibility === 'internal';
  }
  await tx
    .update(kbArticle)
    .set({
      visibility,
      kind: article.kind,
      lang: article.lang,
      intentTags: [...article.intentTags],
      ...(textChanged ? { currentVersionId: versionId } : {}),
      ...(goesLive ? { publishedVersionId: versionId, lastVerifiedAt: new Date() } : {}),
    })
    .where(eq(kbArticle.id, existing.id));
  if (orgsChanged) {
    await tx.delete(kbArticleOrg).where(eq(kbArticleOrg.articleId, existing.id));
    if (orgIds.length > 0) {
      await tx
        .insert(kbArticleOrg)
        .values(orgIds.map((orgId) => ({ articleId: existing.id, orgId })));
    }
  }
  if (goesLive) await embed(existing.id, versionId);
  const notes = [
    textChanged && !goesLive ? 'new version waits for a person to publish it' : null,
    widens ? 'visibility would widen: change it in the app' : null,
  ].filter((note): note is string => note !== null);
  return {
    slug: article.slug,
    outcome: 'updated',
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
  };
}

/** The change note every version written by this import starts with; also how a folder article is recognised. */
const IMPORT_NOTE_PREFIX = 'Imported from the knowledge base folder (';

/**
 * A file that disappeared from the folder deprecates its article (T-170): the folder is the source of
 * the articles it created, so removing the file takes the text out of search. Only articles this
 * import created (their version 1 carries the import note) are touched, never one written in the app.
 * A live article asks the worker to drop its chunks, like deprecating it in the app does.
 */
async function deprecateRemoved(tx: Tx, keep: ReadonlySet<string>): Promise<KbSyncEntry[]> {
  const imported = await tx
    .select({
      id: kbArticle.id,
      slug: kbArticle.slug,
      status: kbArticle.status,
      currentVersionId: kbArticle.currentVersionId,
    })
    .from(kbArticle)
    .innerJoin(kbArticleVersion, eq(kbArticleVersion.articleId, kbArticle.id))
    .where(
      and(
        eq(kbArticleVersion.version, 1),
        like(kbArticleVersion.changeNote, `${IMPORT_NOTE_PREFIX}%`),
        ne(kbArticle.status, 'deprecated'),
      ),
    );
  const entries: KbSyncEntry[] = [];
  for (const row of imported) {
    if (keep.has(row.slug)) continue;
    await tx
      .update(kbArticle)
      .set({
        status: 'deprecated',
        reviewVersionId: null,
        publishedVersionId: null,
        updatedAt: new Date(),
      })
      .where(eq(kbArticle.id, row.id));
    if (row.status === 'published') {
      await enqueueOutbox(tx, {
        queue: KB_QUEUES.kb,
        jobName: KB_JOBS.embedArticle,
        jobId: `kb-embed-${row.currentVersionId}-deprecated-${String(Date.now())}`,
        payload: { articleId: row.id, versionId: row.currentVersionId },
        options: { ...KB_OUTBOX_JOB_OPTIONS },
      });
    }
    entries.push({
      slug: row.slug,
      outcome: 'deprecated',
      note: 'file is gone from the folder',
    });
  }
  return entries;
}

/**
 * Runs the whole import in one transaction: a bad file leaves the database as it was.
 * An empty folder deprecates nothing (a wrong or unmounted path must not wipe the knowledge base).
 */
export async function syncKbArticles(
  database: Pick<Database, 'db'>,
  articles: readonly KbFolderArticle[],
): Promise<KbSyncResult> {
  return database.db.transaction(async (tx) => {
    const entries: KbSyncEntry[] = [];
    for (const article of articles) entries.push(await syncOne(tx, article));
    if (articles.length > 0) {
      entries.push(...(await deprecateRemoved(tx, new Set(articles.map((a) => a.slug)))));
    }
    return { entries };
  });
}
