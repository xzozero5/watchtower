import { schema } from '@watchtower/db';
import { KB_JOBS, QUEUE_NAMES, type CreateKbArticle } from '@watchtower/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DomainError } from '../errors.js';
import {
  addOrg,
  addStaff,
  auditRows,
  startDomainTest,
  type DomainTestEnv,
} from '../testing/support.js';
import {
  articlesNeedingEmbedding,
  dropArticleChunksIfNotLive,
  ensureActiveEmbeddingIndex,
  readActiveEmbeddingIndex,
  replaceArticleChunks,
} from './chunks.js';
import { searchKb, type KbAudience } from './search.js';

let env: DomainTestEnv;
let author: Awaited<ReturnType<typeof addStaff>>;
let lead: Awaited<ReturnType<typeof addStaff>>;
let slugCounter = 0;

beforeAll(async () => {
  env = await startDomainTest();
  author = await addStaff(env, 'agent');
  lead = await addStaff(env, 'lead');
});
afterAll(async () => {
  await env.close();
});

const pool = () => env.db.owner.pool;

const input = (fields: Partial<CreateKbArticle> = {}): CreateKbArticle => {
  slugCounter += 1;
  return {
    slug: `article-${String(slugCounter)}`,
    title: 'Title',
    bodyMd: 'Body',
    lang: 'en',
    kind: 'article',
    visibility: 'internal',
    orgIds: [],
    intentTags: [],
    sources: [],
    ...fields,
  };
};

const create = async (fields: Partial<CreateKbArticle> = {}) =>
  (await env.tx((tx) => env.domain.kb.create(tx, env.ctx(author.actor), input(fields)))).value;

const update = (
  articleId: string,
  patch: Parameters<typeof env.domain.kb.update>[2]['patch'],
  canApprove = false,
  by: typeof author = author,
) => env.tx((tx) => env.domain.kb.update(tx, env.ctx(by.actor), { articleId, patch, canApprove }));

/** The audience of an article as an approver sees it on screen. */
const audienceOf = async (articleId: string) => {
  const row = await articleRow(articleId);
  const { rows } = await pool().query<{ org_id: string }>(
    'SELECT org_id FROM kb_article_org WHERE article_id = $1',
    [articleId],
  );
  return {
    visibility: row.visibility as 'internal' | 'customer' | 'orgs',
    orgIds: rows.map((r) => r.org_id),
  };
};

/**
 * Sends the latest version for review, as the web does: a draft becomes `in_review`; a live article
 * stays live and names the version in `review_version_id`. Nothing happens if it is already so.
 */
const sendForReview = async (articleId: string, by = author) => {
  const row = await articleRow(articleId);
  const liveNeedsRequest =
    row.status === 'published' &&
    row.publishedVersionId !== row.currentVersionId &&
    row.reviewVersionId !== row.currentVersionId;
  if (row.status === 'draft' || liveNeedsRequest) {
    await env.tx((tx) =>
      env.domain.kb.transition(tx, env.ctx(by.actor), { articleId, to: 'in_review' }),
    );
  }
};

/** Publishes the way the web does: the author sends it for review, an approver publishes what they saw. */
const publish = async (articleId: string, version: number, by = lead) => {
  await sendForReview(articleId);
  const audience = await audienceOf(articleId);
  return env.tx((tx) =>
    env.domain.kb.publish(tx, env.ctx(by.actor), { articleId, version, audience }),
  );
};

const transition = (articleId: string, to: 'draft' | 'in_review' | 'deprecated') =>
  env.tx((tx) => env.domain.kb.transition(tx, env.ctx(lead.actor), { articleId, to }));

const articleRow = async (id: string) => {
  const [row] = await env.db.owner.db
    .select()
    .from(schema.kbArticle)
    .where(eq(schema.kbArticle.id, id));
  if (row === undefined) throw new Error('no article');
  return row;
};

const refusal = async (work: Promise<unknown>): Promise<DomainError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

describe('kb.create', () => {
  it('writes a draft with version 1, the author and one audit row', async () => {
    const created = await env.tx((tx) =>
      env.domain.kb.create(
        tx,
        env.ctx(author.actor),
        input({ title: 'Reset', intentTags: ['password_reset'] }),
      ),
    );
    expect(created.audited).toBe(true);
    expect(created.value).toMatchObject({ version: 1, changed: true });
    const row = await articleRow(created.value.articleId);
    expect(row).toMatchObject({
      status: 'draft',
      visibility: 'internal',
      authorId: author.id,
      currentVersionId: created.value.versionId,
      publishedVersionId: null,
      intentTags: ['password_reset'],
    });
    const audit = (await auditRows(env, 'kb.article.create')).filter(
      (entry) => entry.targetId === created.value.articleId,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorId).toBe(author.id);
  });

  it('refuses a slug that is taken with a conflict, and rolls the attempt back', async () => {
    const first = input();
    await env.tx((tx) => env.domain.kb.create(tx, env.ctx(author.actor), first));
    const error = await refusal(
      env.tx((tx) => env.domain.kb.create(tx, env.ctx(author.actor), { ...first, title: 'Other' })),
    );
    expect(error.code).toBe('conflict');
    const { rows } = await pool().query('SELECT 1 FROM kb_article WHERE slug = $1', [first.slug]);
    expect(rows).toHaveLength(1);
  });

  it('keeps the organizations of an "orgs" article, and refuses none or an unknown one', async () => {
    const org = await addOrg(env);
    const made = await create({ visibility: 'orgs', orgIds: [org.id] });
    const { rows } = await pool().query('SELECT org_id FROM kb_article_org WHERE article_id = $1', [
      made.articleId,
    ]);
    expect(rows).toEqual([{ org_id: org.id }]);
    expect((await refusal(create({ visibility: 'orgs', orgIds: [] }))).code).toBe('bad_request');
    expect(
      (
        await refusal(
          create({ visibility: 'orgs', orgIds: ['5b0b8f0e-6c6e-4f5e-9d6e-1b2c3d4e5f60'] }),
        )
      ).code,
    ).toBe('bad_request');
  });
});

describe('kb.update', () => {
  it('adds an immutable version for a change of text and leaves what is live alone', async () => {
    const made = await create({ title: 'First', bodyMd: 'one' });
    await publish(made.articleId, 1);
    const edited = await update(made.articleId, { bodyMd: 'two', changeNote: 'fix' });
    expect(edited.value).toMatchObject({ version: 2, changed: true });
    const row = await articleRow(made.articleId);
    expect(row.currentVersionId).toBe(edited.value.versionId);
    expect(row.publishedVersionId).toBe(made.versionId);
    expect(row.status).toBe('published');
    const { rows } = await pool().query(
      'SELECT version, body_md, change_note FROM kb_article_version WHERE article_id = $1 ORDER BY version',
      [made.articleId],
    );
    expect(rows).toEqual([
      { version: 1, body_md: 'one', change_note: null },
      { version: 2, body_md: 'two', change_note: 'fix' },
    ]);
  });

  it('changes nothing, writes nothing, when the text and metadata are the same', async () => {
    const made = await create({ title: 'Same', bodyMd: 'same', intentTags: ['a_tag'] });
    const before = (await auditRows(env, 'kb.article.update')).length;
    const result = await update(made.articleId, {
      title: 'Same',
      bodyMd: 'same',
      intentTags: ['a_tag'],
    });
    expect(result.value).toMatchObject({ version: 1, changed: false });
    expect(result.audited).toBe(false);
    expect((await auditRows(env, 'kb.article.update')).length).toBe(before);
  });

  it('changes metadata without a new version', async () => {
    const made = await create();
    const verified = '2026-10-01T00:00:00.000Z';
    const result = await update(made.articleId, {
      intentTags: ['billing'],
      lastVerifiedAt: verified,
      kind: 'runbook',
    });
    expect(result.value).toMatchObject({ version: 1, changed: true });
    expect(await articleRow(made.articleId)).toMatchObject({
      intentTags: ['billing'],
      kind: 'runbook',
      lastVerifiedAt: new Date(verified),
    });
  });

  it('refuses an edit made on top of an older version (409)', async () => {
    const made = await create();
    await update(made.articleId, { bodyMd: 'v2' });
    const error = await refusal(update(made.articleId, { bodyMd: 'v3', expectedVersion: 1 }));
    expect(error.code).toBe('conflict');
    expect((await update(made.articleId, { bodyMd: 'v3', expectedVersion: 2 })).value.version).toBe(
      3,
    );
  });

  it('refuses to edit a deprecated article', async () => {
    const made = await create();
    await transition(made.articleId, 'deprecated');
    expect((await refusal(update(made.articleId, { bodyMd: 'late' }))).code).toBe('conflict');
  });

  it('lets only an approver show a published article to more people, but anyone pull it back', async () => {
    const org = await addOrg(env);
    const made = await create({ bodyMd: 'text' });
    await publish(made.articleId, 1);
    const denied = await refusal(update(made.articleId, { visibility: 'customer' }));
    expect(denied.code).toBe('policy_denied');
    expect(denied.details).toMatchObject({ reason: 'kb_audience_requires_approval' });
    expect((await articleRow(made.articleId)).visibility).toBe('internal');

    // An approver who did not write the article widens it (the author with kb.approve cannot: see below).
    await update(made.articleId, { visibility: 'customer' }, true, lead);
    expect((await articleRow(made.articleId)).visibility).toBe('customer');
    // Narrowing needs no approver.
    await update(made.articleId, { visibility: 'orgs', orgIds: [org.id] });
    expect((await articleRow(made.articleId)).visibility).toBe('orgs');
    await update(made.articleId, { visibility: 'internal' });
    expect((await articleRow(made.articleId)).visibility).toBe('internal');
    const { rows } = await pool().query('SELECT 1 FROM kb_article_org WHERE article_id = $1', [
      made.articleId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('refuses to widen the audience without an approver at any status, and lets an approver do it', async () => {
    for (const status of ['draft', 'in_review'] as const) {
      const made = await create({ bodyMd: 'internal procedure' });
      if (status === 'in_review') await transition(made.articleId, 'in_review');
      const denied = await refusal(update(made.articleId, { visibility: 'customer' }));
      expect(denied.code, status).toBe('policy_denied');
      expect(denied.details).toMatchObject({ reason: 'kb_audience_requires_approval' });
      expect((await articleRow(made.articleId)).visibility).toBe('internal');
      await update(made.articleId, { visibility: 'customer' }, true);
      expect((await articleRow(made.articleId)).visibility).toBe('customer');
    }
  });

  describe('widening a live article (P2-B)', () => {
    const widenAudit = async (articleId: string) =>
      (await auditRows(env, 'kb.article.audience_widen')).filter((a) => a.targetId === articleId);

    it('refuses an approver who wrote a version, and lets another approver do it with its own audit action', async () => {
      const made = await create({ bodyMd: 'live internal text' });
      await publish(made.articleId, 1);
      // The author holds kb.approve here, yet wrote version 1.
      const denied = await refusal(update(made.articleId, { visibility: 'customer' }, true));
      expect(denied.code).toBe('policy_denied');
      expect(denied.details).toMatchObject({ reason: 'kb_audience_widen_by_author' });
      expect((await articleRow(made.articleId)).visibility).toBe('internal');
      expect(await widenAudit(made.articleId)).toHaveLength(0);

      // The publisher wrote nothing, so they may: audited as audience_widen, not as a plain update.
      await update(made.articleId, { visibility: 'customer' }, true, lead);
      expect((await articleRow(made.articleId)).visibility).toBe('customer');
      const rows = await widenAudit(made.articleId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actorId).toBe(lead.id);
      expect(rows[0]?.metadata).toMatchObject({ status: 'published' });
    });

    it('also refuses an approver who edits the text in the same request, and one who wrote an older version', async () => {
      const made = await create({ bodyMd: 'live internal text' });
      await publish(made.articleId, 1);
      const sameRequest = await refusal(
        update(made.articleId, { visibility: 'customer', bodyMd: 'and a new line' }, true, lead),
      );
      expect(sameRequest.details).toMatchObject({ reason: 'kb_audience_widen_by_author' });
      expect((await articleRow(made.articleId)).visibility).toBe('internal');
      // Once the lead has written a version (a plain edit), they are an author too.
      await update(made.articleId, { bodyMd: 'a tweak by the lead' }, true, lead);
      const later = await refusal(update(made.articleId, { visibility: 'customer' }, true, lead));
      expect(later.details).toMatchObject({ reason: 'kb_audience_widen_by_author' });
      expect(await widenAudit(made.articleId)).toHaveLength(0);
    });

    it('does not change a draft, narrowing, or a metadata edit that does not widen', async () => {
      const draft = await create({ bodyMd: 'draft text' });
      // A draft is not live: an approver who wrote it may still choose its audience; the publisher
      // is bound to the audience they saw.
      await update(draft.articleId, { visibility: 'customer' }, true);
      expect((await articleRow(draft.articleId)).visibility).toBe('customer');
      expect(await widenAudit(draft.articleId)).toHaveLength(0);
      const live = await create({ bodyMd: 'live', visibility: 'customer' });
      await publish(live.articleId, 1);
      await update(live.articleId, { visibility: 'internal' }, false);
      await update(live.articleId, { intentTags: ['x'] }, false);
      expect(await widenAudit(live.articleId)).toHaveLength(0);
    });
  });
});

describe('kb.transition', () => {
  it('goes draft to in_review and back, and refuses a move that is not on the map', async () => {
    const made = await create();
    expect((await transition(made.articleId, 'in_review')).value.changed).toBe(true);
    expect((await articleRow(made.articleId)).status).toBe('in_review');
    expect((await transition(made.articleId, 'in_review')).value.changed).toBe(false);
    await transition(made.articleId, 'draft');
    await transition(made.articleId, 'deprecated');
    expect((await refusal(transition(made.articleId, 'in_review'))).code).toBe(
      'invalid_transition',
    );
    await transition(made.articleId, 'draft');
    expect((await articleRow(made.articleId)).status).toBe('draft');
  });

  it('takes a published article out of search at once and queues the chunk cleanup', async () => {
    const made = await create();
    await publish(made.articleId, 1);
    await transition(made.articleId, 'deprecated');
    const row = await articleRow(made.articleId);
    expect(row).toMatchObject({ status: 'deprecated', publishedVersionId: null });
    const { rows } = await pool().query<{ job_name: string }>(
      `SELECT job_name FROM outbox WHERE queue = $1 AND payload->>'articleId' = $2 ORDER BY created_at`,
      [QUEUE_NAMES.kb, made.articleId],
    );
    expect(rows.map((job) => job.job_name)).toEqual([KB_JOBS.embedArticle, KB_JOBS.embedArticle]);
  });
});

describe('kb.publish', () => {
  it('puts the latest version live, records the approver and queues the embed job', async () => {
    const made = await create({ bodyMd: 'live text' });
    const result = await publish(made.articleId, 1);
    expect(result.value).toMatchObject({ version: 1, changed: true });
    const row = await articleRow(made.articleId);
    expect(row).toMatchObject({
      status: 'published',
      publishedVersionId: made.versionId,
      reviewerId: lead.id,
    });
    expect(row.publishedAt).toBeInstanceOf(Date);
    const { rows } = await pool().query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox WHERE queue = $1 AND job_name = $2 AND payload->>'articleId' = $3`,
      [QUEUE_NAMES.kb, KB_JOBS.embedArticle, made.articleId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ articleId: made.articleId, versionId: made.versionId });
    expect(
      (await auditRows(env, 'kb.article.publish')).filter((a) => a.targetId === made.articleId),
    ).toHaveLength(1);
  });

  it('refuses a version that is not the latest, so no one publishes unseen text', async () => {
    const made = await create();
    await update(made.articleId, { bodyMd: 'second' });
    expect((await refusal(publish(made.articleId, 1))).code).toBe('conflict');
    expect((await articleRow(made.articleId)).status).toBe('in_review');
    expect((await publish(made.articleId, 2)).value.version).toBe(2);
  });

  it('is idempotent for what is already live, and publishes a later edit', async () => {
    const made = await create();
    await publish(made.articleId, 1);
    const again = await publish(made.articleId, 1);
    expect(again.value.changed).toBe(false);
    expect(again.audited).toBe(false);
    await update(made.articleId, { bodyMd: 'newer' });
    const later = await publish(made.articleId, 2);
    expect(later.value.changed).toBe(true);
    expect((await articleRow(made.articleId)).publishedVersionId).toBe(later.value.versionId);
  });

  it('refuses a deprecated article', async () => {
    const made = await create();
    await transition(made.articleId, 'deprecated');
    expect((await refusal(publish(made.articleId, 1))).code).toBe('invalid_transition');
  });
});

describe('kb.publish: the approver publishes what they saw', () => {
  it('refuses to publish when the audience was widened after the approver looked (409)', async () => {
    // The reported scenario: reviewed as internal, an agent widens it, the approver publishes.
    const made = await create({ bodyMd: 'reviewed as internal' });
    await transition(made.articleId, 'in_review');
    const seen = await audienceOf(made.articleId);
    expect(seen.visibility).toBe('internal');
    // The agent has no approval: the widening itself is refused ...
    expect((await refusal(update(made.articleId, { visibility: 'customer' }))).code).toBe(
      'policy_denied',
    );
    // ... and an approver widening it meanwhile (another tab) makes the first approver's view stale.
    await update(made.articleId, { visibility: 'customer' }, true);
    const stale = await refusal(
      env.tx((tx) =>
        env.domain.kb.publish(tx, env.ctx(lead.actor), {
          articleId: made.articleId,
          version: 1,
          audience: seen,
        }),
      ),
    );
    expect(stale.code).toBe('conflict');
    expect((await articleRow(made.articleId)).status).toBe('in_review');
    // Looking again and publishing the audience as it is now works.
    expect((await publish(made.articleId, 1)).value.changed).toBe(true);
    expect((await articleRow(made.articleId)).visibility).toBe('customer');
  });

  it('compares organizations too, in any order', async () => {
    const orgs = [(await addOrg(env)).id, (await addOrg(env)).id];
    const made = await create({ visibility: 'orgs', orgIds: [orgs[0] ?? ''] });
    await transition(made.articleId, 'in_review');
    const publishAs = (audience: { visibility: 'orgs'; orgIds: string[] }) =>
      env.tx((tx) =>
        env.domain.kb.publish(tx, env.ctx(lead.actor), {
          articleId: made.articleId,
          version: 1,
          audience,
        }),
      );
    expect((await refusal(publishAs({ visibility: 'orgs', orgIds: orgs }))).code).toBe('conflict');
    expect((await refusal(publishAs({ visibility: 'orgs', orgIds: [] }))).code).toBe('conflict');
    expect((await publishAs({ visibility: 'orgs', orgIds: [orgs[0] ?? ''] })).value.changed).toBe(
      true,
    );
  });
});

describe('kb.publish: segregation of duties', () => {
  const raw = (articleId: string, by: typeof lead, version = 1) =>
    audienceOf(articleId).then((audience) =>
      env.tx((tx) =>
        env.domain.kb.publish(tx, env.ctx(by.actor), { articleId, version, audience }),
      ),
    );

  let second: Awaited<ReturnType<typeof addStaff>>;
  beforeAll(async () => {
    second = await addStaff(env, 'lead');
  });

  it('does not publish from draft: it has to be sent for review first', async () => {
    const made = await create();
    const error = await refusal(raw(made.articleId, lead));
    expect(error.code).toBe('invalid_transition');
    expect((await articleRow(made.articleId)).status).toBe('draft');
    await transition(made.articleId, 'in_review');
    expect((await raw(made.articleId, lead)).value.changed).toBe(true);
  });

  it('does not let the author publish what they wrote', async () => {
    const made = await create();
    await transition(made.articleId, 'in_review');
    const error = await refusal(raw(made.articleId, author));
    expect(error.code).toBe('policy_denied');
    expect(error.details).toMatchObject({ reason: 'kb_publisher_is_author' });
    expect((await articleRow(made.articleId)).status).toBe('in_review');
  });

  it('makes the approver who edits during review the author, so another approver publishes', async () => {
    const made = await create({ bodyMd: 'draft text' });
    await transition(made.articleId, 'in_review');
    // The lead tweaks the text during review: version 2 is theirs.
    await env.tx((tx) =>
      env.domain.kb.update(tx, env.ctx(lead.actor), {
        articleId: made.articleId,
        patch: { bodyMd: 'lead tweak' },
        canApprove: true,
      }),
    );
    const own = await refusal(raw(made.articleId, lead, 2));
    expect(own.details).toMatchObject({ reason: 'kb_publisher_is_author' });
    expect((await raw(made.articleId, second, 2)).value.changed).toBe(true);
    expect((await articleRow(made.articleId)).reviewerId).toBe(second.id);
  });

  it('counts every version since the live one, not only the latest', async () => {
    const made = await create({ bodyMd: 'v1' });
    await transition(made.articleId, 'in_review');
    await raw(made.articleId, lead);
    // lead writes v2, the author writes v3: lead still wrote part of what would go live.
    await env.tx((tx) =>
      env.domain.kb.update(tx, env.ctx(lead.actor), {
        articleId: made.articleId,
        patch: { bodyMd: 'v2 by lead' },
        canApprove: true,
      }),
    );
    await update(made.articleId, { bodyMd: 'v3 by author' });
    await sendForReview(made.articleId);
    const error = await refusal(raw(made.articleId, lead, 3));
    expect(error.details).toMatchObject({ reason: 'kb_publisher_is_author' });
    expect((await raw(made.articleId, second, 3)).value.changed).toBe(true);
  });

  it('lets an approver who wrote only older, already published versions publish a later edit by someone else', async () => {
    const made = await create({ bodyMd: 'first' });
    await transition(made.articleId, 'in_review');
    await raw(made.articleId, lead);
    await update(made.articleId, { bodyMd: 'second by author' });
    await sendForReview(made.articleId);
    expect((await raw(made.articleId, lead, 2)).value.changed).toBe(true);
  });

  describe('a new version of a live article passes review first (P3-C)', () => {
    it('refuses a normal publish of a newer version that was never sent for review, and leaves the live text alone', async () => {
      const made = await create({ bodyMd: 'live' });
      await publish(made.articleId, 1);
      const edited = await update(made.articleId, { bodyMd: 'newer' });
      const error = await refusal(raw(made.articleId, second, 2));
      expect(error.code).toBe('invalid_transition');
      const row = await articleRow(made.articleId);
      expect(row).toMatchObject({ status: 'published', publishedVersionId: made.versionId });
      expect(row.currentVersionId).toBe(edited.value.versionId);
    });

    it('keeps the article live while the newer version waits, and publishes it after the request', async () => {
      const made = await create({ bodyMd: 'live' });
      await publish(made.articleId, 1);
      const edited = await update(made.articleId, { bodyMd: 'newer' });
      const requested = await transition(made.articleId, 'in_review');
      expect(requested.value.changed).toBe(true);
      expect(await articleRow(made.articleId)).toMatchObject({
        status: 'published',
        publishedVersionId: made.versionId,
        reviewVersionId: edited.value.versionId,
      });
      // Asking twice changes nothing.
      expect((await transition(made.articleId, 'in_review')).value.changed).toBe(false);
      // The author of version 2 still cannot publish it; somebody else can.
      const own = await refusal(raw(made.articleId, author, 2));
      expect(own.details).toMatchObject({ reason: 'kb_publisher_is_author' });
      expect((await raw(made.articleId, second, 2)).value.changed).toBe(true);
      expect(await articleRow(made.articleId)).toMatchObject({
        status: 'published',
        publishedVersionId: edited.value.versionId,
        reviewVersionId: null,
      });
    });

    it('treats an edit after the request as not reviewed: the request names one version', async () => {
      const made = await create({ bodyMd: 'live' });
      await publish(made.articleId, 1);
      await update(made.articleId, { bodyMd: 'reviewed text' });
      await transition(made.articleId, 'in_review');
      await update(made.articleId, { bodyMd: 'slipped in after the request' });
      const error = await refusal(raw(made.articleId, second, 3));
      expect(error.code).toBe('invalid_transition');
      await transition(made.articleId, 'in_review');
      expect((await raw(made.articleId, second, 3)).value.changed).toBe(true);
    });

    it('has nothing to review when the latest version is already live, and a deprecation drops the request', async () => {
      const made = await create({ bodyMd: 'live' });
      await publish(made.articleId, 1);
      expect((await refusal(transition(made.articleId, 'in_review'))).code).toBe(
        'invalid_transition',
      );
      await update(made.articleId, { bodyMd: 'newer' });
      await transition(made.articleId, 'in_review');
      await transition(made.articleId, 'deprecated');
      expect(await articleRow(made.articleId)).toMatchObject({
        status: 'deprecated',
        reviewVersionId: null,
      });
    });
  });

  it('never lets an AI or a system identity publish, nor review a break-glass publication', async () => {
    const made = await create();
    await transition(made.articleId, 'in_review');
    const audience = await audienceOf(made.articleId);
    for (const actor of [
      { type: 'ai' as const, id: null },
      { type: 'system' as const, id: null },
      { type: 'system' as const, id: lead.id },
    ]) {
      const normal = await refusal(
        env.tx((tx) =>
          env.domain.kb.publish(tx, env.ctx(actor), {
            articleId: made.articleId,
            version: 1,
            audience,
          }),
        ),
      );
      expect(normal.details, actor.type).toMatchObject({ reason: 'kb_publisher_not_human' });
      const glass = await refusal(
        env.tx((tx) =>
          env.domain.kb.publishBreakGlass(tx, env.ctx(actor), {
            articleId: made.articleId,
            version: 1,
            audience,
            reason: 'urgent',
          }),
        ),
      );
      expect(glass.details, actor.type).toMatchObject({ reason: 'kb_publisher_not_human' });
    }
    expect((await articleRow(made.articleId)).status).toBe('in_review');
  });

  it('lets anyone who may deprecate or withdraw do it alone', async () => {
    const made = await create();
    await transition(made.articleId, 'in_review');
    await env.tx((tx) =>
      env.domain.kb.transition(tx, env.ctx(author.actor), {
        articleId: made.articleId,
        to: 'draft',
      }),
    );
    const live = await create();
    await publish(live.articleId, 1);
    await env.tx((tx) =>
      env.domain.kb.transition(tx, env.ctx(lead.actor), {
        articleId: live.articleId,
        to: 'deprecated',
      }),
    );
    expect((await articleRow(live.articleId)).status).toBe('deprecated');
  });
});

describe('kb.publishBreakGlass', () => {
  let second: Awaited<ReturnType<typeof addStaff>>;
  let head: Awaited<ReturnType<typeof addStaff>>;
  beforeAll(async () => {
    second = await addStaff(env, 'lead');
    head = await addStaff(env, 'head');
  });

  const glass = (articleId: string, by: typeof lead, reason: string, version = 1) =>
    audienceOf(articleId).then((audience) =>
      env.tx((tx) =>
        env.domain.kb.publishBreakGlass(tx, env.ctx(by.actor), {
          articleId,
          version,
          audience,
          reason,
        }),
      ),
    );

  it('publishes from draft without a second person, flags the article and audits it as its own action', async () => {
    const made = await create({ bodyMd: 'urgent fix' });
    const result = await glass(made.articleId, head, '  Wrong refund policy is live  ');
    expect(result.value.changed).toBe(true);
    expect(result.audited).toBe(true);
    expect(await articleRow(made.articleId)).toMatchObject({
      status: 'published',
      publishedVersionId: made.versionId,
      breakGlassPending: true,
      breakGlassBy: head.id,
      breakGlassReason: 'Wrong refund policy is live',
      breakGlassReviewedBy: null,
    });
    const audit = (await auditRows(env, 'kb.article.publish_break_glass')).filter(
      (row) => row.targetId === made.articleId,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorId).toBe(head.id);
    expect(audit[0]?.metadata).toMatchObject({ reason: 'Wrong refund policy is live' });
    expect(
      (await auditRows(env, 'kb.article.publish')).filter((row) => row.targetId === made.articleId),
    ).toHaveLength(0);
    // Still indexed by the worker like any publication.
    const { rows } = await pool().query(
      `SELECT 1 FROM outbox WHERE queue = 'kb' AND payload->>'articleId' = $1`,
      [made.articleId],
    );
    expect(rows).toHaveLength(1);
  });

  it('can publish text the head wrote themselves, which a normal publication refuses', async () => {
    const made = await create({ bodyMd: 'head wrote this' });
    await env.tx((tx) =>
      env.domain.kb.update(tx, env.ctx(head.actor), {
        articleId: made.articleId,
        patch: { bodyMd: 'head edit' },
        canApprove: true,
      }),
    );
    const normal = await refusal(
      audienceOf(made.articleId).then((audience) =>
        env.tx((tx) =>
          env.domain.kb.publish(tx, env.ctx(head.actor), {
            articleId: made.articleId,
            version: 2,
            audience,
          }),
        ),
      ),
    );
    expect(normal.code).toBe('invalid_transition');
    expect((await glass(made.articleId, head, 'incident', 2)).value.changed).toBe(true);
  });

  it('needs a reason, the latest version and the audience the head saw', async () => {
    const made = await create();
    for (const reason of ['', '   ']) {
      expect((await refusal(glass(made.articleId, head, reason))).code).toBe('bad_request');
    }
    expect((await refusal(glass(made.articleId, head, 'why', 5))).code).toBe('conflict');
    const error = await refusal(
      env.tx((tx) =>
        env.domain.kb.publishBreakGlass(tx, env.ctx(head.actor), {
          articleId: made.articleId,
          version: 1,
          audience: { visibility: 'customer', orgIds: [] },
          reason: 'why',
        }),
      ),
    );
    expect(error.code).toBe('conflict');
    expect((await articleRow(made.articleId)).status).toBe('draft');
  });

  it('is reviewed by another approver, never by the person who used it, and only once', async () => {
    const made = await create();
    await glass(made.articleId, head, 'incident');
    const seen = (await articleRow(made.articleId)).breakGlassAt ?? new Date(0);
    const review = (by: typeof lead) =>
      env.tx((tx) =>
        env.domain.kb.reviewBreakGlass(tx, env.ctx(by.actor), {
          articleId: made.articleId,
          breakGlassAt: seen,
        }),
      );
    const own = await refusal(review(head));
    expect(own.details).toMatchObject({ reason: 'kb_review_is_publisher' });
    expect((await articleRow(made.articleId)).breakGlassPending).toBe(true);

    const done = await review(second);
    expect(done.audited).toBe(true);
    expect(await articleRow(made.articleId)).toMatchObject({
      breakGlassPending: false,
      breakGlassReviewedBy: second.id,
      breakGlassBy: head.id,
    });
    expect((await refusal(review(second))).code).toBe('conflict');
    expect(
      (await auditRows(env, 'kb.article.break_glass_review')).filter(
        (row) => row.targetId === made.articleId,
      ),
    ).toHaveLength(1);
  });

  describe('who may review (P2-A, P3-E)', () => {
    const reviewOf = (articleId: string, by: typeof lead, seen: Date | null) =>
      env.tx(async (tx) => {
        const at = seen ?? (await articleRow(articleId)).breakGlassAt ?? new Date(0);
        return env.domain.kb.reviewBreakGlass(tx, env.ctx(by.actor), {
          articleId,
          breakGlassAt: at,
        });
      });

    it('refuses a reviewer who wrote the text that went live, and keeps the flag up', async () => {
      // The author wrote version 1; the head publishes it break-glass; the author must not clear
      // the review of their own text.
      const made = await create({ bodyMd: 'urgent text by the author' });
      await glass(made.articleId, head, 'incident');
      const own = await refusal(reviewOf(made.articleId, author, null));
      expect(own.code).toBe('policy_denied');
      expect(own.details).toMatchObject({ reason: 'kb_reviewer_is_author' });
      expect(await articleRow(made.articleId)).toMatchObject({
        breakGlassPending: true,
        breakGlassReviewedBy: null,
      });
      expect((await reviewOf(made.articleId, second, null)).value.changed).toBe(true);
    });

    it('counts every version from the one after the live one up to the break-glass one', async () => {
      const made = await create({ bodyMd: 'v1 by the author' });
      await publish(made.articleId, 1);
      // second writes v2, lead writes v3 (both unpublished), the head publishes v3 break-glass.
      await update(made.articleId, { bodyMd: 'v2 by second' }, true, second);
      await update(made.articleId, { bodyMd: 'v3 by lead' }, true, lead);
      await glass(made.articleId, head, 'incident', 3);
      expect(await articleRow(made.articleId)).toMatchObject({ breakGlassPrevVersion: 1 });
      for (const writer of [second, lead]) {
        const error = await refusal(reviewOf(made.articleId, writer, null));
        expect(error.details, writer.id).toMatchObject({ reason: 'kb_reviewer_is_author' });
      }
      // The author wrote only version 1, which was live before: they may review.
      expect((await reviewOf(made.articleId, author, null)).value.changed).toBe(true);
    });

    it('does not let a stale review clear a newer break-glass publication', async () => {
      const made = await create({ bodyMd: 'first emergency' });
      await glass(made.articleId, head, 'first');
      const seenFirst = (await articleRow(made.articleId)).breakGlassAt ?? new Date(0);
      // Another approver is looking at the first one while a second one goes live.
      await update(made.articleId, { bodyMd: 'second emergency' });
      await new Promise((resolve) => setTimeout(resolve, 15));
      await glass(made.articleId, head, 'second', 2);
      const row = await articleRow(made.articleId);
      expect(row.breakGlassReason).toBe('second');
      expect(row.breakGlassAt?.getTime()).toBeGreaterThan(seenFirst.getTime());

      const stale = await refusal(reviewOf(made.articleId, second, seenFirst));
      expect(stale.code).toBe('conflict');
      expect((await articleRow(made.articleId)).breakGlassPending).toBe(true);
      expect((await reviewOf(made.articleId, second, row.breakGlassAt)).value.changed).toBe(true);
      expect((await articleRow(made.articleId)).breakGlassPending).toBe(false);
    });
  });

  it('cannot be reviewed by a non-person, and a plain article has nothing to review', async () => {
    const made = await create();
    await glass(made.articleId, head, 'incident');
    const seen = (await articleRow(made.articleId)).breakGlassAt ?? new Date(0);
    const system = refusal(
      env.tx((tx) =>
        env.domain.kb.reviewBreakGlass(tx, env.ctx({ type: 'system', id: null }), {
          articleId: made.articleId,
          breakGlassAt: seen,
        }),
      ),
    );
    expect((await system).details).toMatchObject({ reason: 'kb_publisher_not_human' });
    const plain = await create();
    expect(
      (
        await refusal(
          env.tx((tx) =>
            env.domain.kb.reviewBreakGlass(tx, env.ctx(second.actor), {
              articleId: plain.articleId,
              breakGlassAt: new Date(),
            }),
          ),
        )
      ).code,
    ).toBe('conflict');
  });
});

describe('embedding index and chunks', () => {
  it('creates and activates the index of the model in settings, and switches when the model changes', async () => {
    expect(await env.tx((tx) => readActiveEmbeddingIndex(tx))).toBeUndefined();
    const first = await env.tx((tx) =>
      ensureActiveEmbeddingIndex(tx, { provider: 'mock', model: 'model-a', dimensions: 3 }),
    );
    expect(first.activated).toBe(true);
    const same = await env.tx((tx) =>
      ensureActiveEmbeddingIndex(tx, { provider: 'mock', model: 'model-a', dimensions: 3 }),
    );
    expect(same).toMatchObject({ id: first.id, activated: false });
    const second = await env.tx((tx) =>
      ensureActiveEmbeddingIndex(tx, { provider: 'mock', model: 'model-b', dimensions: 4 }),
    );
    expect(second.id).not.toBe(first.id);
    expect((await env.tx((tx) => readActiveEmbeddingIndex(tx)))?.id).toBe(second.id);
    const { rows } = await pool().query(
      'SELECT count(*)::int AS n FROM kb_embedding_index WHERE is_active',
    );
    expect(rows[0]).toEqual({ n: 1 });
    // Back to the first model: its row is reused, not duplicated.
    const back = await env.tx((tx) =>
      ensureActiveEmbeddingIndex(tx, { provider: 'mock', model: 'model-a', dimensions: 3 }),
    );
    expect(back.id).toBe(first.id);
  });

  it('stores the chunks of the live version, replacing the earlier ones, and refuses a stale version', async () => {
    const made = await create({ bodyMd: 'one' });
    await publish(made.articleId, 1);
    const index = await env.tx((tx) =>
      ensureActiveEmbeddingIndex(tx, { provider: 'mock', model: 'chunks-3', dimensions: 3 }),
    );
    const chunk = (ordinal: number, embedding: number[] | null) => ({
      ordinal,
      section: 'S',
      text: `text ${String(ordinal)}`,
      charStart: 0,
      charEnd: 4,
      embedding,
    });
    expect(
      await env.tx((tx) =>
        replaceArticleChunks(tx, {
          articleId: made.articleId,
          versionId: made.versionId,
          chunks: [chunk(0, [1, 0, 0]), chunk(1, null)],
          embeddingIndexId: index.id,
        }),
      ),
    ).toBe(true);
    const stored = await pool().query(
      'SELECT ordinal, embedding_index_id IS NOT NULL AS embedded FROM kb_chunk WHERE article_id = $1 ORDER BY ordinal',
      [made.articleId],
    );
    expect(stored.rows).toEqual([
      { ordinal: 0, embedded: true },
      { ordinal: 1, embedded: false },
    ]);

    // Replaced, not appended.
    await env.tx((tx) =>
      replaceArticleChunks(tx, {
        articleId: made.articleId,
        versionId: made.versionId,
        chunks: [chunk(0, [0, 1, 0])],
        embeddingIndexId: index.id,
      }),
    );
    expect(
      (await pool().query('SELECT 1 FROM kb_chunk WHERE article_id = $1', [made.articleId]))
        .rowCount,
    ).toBe(1);

    // A new version goes live: chunks made for the old one are refused.
    await update(made.articleId, { bodyMd: 'two' });
    const second = await publish(made.articleId, 2);
    expect(
      await env.tx((tx) =>
        replaceArticleChunks(tx, {
          articleId: made.articleId,
          versionId: made.versionId,
          chunks: [chunk(0, null)],
          embeddingIndexId: null,
        }),
      ),
    ).toBe(false);
    expect(second.value.version).toBe(2);
  });

  it('drops the chunks of an article that is no longer live, never of a live one', async () => {
    const made = await create();
    await publish(made.articleId, 1);
    const store = () =>
      env.tx((tx) =>
        replaceArticleChunks(tx, {
          articleId: made.articleId,
          versionId: made.versionId,
          chunks: [
            { ordinal: 0, section: '', text: 'x', charStart: 0, charEnd: 1, embedding: null },
          ],
          embeddingIndexId: null,
        }),
      );
    await store();
    expect(await env.tx((tx) => dropArticleChunksIfNotLive(tx, made.articleId))).toBe(false);
    await transition(made.articleId, 'deprecated');
    expect(await env.tx((tx) => dropArticleChunksIfNotLive(tx, made.articleId))).toBe(true);
    expect(
      (await pool().query('SELECT 1 FROM kb_chunk WHERE article_id = $1', [made.articleId]))
        .rowCount,
    ).toBe(0);
  });

  it('lists the published articles whose chunks are missing, unembedded or from another index', async () => {
    const active = await env.tx((tx) =>
      ensureActiveEmbeddingIndex(tx, { provider: 'mock', model: 'reembed-3', dimensions: 3 }),
    );
    const other = await env.tx((tx) =>
      ensureActiveEmbeddingIndex(tx, { provider: 'mock', model: 'reembed-old', dimensions: 3 }),
    );
    const fresh = await env.tx((tx) =>
      ensureActiveEmbeddingIndex(tx, { provider: 'mock', model: 'reembed-3', dimensions: 3 }),
    );
    expect(fresh.id).toBe(active.id);
    const store = async (articleId: string, versionId: string, indexId: string | null) =>
      env.tx((tx) =>
        replaceArticleChunks(tx, {
          articleId,
          versionId,
          chunks: [
            {
              ordinal: 0,
              section: '',
              text: 'x',
              charStart: 0,
              charEnd: 1,
              embedding: indexId === null ? null : [1, 0, 0],
            },
          ],
          embeddingIndexId: indexId,
        }),
      );
    const done = await create();
    const unembedded = await create();
    const stale = await create();
    const empty = await create();
    for (const made of [done, unembedded, stale, empty]) await publish(made.articleId, 1);
    await store(done.articleId, done.versionId, fresh.id);
    await store(unembedded.articleId, unembedded.versionId, null);
    await store(stale.articleId, stale.versionId, other.id);
    const targets = (await articlesNeedingEmbedding(env.database.db, fresh.id)).map(
      (t) => t.articleId,
    );
    expect(targets).toEqual(
      expect.arrayContaining([unembedded.articleId, stale.articleId, empty.articleId]),
    );
    expect(targets).not.toContain(done.articleId);
  });
});

describe('searchKb', () => {
  const ids = {} as Record<string, { articleId: string; versionId: string }>;
  let orgA: string;
  let orgB: string;
  let indexId: string;
  let otherIndexId: string;

  const staff: KbAudience = { kind: 'staff' };
  const customer = (orgId: string | null): KbAudience => ({ kind: 'customer', orgId });
  const search = (query: string, audience: KbAudience, extra: object = {}) =>
    searchKb(env.database.db, { query, audience, limit: 10, ...extra });
  const vec = (x: number, y: number, z: number) => ({ vector: [x, y, z], indexId });

  /** Writes live chunks for a published article, bypassing the worker. */
  async function live(
    key: string,
    fields: Partial<CreateKbArticle>,
    chunks: { section?: string; text: string; embedding?: number[] }[],
  ) {
    const made = await create(fields);
    await publish(made.articleId, 1);
    await env.tx((tx) =>
      replaceArticleChunks(tx, {
        articleId: made.articleId,
        versionId: made.versionId,
        chunks: chunks.map((chunk, ordinal) => ({
          ordinal,
          section: chunk.section ?? '',
          text: chunk.text,
          charStart: 0,
          charEnd: chunk.text.length,
          embedding: chunk.embedding ?? null,
        })),
        embeddingIndexId: indexId,
      }),
    );
    ids[key] = made;
    return made;
  }

  beforeAll(async () => {
    orgA = (await addOrg(env)).id;
    orgB = (await addOrg(env)).id;
    indexId = (
      await env.tx((tx) =>
        ensureActiveEmbeddingIndex(tx, { provider: 'mock', model: 'search-3', dimensions: 3 }),
      )
    ).id;
    otherIndexId =
      (
        await pool().query<{ id: string }>(
          `INSERT INTO kb_embedding_index (provider, model, dimensions) VALUES ('mock', 'search-old', 3) RETURNING id`,
        )
      ).rows[0]?.id ?? '';

    await live('internalEn', { visibility: 'internal', lang: 'en', title: 'Internal runbook' }, [
      {
        section: 'Rotate',
        text: 'Rotate the signing keys for the payment gateway every quarter.',
        embedding: [0, 0, 1],
      },
    ]);
    await live('customerEn', { visibility: 'customer', lang: 'en', title: 'Reset your password' }, [
      {
        section: 'Steps',
        text: 'Open the sign-in page and choose Forgot password to receive a reset link.',
        embedding: [1, 0, 0],
      },
      {
        section: 'Limits',
        text: 'A reset link works once and expires after fifteen minutes.',
        embedding: [0.9, 0.1, 0],
      },
      {
        section: 'Contact',
        text: 'Still stuck with the password? Contact support.',
        embedding: [0.7, 0.3, 0],
      },
    ]);
    await live('customerTh', { visibility: 'customer', lang: 'th', title: 'วิธีรีเซ็ตรหัสผ่าน' }, [
      {
        section: 'ขั้นตอน',
        text: 'หากลืมรหัสผ่านให้เลือกลืมรหัสผ่านที่หน้าเข้าสู่ระบบเพื่อรับลิงก์ตั้งรหัสผ่านใหม่',
        embedding: [0.8, 0.2, 0],
      },
    ]);
    await live('orgAOnly', { visibility: 'orgs', orgIds: [orgA], title: 'Invoice portal for A' }, [
      {
        text: 'Organization A receives its invoices through the dedicated invoice portal.',
        embedding: [0, 1, 0],
      },
    ]);
    await live('orgBOnly', { visibility: 'orgs', orgIds: [orgB], title: 'Invoice portal for B' }, [
      {
        text: 'Organization B receives its invoices by email on the first day of the month.',
        embedding: [0, 0.9, 0.1],
      },
    ]);
    await live('toDeprecate', { visibility: 'customer', title: 'Old procedure' }, [
      { text: 'The retired procedure for exporting the legacy ledger.', embedding: [0.5, 0.5, 0] },
    ]);
    await transition(ids.toDeprecate?.articleId ?? '', 'deprecated');

    // Rows the worker would never write but a bug or a restore might: chunks of a draft and of an
    // old version of a live article, and chunks embedded by another index.
    const draft = await create({ visibility: 'customer', title: 'Unpublished draft' });
    ids.draft = draft;
    await pool().query(
      `INSERT INTO kb_chunk (article_id, version_id, ordinal, text, char_start, char_end, embedding, embedding_index_id)
       VALUES ($1, $2, 0, 'Secret draft text about the legacy ledger export.', 0, 10, '[0.5,0.5,0]', $3)`,
      [draft.articleId, draft.versionId, indexId],
    );
    const edited = await create({ visibility: 'customer', title: 'Edited' });
    await publish(edited.articleId, 1);
    await update(edited.articleId, { bodyMd: 'newer body' });
    await publish(edited.articleId, 2);
    await pool().query(
      `INSERT INTO kb_chunk (article_id, version_id, ordinal, text, char_start, char_end)
       VALUES ($1, $2, 0, 'Superseded wording about legacy ledger export.', 0, 10)`,
      [edited.articleId, edited.versionId],
    );
    ids.superseded = edited;
    await pool().query(`UPDATE kb_chunk SET embedding_index_id = $1 WHERE article_id = $2`, [
      otherIndexId,
      ids.orgBOnly?.articleId,
    ]);
  });

  const titles = (hits: { title: string }[]) => hits.map((hit) => hit.title);

  it('finds an English passage by keyword and says it did not use vectors', async () => {
    const result = await search('forgot password reset link', staff);
    expect(result.mode).toBe('keyword');
    expect(titles(result.hits)[0]).toBe('Reset your password');
    expect(result.hits[0]).toMatchObject({
      section: 'Steps',
      keywordRank: 1,
      vectorRank: null,
      lang: 'en',
    });
    expect(result.hits[0]?.snippet).toContain('Forgot password');
  });

  it('finds a Thai passage by a Thai phrase without word boundaries', async () => {
    const result = await search('ลืมรหัสผ่าน', staff);
    expect(titles(result.hits)).toContain('วิธีรีเซ็ตรหัสผ่าน');
    expect(result.hits.find((hit) => hit.lang === 'th')?.section).toBe('ขั้นตอน');
    const onlyThai = await search('ลืมรหัสผ่าน', staff, { lang: 'th' });
    expect(onlyThai.hits.every((hit) => hit.lang === 'th')).toBe(true);
  });

  it('fuses keyword and vector: a vector-only match joins, and a double match ranks first', async () => {
    const hybrid = await search('password', staff, { embedding: vec(1, 0, 0) });
    expect(hybrid.mode).toBe('hybrid');
    expect(hybrid.hits[0]).toMatchObject({ section: 'Steps' });
    expect(hybrid.hits[0]?.keywordRank).not.toBeNull();
    expect(hybrid.hits[0]?.vectorRank).toBe(1);
    expect(hybrid.hits[0]?.score).toBeGreaterThan(hybrid.hits[1]?.score ?? 1);

    // No word in common with the query, found by meaning alone.
    const semantic = await search('zzzz', staff, { embedding: vec(0, 0, 1) });
    expect(semantic.hits[0]).toMatchObject({
      title: 'Internal runbook',
      keywordRank: null,
      vectorRank: 1,
    });
  });

  it('ignores vectors from another embedding index', async () => {
    const result = await search('zzzz', staff, { embedding: vec(0, 1, 0), perArticle: 5 });
    expect(result.hits.some((hit) => hit.title === 'Invoice portal for B')).toBe(false);
    expect(result.hits[0]?.title).toBe('Invoice portal for A');
  });

  it('keeps a chunk out of the vector list when its similarity is below the floor', async () => {
    // Only a chunk exactly along x has similarity 1; the others are lower, and the floor decides.
    const loose = await search('zzzz', staff, {
      embedding: vec(1, 0, 0),
      minVectorSimilarity: 0,
      perArticle: 5,
    });
    const strict = await search('zzzz', staff, {
      embedding: vec(1, 0, 0),
      minVectorSimilarity: 0.999,
      perArticle: 5,
    });
    expect(loose.hits.length).toBeGreaterThan(strict.hits.length);
    expect(strict.hits.every((hit) => (hit.vectorRank ?? 0) > 0)).toBe(true);
    expect(strict.hits.map((hit) => hit.section)).toEqual(['Steps']);
    // Nothing is close to the z axis except the internal runbook: the default floor drops the rest.
    const byDefault = await search('zzzz', staff, { embedding: vec(0, 0, 1), perArticle: 5 });
    expect(titles(byDefault.hits)).toEqual(['Internal runbook']);
  });

  it('never returns an internal article, a draft, a deprecated one or an old version to a customer', async () => {
    const queries = [
      'signing keys payment gateway',
      'legacy ledger',
      'rotate',
      'invoice portal',
      'secret draft',
    ];
    for (const orgId of [null, orgA, orgB]) {
      for (const query of queries) {
        for (const embedding of [undefined, vec(0, 0, 1), vec(0.5, 0.5, 0)]) {
          const { hits } = await search(query, customer(orgId), { embedding, perArticle: 5 });
          for (const hit of hits) {
            expect(hit.visibility, `${query} ${String(orgId)}`).not.toBe('internal');
            expect(hit.title).not.toBe('Internal runbook');
            expect(hit.title).not.toBe('Unpublished draft');
            expect(hit.title).not.toBe('Old procedure');
            expect(hit.snippet).not.toContain('Secret draft');
            expect(hit.snippet).not.toContain('Superseded');
          }
        }
      }
    }
  });

  it('shows an "orgs" article only to the organizations on it', async () => {
    const forA = await search('invoices', customer(orgA), { perArticle: 5 });
    expect(titles(forA.hits)).toEqual(['Invoice portal for A']);
    const forB = await search('invoices', customer(orgB), { perArticle: 5 });
    expect(titles(forB.hits)).toEqual(['Invoice portal for B']);
    const forNobody = await search('invoices', customer(null));
    expect(forNobody.hits).toEqual([]);
    const forStaff = await search('invoices', staff);
    expect(titles(forStaff.hits).toSorted()).toEqual([
      'Invoice portal for A',
      'Invoice portal for B',
    ]);
  });

  it('shows staff the internal article too, but still not drafts, deprecated articles or old versions', async () => {
    const internal = await search('signing keys', staff);
    expect(titles(internal.hits)).toEqual(['Internal runbook']);
    for (const query of ['legacy ledger', 'secret draft', 'superseded wording']) {
      expect((await search(query, staff)).hits).toEqual([]);
    }
  });

  it('limits the hits and the chunks of one article', async () => {
    const one = await search('password', staff, { limit: 1 });
    expect(one.hits).toHaveLength(1);
    const perArticle = await search('password', staff, { perArticle: 1, lang: 'en' });
    expect(perArticle.hits.filter((hit) => hit.title === 'Reset your password')).toHaveLength(1);
    const two = await search('password', staff, { perArticle: 2, lang: 'en' });
    expect(two.hits.filter((hit) => hit.title === 'Reset your password')).toHaveLength(2);
  });

  it('answers an empty list for a query with nothing to match, without a database error', async () => {
    expect((await search('a', staff)).hits).toEqual([]);
    expect((await search('""\\"{}', staff)).hits).toEqual([]);
    expect((await search("'; DROP TABLE kb_chunk; --", staff)).hits).toEqual([]);
    expect((await pool().query('SELECT 1 FROM kb_chunk LIMIT 1')).rowCount).toBe(1);
  });

  it('cuts a long Thai snippet on a grapheme boundary', async () => {
    const text = 'การตั้งค่าระบบ'.repeat(60);
    await live('long', { visibility: 'customer', lang: 'th', title: 'Long Thai' }, [{ text }]);
    const { hits } = await search('การตั้งค่าระบบ', staff, { lang: 'th' });
    const snippet = hits.find((hit) => hit.title === 'Long Thai')?.snippet ?? '';
    expect(snippet.endsWith('...')).toBe(true);
    const kept = snippet.slice(0, -3);
    expect(text.startsWith(kept)).toBe(true);
    // The cut is not between a consonant and the vowel or tone mark that belongs to it.
    expect(text.slice(kept.length)).not.toMatch(/^\p{M}/u);
    expect(snippet.length).toBeLessThanOrEqual(304);
  });
});
