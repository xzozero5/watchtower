import { MockEmbeddingProvider, createRedactor, mockSettings } from '@watchtower/ai';
import {
  kbArticlePageSchema,
  kbArticleSchema,
  kbCustomerSearchResultSchema,
  kbSearchResultSchema,
  kbVersionListSchema,
  type CreateKbArticle,
  type KbArticle,
  type KbArticlePage,
  type KbCustomerSearchResult,
  type KbSearchResult,
  type KbVersion,
  type KbVersionList,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { apiOrg, signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';

// Knowledge base routes (T-107c) on the real application module: Postgres (restricted application
// role), Redis and the mock embedding provider. No worker runs here, so the chunks that the worker
// would write are inserted by the test, with vectors from the same deterministic mock provider.

let h: Harness;
let agent: Persona;
let lead: Persona;
let head: Persona;
let clientA: Persona;
let clientB: Persona;
let orgA = '';
let orgB = '';
let indexId = '';
let counter = 0;

const pool = () => h.db.owner.pool;

beforeAll(async () => {
  h = await startHarness();
  agent = await signIn(h, 'agent');
  lead = await signIn(h, 'lead');
  head = await signIn(h, 'head');
  orgA = (await apiOrg(lead, { name: 'KB Org A' })).id;
  orgB = (await apiOrg(lead, { name: 'KB Org B' })).id;
  clientA = await signIn(h, 'client', orgA, 'Client A');
  clientB = await signIn(h, 'client', orgB, 'Client B');
});

afterAll(async () => {
  await h.close();
});

const body = (fields: Record<string, unknown> = {}): Record<string, unknown> => {
  counter += 1;
  return {
    slug: `api-article-${String(counter)}`,
    title: `Article ${String(counter)}`,
    bodyMd: '# Heading\n\nSome text.',
    lang: 'en',
    ...fields,
  };
};

async function create(fields: Partial<CreateKbArticle> = {}, who = agent): Promise<KbArticle> {
  const response = await who.client.post<KbArticle>('/v1/kb/articles', body(fields));
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return kbArticleSchema.parse(response.body);
}

async function fresh(id: string, who = agent): Promise<KbArticle> {
  return kbArticleSchema.parse((await who.client.get<KbArticle>(`/v1/kb/articles/${id}`)).body);
}

/** What the approver's screen sends back: the version and the audience as they were shown. */
const seen = (article: KbArticle, version = article.version) => ({
  version,
  visibility: article.visibility,
  orgIds: article.orgIds,
});

/** The writer sends a draft for review, the way the web does. */
async function submit(article: KbArticle): Promise<void> {
  if ((await fresh(article.id)).status !== 'draft') return;
  const response = await agent.client.post(`/v1/kb/articles/${article.id}/transition`, {
    to: 'in_review',
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

/** Two people: the agent writes and submits, an approver publishes what they saw. */
async function publish(
  article: KbArticle,
  version = article.version,
  who = lead,
): Promise<KbArticle> {
  await submit(article);
  const current = await fresh(article.id);
  const response = await who.client.post<KbArticle>(
    `/v1/kb/articles/${article.id}/publish`,
    seen(current, version),
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return kbArticleSchema.parse(response.body);
}

/** What the worker writes: the live chunks of an article, with vectors when an index is given. */
async function chunks(article: KbArticle, texts: { section?: string; text: string }[]) {
  const live = await pool().query<{ id: string }>(
    'SELECT published_version_id AS id FROM kb_article WHERE id = $1',
    [article.id],
  );
  const versionId = live.rows[0]?.id;
  const session = createRedactor().session({ scope: 'test' });
  const provider = new MockEmbeddingProvider();
  const settings = mockSettings().embedding;
  const { embeddings } = await provider.embed({
    model: settings.model,
    values: texts.map((entry) => session.redact(entry.text)),
    dimensions: settings.dimensions,
  });
  for (const [ordinal, entry] of texts.entries()) {
    await pool().query(
      `INSERT INTO kb_chunk (article_id, version_id, ordinal, section, text, char_start, char_end, embedding, embedding_index_id)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7::vector, $8)`,
      [
        article.id,
        versionId,
        ordinal,
        entry.section ?? '',
        entry.text,
        entry.text.length,
        `[${(embeddings[ordinal] ?? []).join(',')}]`,
        indexId,
      ],
    );
  }
}

async function makeIndex(): Promise<void> {
  const settings = mockSettings().embedding;
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO kb_embedding_index (provider, model, dimensions, is_active)
     VALUES ($1, $2, $3, false) RETURNING id`,
    [settings.provider, settings.model, settings.dimensions],
  );
  indexId = rows[0]?.id ?? '';
}

describe('permissions', () => {
  it('needs a signed-in session on every route', async () => {
    const anonymous = h.client();
    for (const path of [
      '/v1/kb/articles',
      '/v1/kb/search?q=reset',
      '/v1/kb/customer/search?q=reset',
    ]) {
      expect((await anonymous.get(path)).status, path).toBe(401);
    }
    expect((await anonymous.post('/v1/kb/articles', body())).status).toBe(401);
  });

  it('keeps every staff route away from a client, and customer search away from staff', async () => {
    const made = await create();
    for (const path of [
      '/v1/kb/articles',
      `/v1/kb/articles/${made.id}`,
      `/v1/kb/articles/${made.id}/versions`,
      '/v1/kb/search?q=reset',
    ]) {
      expect((await clientA.client.get(path)).status, path).toBe(403);
    }
    expect((await clientA.client.post('/v1/kb/articles', body())).status).toBe(403);
    expect(
      (await clientA.client.post(`/v1/kb/articles/${made.id}/publish`, seen(made))).status,
    ).toBe(403);
    // Staff have no customer permission: the customer route is for client accounts only.
    expect((await agent.client.get('/v1/kb/customer/search?q=reset')).status).toBe(403);
    expect((await head.client.get('/v1/kb/customer/search?q=reset')).status).toBe(403);
  });

  it('lets an agent write but not approve; a lead or head approves', async () => {
    const made = await create();
    await submit(made);
    const asAgent = await agent.client.post<ApiErrorBody>(
      `/v1/kb/articles/${made.id}/publish`,
      seen(made),
    );
    expect(asAgent.status).toBe(403);
    expect((await head.client.post(`/v1/kb/articles/${made.id}/publish`, seen(made))).status).toBe(
      200,
    );
    const toDeprecate = await create();
    expect(
      (
        await agent.client.post<ApiErrorBody>(`/v1/kb/articles/${toDeprecate.id}/transition`, {
          to: 'deprecated',
        })
      ).status,
    ).toBe(403);
    expect(
      (await lead.client.post(`/v1/kb/articles/${toDeprecate.id}/transition`, { to: 'deprecated' }))
        .status,
    ).toBe(200);
  });
});

describe('articles', () => {
  it('creates a draft at version 1 with a validated body and writes one audit row', async () => {
    const made = await create({
      title: 'Reset a password',
      intentTags: ['password_reset'],
      sources: [{ type: 'ticket', ref: 'OPS-1' }],
    });
    expect(made).toMatchObject({
      status: 'draft',
      visibility: 'internal',
      version: 1,
      publishedVersion: null,
      hasUnpublishedChanges: true,
      intentTags: ['password_reset'],
      authorId: agent.userId,
      sources: [{ type: 'ticket', ref: 'OPS-1' }],
    });
    const { rows } = await pool().query(
      `SELECT actor_id, target_type FROM audit_log WHERE action = 'kb.article.create' AND target_id = $1`,
      [made.id],
    );
    expect(rows).toEqual([{ actor_id: agent.userId, target_type: 'kb_article' }]);
  });

  it('refuses bad input with 400 and a taken slug with 409', async () => {
    for (const bad of [
      { slug: 'Not A Slug' },
      { lang: 'fr' },
      { visibility: 'public' },
      { visibility: 'orgs' },
      { title: '' },
      { bodyMd: 'x'.repeat(30_001) },
    ]) {
      const response = await agent.client.post<ApiErrorBody>('/v1/kb/articles', body(bad));
      expect(response.status, JSON.stringify(bad)).toBe(400);
    }
    const first = await create();
    const clash = await agent.client.post<ApiErrorBody>('/v1/kb/articles', {
      ...body(),
      slug: first.slug,
    });
    expect(clash.status).toBe(409);
    const unknownOrg = await agent.client.post<ApiErrorBody>(
      '/v1/kb/articles',
      body({ visibility: 'orgs', orgIds: ['5b0b8f0e-6c6e-4f5e-9d6e-1b2c3d4e5f60'] }),
    );
    expect(unknownOrg.status).toBe(400);
  });

  it('edits into a new version, keeps the live one, and lists the history', async () => {
    const made = await create({ bodyMd: 'first text' });
    await publish(made);
    const edited = await agent.client.patch<KbArticle>(`/v1/kb/articles/${made.id}`, {
      bodyMd: 'second text',
      changeNote: 'clarify',
      expectedVersion: 1,
    });
    expect(edited.status).toBe(200);
    expect(kbArticleSchema.parse(edited.body)).toMatchObject({
      version: 2,
      publishedVersion: 1,
      status: 'published',
      hasUnpublishedChanges: true,
      bodyMd: 'second text',
    });

    const history = await agent.client.get<KbVersionList>(`/v1/kb/articles/${made.id}/versions`);
    const list = kbVersionListSchema.parse(history.body);
    expect(list.items.map((item) => [item.version, item.isCurrent, item.isPublished])).toEqual([
      [2, true, false],
      [1, false, true],
    ]);
    expect(list.items[0]?.changeNote).toBe('clarify');
    expect(list.items[0]?.createdBy).toBe(agent.userId);

    const one = await agent.client.get<KbVersion>(`/v1/kb/articles/${made.id}/versions/1`);
    expect(one.body).toMatchObject({ version: 1, bodyMd: 'first text', isPublished: true });
    expect((await agent.client.get(`/v1/kb/articles/${made.id}/versions/9`)).status).toBe(404);
  });

  it('refuses a stale edit (409), an empty edit (400) and an unknown article (404)', async () => {
    const made = await create();
    await agent.client.patch(`/v1/kb/articles/${made.id}`, { bodyMd: 'v2' });
    const stale = await agent.client.patch<ApiErrorBody>(`/v1/kb/articles/${made.id}`, {
      bodyMd: 'v3',
      expectedVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect((await agent.client.patch(`/v1/kb/articles/${made.id}`, {})).status).toBe(400);
    expect(
      (
        await agent.client.patch('/v1/kb/articles/5b0b8f0e-6c6e-4f5e-9d6e-1b2c3d4e5f60', {
          bodyMd: 'x',
        })
      ).status,
    ).toBe(404);
    expect((await agent.client.get('/v1/kb/articles/not-a-uuid')).status).toBe(400);
  });

  it('lets only an approver show a published article to more people (403 otherwise)', async () => {
    const made = await create({ bodyMd: 'internal procedure' });
    await publish(made);
    const denied = await agent.client.patch<ApiErrorBody>(`/v1/kb/articles/${made.id}`, {
      visibility: 'customer',
    });
    expect(denied.status).toBe(403);
    const allowed = await lead.client.patch<KbArticle>(`/v1/kb/articles/${made.id}`, {
      visibility: 'customer',
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.visibility).toBe('customer');
    // Pulling it back is open to anyone who may edit.
    const back = await agent.client.patch<KbArticle>(`/v1/kb/articles/${made.id}`, {
      visibility: 'internal',
    });
    expect(back.body.visibility).toBe('internal');
  });

  it('publishes only the version the approver looked at, and records the reviewer and the job', async () => {
    const made = await create();
    await agent.client.patch(`/v1/kb/articles/${made.id}`, {
      bodyMd: 'edited after the review began',
    });
    const stale = await lead.client.post<ApiErrorBody>(
      `/v1/kb/articles/${made.id}/publish`,
      seen(made, 1),
    );
    expect(stale.status).toBe(409);
    const live = await publish(made, 2);
    expect(live).toMatchObject({
      status: 'published',
      version: 2,
      publishedVersion: 2,
      hasUnpublishedChanges: false,
      reviewerId: lead.userId,
    });
    const { rows } = await pool().query<{ payload: { articleId: string } }>(
      `SELECT payload FROM outbox WHERE queue = 'kb' AND job_name = 'embed_article' AND payload->>'articleId' = $1`,
      [made.id],
    );
    expect(rows).toHaveLength(1);
    // One success row from the domain (same transaction as the change), and the refused attempt
    // above as a failure row written by the request audit.
    const audit = await pool().query(
      `SELECT actor_id, outcome FROM audit_log WHERE action = 'kb.article.publish' AND target_id = $1 ORDER BY created_at`,
      [made.id],
    );
    expect(audit.rows.map((row: { outcome: string }) => row.outcome).toSorted()).toEqual([
      'failure',
      'success',
    ]);
    expect(audit.rows.every((row: { actor_id: string }) => row.actor_id === lead.userId)).toBe(
      true,
    );
  });

  it('moves through review and deprecation, and refuses a move that is not allowed', async () => {
    const made = await create();
    const review = await agent.client.post<KbArticle>(`/v1/kb/articles/${made.id}/transition`, {
      to: 'in_review',
    });
    expect(review.body.status).toBe('in_review');
    const bad = await agent.client.post<ApiErrorBody>(`/v1/kb/articles/${made.id}/transition`, {
      to: 'published',
    });
    expect(bad.status).toBe(400);
    const back = await agent.client.post<KbArticle>(`/v1/kb/articles/${made.id}/transition`, {
      to: 'draft',
    });
    expect(back.body.status).toBe('draft');
    await lead.client.post(`/v1/kb/articles/${made.id}/transition`, { to: 'deprecated' });
    const again = await agent.client.post<ApiErrorBody>(`/v1/kb/articles/${made.id}/transition`, {
      to: 'in_review',
    });
    expect(again.status).toBe(409);
    expect(
      (await lead.client.post<ApiErrorBody>(`/v1/kb/articles/${made.id}/publish`, seen(made)))
        .status,
    ).toBe(409);
  });

  it('lists with filters and pages by cursor', async () => {
    const tagged = await create({ lang: 'th', title: 'ภาษาไทย', intentTags: ['list_probe_tag'] });
    for (let i = 0; i < 3; i += 1) await create({ intentTags: ['list_probe_page'] });
    const filtered = await agent.client.get<KbArticlePage>(
      '/v1/kb/articles?intentTag=list_probe_tag&lang=th&status=draft',
    );
    expect(kbArticlePageSchema.parse(filtered.body).items.map((item) => item.id)).toEqual([
      tagged.id,
    ]);

    const first = await agent.client.get<KbArticlePage>(
      '/v1/kb/articles?intentTag=list_probe_page&limit=2',
    );
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await agent.client.get<KbArticlePage>(
      `/v1/kb/articles?intentTag=list_probe_page&limit=2&cursor=${first.body.nextCursor ?? ''}`,
    );
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.items, ...second.body.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(3);
    expect((await agent.client.get('/v1/kb/articles?cursor=garbage')).status).toBe(400);
  });
});

describe('publishing: the approver publishes what they saw (P2-1)', () => {
  it('refuses a publication whose audience is not the one the approver saw (409), also by omission (400)', async () => {
    const made = await create({ bodyMd: 'reviewed as internal' });
    await submit(made);
    const asSeen = seen(await fresh(made.id));
    expect(asSeen.visibility).toBe('internal');
    // An approver widens it in another tab; the first approver still holds the internal view.
    const widened = await lead.client.patch(`/v1/kb/articles/${made.id}`, {
      visibility: 'customer',
    });
    expect(widened.status).toBe(200);
    const stale = await head.client.post<ApiErrorBody>(
      `/v1/kb/articles/${made.id}/publish`,
      asSeen,
    );
    expect(stale.status).toBe(409);
    expect((await fresh(made.id)).status).toBe('in_review');
    const missing = await head.client.post(`/v1/kb/articles/${made.id}/publish`, { version: 1 });
    expect(missing.status).toBe(400);
    const live = await publish(made, 1, head);
    expect(live.visibility).toBe('customer');
  });

  it('refuses to widen an article without kb.approve at any status', async () => {
    for (const to of [undefined, 'in_review'] as const) {
      const made = await create({ bodyMd: 'internal only' });
      if (to !== undefined) await submit(made);
      const denied = await agent.client.patch<ApiErrorBody>(`/v1/kb/articles/${made.id}`, {
        visibility: 'customer',
      });
      expect(denied.status, String(to)).toBe(403);
      expect((await fresh(made.id)).visibility).toBe('internal');
    }
  });

  it('never lets the reported scenario reach a customer', async () => {
    // internal, in review; the agent widens it; the lead publishes what they reviewed.
    const made = await create({ bodyMd: 'Quarterly signing key procedure for staff only.' });
    await submit(made);
    const reviewed = seen(await fresh(made.id));
    await agent.client.patch(`/v1/kb/articles/${made.id}`, { visibility: 'customer' });
    const published = await lead.client.post(`/v1/kb/articles/${made.id}/publish`, reviewed);
    expect(published.status).toBe(200);
    expect((await fresh(made.id)).visibility).toBe('internal');
    // The worker would index it now; a keyword-only chunk is enough to see who can find it.
    await pool().query(
      `INSERT INTO kb_chunk (article_id, version_id, ordinal, text, char_start, char_end)
       SELECT id, published_version_id, 0, 'Quarterly signing key procedure for staff only.', 0, 50
         FROM kb_article WHERE id = $1`,
      [made.id],
    );
    const asStaff = await agent.client.get<KbSearchResult>(
      '/v1/kb/search?q=signing%20key%20procedure',
    );
    expect(asStaff.body.hits.map((hit) => hit.articleId)).toContain(made.id);
    const asClient = await clientA.client.get<KbCustomerSearchResult>(
      '/v1/kb/customer/search?q=signing%20key%20procedure',
    );
    expect(JSON.stringify(asClient.body)).not.toContain(made.id);
  });
});

describe('publishing: segregation of duties', () => {
  it('does not publish from draft (409) and needs the article to be in review', async () => {
    const made = await create();
    const response = await lead.client.post<ApiErrorBody>(
      `/v1/kb/articles/${made.id}/publish`,
      seen(made),
    );
    expect(response.status).toBe(409);
    expect((await fresh(made.id)).status).toBe('draft');
  });

  it('does not let a writer publish their own text: another approver does', async () => {
    const made = await create({}, lead);
    await lead.client.post(`/v1/kb/articles/${made.id}/transition`, { to: 'in_review' });
    const own = await lead.client.post<ApiErrorBody>(
      `/v1/kb/articles/${made.id}/publish`,
      seen(made),
    );
    expect(own.status).toBe(403);
    expect((await head.client.post(`/v1/kb/articles/${made.id}/publish`, seen(made))).status).toBe(
      200,
    );
  });

  it('makes an approver who edits during review its author', async () => {
    const made = await create({ bodyMd: 'agent text' });
    await submit(made);
    const edit = await lead.client.patch<KbArticle>(`/v1/kb/articles/${made.id}`, {
      bodyMd: 'lead tweak',
    });
    expect(edit.body.version).toBe(2);
    const own = await lead.client.post<ApiErrorBody>(
      `/v1/kb/articles/${made.id}/publish`,
      seen(edit.body),
    );
    expect(own.status).toBe(403);
    expect(
      (await head.client.post(`/v1/kb/articles/${made.id}/publish`, seen(edit.body))).status,
    ).toBe(200);
  });

  it('lets one person deprecate alone', async () => {
    const made = await create();
    await publish(made);
    const response = await lead.client.post<KbArticle>(`/v1/kb/articles/${made.id}/transition`, {
      to: 'deprecated',
    });
    expect(response.body.status).toBe('deprecated');
  });
});

describe('break-glass publishing', () => {
  const glass = (who: Persona, article: KbArticle, reason: unknown) =>
    who.client.post<KbArticle & ApiErrorBody>(`/v1/kb/articles/${article.id}/publish-break-glass`, {
      ...seen(article),
      reason,
    });

  it('is for the head only: no permission for an agent or a lead (403)', async () => {
    const made = await create();
    for (const who of [agent, lead, clientA]) {
      expect((await glass(who, made, 'urgent')).status).toBe(403);
    }
    expect((await fresh(made.id)).status).toBe('draft');
  });

  it('needs a non-empty reason (400)', async () => {
    const made = await create();
    for (const reason of ['', '   ', undefined]) {
      expect((await glass(head, made, reason)).status).toBe(400);
    }
    expect((await fresh(made.id)).status).toBe('draft');
  });

  it('publishes from draft, flags the article, audits its own action, and is listed for review', async () => {
    const made = await create({ bodyMd: 'urgent correction' });
    const response = await glass(head, made, 'Wrong refund policy is live');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      status: 'published',
      breakGlassPending: true,
      breakGlass: {
        pending: true,
        by: head.userId,
        reason: 'Wrong refund policy is live',
        reviewedBy: null,
      },
    });
    const audit = await pool().query(
      `SELECT actor_id, metadata FROM audit_log WHERE action = 'kb.article.publish_break_glass' AND target_id = $1 AND outcome = 'success'`,
      [made.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_id: head.userId,
      metadata: { reason: 'Wrong refund policy is live' },
    });
    const waiting = await agent.client.get<KbArticlePage>(
      '/v1/kb/articles?breakGlassPending=true&limit=100',
    );
    expect(waiting.body.items.map((item) => item.id)).toContain(made.id);
  });

  it('is reviewed by another approver, not by the head who used it', async () => {
    const made = await create();
    await glass(head, made, 'incident');
    const own = await head.client.post<ApiErrorBody>(
      `/v1/kb/articles/${made.id}/break-glass-review`,
    );
    expect(own.status).toBe(403);
    expect((await agent.client.post(`/v1/kb/articles/${made.id}/break-glass-review`)).status).toBe(
      403,
    );
    const done = await lead.client.post<KbArticle>(`/v1/kb/articles/${made.id}/break-glass-review`);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      breakGlassPending: false,
      breakGlass: { pending: false, by: head.userId, reviewedBy: lead.userId },
    });
    const again = await lead.client.post(`/v1/kb/articles/${made.id}/break-glass-review`);
    expect(again.status).toBe(409);
    const waiting = await agent.client.get<KbArticlePage>(
      '/v1/kb/articles?breakGlassPending=true&limit=100',
    );
    expect(waiting.body.items.map((item) => item.id)).not.toContain(made.id);
  });
});

describe('input hygiene and limits (P3)', () => {
  it('rejects a NUL character with 400 instead of reaching the database (P3-1)', async () => {
    for (const path of ['/v1/kb/search?q=a%00b', '/v1/kb/customer/search?q=a%00b']) {
      const who = path.includes('customer') ? clientA : agent;
      const response = await who.client.get<ApiErrorBody>(path);
      expect(response.status, path).toBe(400);
      expect(JSON.stringify(response.body)).not.toContain('a\u0000b');
    }
    for (const field of ['title', 'bodyMd', 'changeNote']) {
      const response = await agent.client.post('/v1/kb/articles', body({ [field]: 'x\u0000y' }));
      expect(response.status, field).toBe(400);
    }
  });

  it('rate limits staff search per user (P3-2)', async () => {
    const busy = await signIn(h, 'agent');
    let refused = 0;
    for (let i = 0; i < 62; i += 1) {
      const response = await busy.client.get('/v1/kb/search?q=password');
      if (response.status === 429) refused += 1;
    }
    expect(refused).toBe(2);
    expect((await agent.client.get('/v1/kb/search?q=password')).status).toBe(200);
  });

  it('refuses the staff routes to a client account even if kb permissions were granted by mistake (P3-3)', async () => {
    await pool().query(
      `INSERT INTO role_permissions (role, permission) VALUES ('client', 'kb.read'), ('client', 'kb.write'), ('client', 'kb.approve')`,
    );
    try {
      const made = await create();
      const reads = [
        '/v1/kb/articles',
        `/v1/kb/articles/${made.id}`,
        `/v1/kb/articles/${made.id}/versions`,
        `/v1/kb/articles/${made.id}/versions/1`,
        '/v1/kb/search?q=password',
      ];
      for (const path of reads) expect((await clientA.client.get(path)).status, path).toBe(403);
      expect((await clientA.client.post('/v1/kb/articles', body())).status).toBe(403);
      expect(
        (await clientA.client.patch(`/v1/kb/articles/${made.id}`, { bodyMd: 'x' })).status,
      ).toBe(403);
      expect(
        (await clientA.client.post(`/v1/kb/articles/${made.id}/transition`, { to: 'in_review' }))
          .status,
      ).toBe(403);
      expect(
        (await clientA.client.post(`/v1/kb/articles/${made.id}/publish`, seen(made))).status,
      ).toBe(403);
      expect(
        (await clientA.client.post(`/v1/kb/articles/${made.id}/break-glass-review`)).status,
      ).toBe(403);
    } finally {
      await pool().query(
        `DELETE FROM role_permissions WHERE role = 'client' AND permission IN ('kb.read', 'kb.write', 'kb.approve')`,
      );
    }
  });
});

describe('search', () => {
  let internal: KbArticle;
  let customer: KbArticle;
  let forA: KbArticle;
  let forB: KbArticle;
  let draft: KbArticle;

  beforeAll(async () => {
    internal = await create({ visibility: 'internal', title: 'Rotate signing keys' });
    customer = await create({
      visibility: 'customer',
      title: 'Reset your password',
      intentTags: ['password_reset'],
    });
    forA = await create({ visibility: 'orgs', orgIds: [orgA], title: 'Invoice portal for A' });
    forB = await create({ visibility: 'orgs', orgIds: [orgB], title: 'Invoice portal for B' });
    draft = await create({ visibility: 'customer', title: 'Unreleased feature notes' });
    await makeIndex();
    for (const article of [internal, customer, forA, forB]) await publish(article);
    await chunks(internal, [
      { section: 'Rotate', text: 'Rotate the signing keys of the payment gateway every quarter.' },
    ]);
    await chunks(customer, [
      {
        section: 'Steps',
        text: 'Open the sign-in page and choose Forgot password to get a reset link.',
      },
      { section: 'Limits', text: 'A reset link works once and expires after fifteen minutes.' },
    ]);
    await chunks(forA, [
      { text: 'Organization A receives its invoices through the invoice portal.' },
    ]);
    await chunks(forB, [
      { text: 'Organization B receives its invoices by email on the first day.' },
    ]);
  });

  it('searches by keyword and says so while nothing is embedded with an active index', async () => {
    const response = await agent.client.get<KbSearchResult>('/v1/kb/search?q=forgot%20password');
    expect(response.status).toBe(200);
    const result = kbSearchResultSchema.parse(response.body);
    expect(result.mode).toBe('keyword');
    expect(result.hits[0]).toMatchObject({
      articleId: customer.id,
      title: 'Reset your password',
      section: 'Steps',
      keywordRank: 1,
      vectorRank: null,
    });
  });

  it('fuses keyword and vector once an index is active, and meters the query embedding', async () => {
    await pool().query('UPDATE kb_embedding_index SET is_active = true WHERE id = $1', [indexId]);
    // The same text as the stored chunk: the mock provider gives the same vector, so it ranks first by vector too.
    const text = 'Open the sign-in page and choose Forgot password to get a reset link.';
    const before = await pool().query(`SELECT 1 FROM ai_run WHERE agent = 'embedder'`);
    const response = await agent.client.get<KbSearchResult>(
      `/v1/kb/search?q=${encodeURIComponent(text)}`,
    );
    const result = kbSearchResultSchema.parse(response.body);
    expect(result.mode).toBe('hybrid');
    expect(result.hits[0]).toMatchObject({
      articleId: customer.id,
      section: 'Steps',
      vectorRank: 1,
    });
    expect(result.hits[0]?.keywordRank).not.toBeNull();
    const after = await pool().query(
      `SELECT status, input_tokens, ticket_id FROM ai_run WHERE agent = 'embedder'`,
    );
    expect(after.rowCount).toBe((before.rowCount ?? 0) + 1);
    expect(after.rows.at(-1)).toMatchObject({ status: 'ok', ticket_id: null });
  });

  it('shows staff internal articles too, but never a draft', async () => {
    const result = (await agent.client.get<KbSearchResult>('/v1/kb/search?q=signing%20keys')).body;
    expect(result.hits.map((hit) => hit.articleId)).toContain(internal.id);
    const drafts = (await agent.client.get<KbSearchResult>('/v1/kb/search?q=unreleased%20feature'))
      .body;
    expect(drafts.hits.map((hit) => hit.articleId)).not.toContain(draft.id);
  });

  it('shows a client only customer-visible articles and its own organizations', async () => {
    const forClientA = await clientA.client.get<KbCustomerSearchResult>(
      '/v1/kb/customer/search?q=invoices',
    );
    expect(forClientA.status).toBe(200);
    expect(
      kbCustomerSearchResultSchema.parse(forClientA.body).hits.map((hit) => hit.articleId),
    ).toEqual([forA.id]);
    const forClientB = await clientB.client.get<KbCustomerSearchResult>(
      '/v1/kb/customer/search?q=invoices',
    );
    expect(forClientB.body.hits.map((hit) => hit.articleId)).toEqual([forB.id]);
  });

  it('never leaks an internal article or its text to a client, however the query is phrased', async () => {
    for (const q of [
      'signing keys',
      'Rotate the signing keys of the payment gateway',
      'payment gateway quarter',
      'rotate',
      'zzzz',
    ]) {
      const response = await clientA.client.get<KbCustomerSearchResult>(
        `/v1/kb/customer/search?q=${encodeURIComponent(q)}&limit=10`,
      );
      expect(response.status, q).toBe(200);
      const text = JSON.stringify(response.body);
      expect(text, q).not.toContain(internal.id);
      expect(text, q).not.toContain('signing keys');
      expect(text, q).not.toContain(draft.id);
    }
  });

  it('answers a client with title, section and snippet only', async () => {
    const response = await clientA.client.get<KbCustomerSearchResult>(
      '/v1/kb/customer/search?q=forgot%20password',
    );
    const [hit] = response.body.hits;
    expect(Object.keys(hit ?? {}).toSorted()).toEqual([
      'articleId',
      'lang',
      'section',
      'slug',
      'snippet',
      'title',
    ]);
    expect(hit?.title).toBe('Reset your password');
  });

  it('previews the customer view for staff, with an organization', async () => {
    const asCustomer = await agent.client.get<KbSearchResult>(
      '/v1/kb/search?q=signing%20keys&audience=customer',
    );
    expect(asCustomer.body.hits).toEqual([]);
    const withOrg = await agent.client.get<KbSearchResult>(
      `/v1/kb/search?q=invoices&audience=customer&orgId=${orgA}`,
    );
    expect(withOrg.body.hits.map((hit) => hit.articleId)).toEqual([forA.id]);
  });

  it('falls back to keyword search, still answering, when the AI kill switch is on', async () => {
    await pool().query(
      `UPDATE ai_switch SET is_on = true, reason = 'test' WHERE key = 'ai_kill_switch'`,
    );
    try {
      const runs = await pool().query(`SELECT 1 FROM ai_run WHERE agent = 'embedder'`);
      const response = await agent.client.get<KbSearchResult>('/v1/kb/search?q=forgot%20password');
      expect(response.status).toBe(200);
      expect(response.body.mode).toBe('keyword');
      expect(response.body.hits[0]?.articleId).toBe(customer.id);
      const after = await pool().query(`SELECT 1 FROM ai_run WHERE agent = 'embedder'`);
      expect(after.rowCount).toBe(runs.rowCount);
    } finally {
      await pool().query(
        `UPDATE ai_switch SET is_on = false, reason = 'test' WHERE key = 'ai_kill_switch'`,
      );
    }
  });

  it('finds Thai text', async () => {
    const thai = await create({ visibility: 'customer', lang: 'th', title: 'วิธีรีเซ็ตรหัสผ่าน' });
    await publish(thai);
    await chunks(thai, [
      {
        section: 'ขั้นตอน',
        text: 'หากลืมรหัสผ่านให้เลือกลืมรหัสผ่านที่หน้าเข้าสู่ระบบเพื่อรับลิงก์ใหม่',
      },
    ]);
    const response = await clientA.client.get<KbCustomerSearchResult>(
      `/v1/kb/customer/search?q=${encodeURIComponent('ลืมรหัสผ่าน')}&lang=th`,
    );
    expect(response.body.hits.map((hit) => hit.articleId)).toEqual([thai.id]);
  });

  it('refuses a missing query, an oversize limit, and an unknown audience', async () => {
    for (const path of [
      '/v1/kb/search',
      '/v1/kb/search?q=',
      '/v1/kb/search?q=x&limit=999',
      '/v1/kb/search?q=reset&audience=public',
      '/v1/kb/search?q=reset&orgId=nope',
    ]) {
      expect((await agent.client.get(path)).status, path).toBe(400);
    }
    expect((await clientA.client.get('/v1/kb/customer/search')).status).toBe(400);
  });

  it('rate limits customer search per user', async () => {
    const limited = await signIn(h, 'client', orgA, 'Busy Client');
    let refused = 0;
    for (let i = 0; i < 32; i += 1) {
      const response = await limited.client.get('/v1/kb/customer/search?q=password');
      if (response.status === 429) refused += 1;
    }
    expect(refused).toBe(2);
    // Another user is not affected.
    expect((await clientA.client.get('/v1/kb/customer/search?q=password')).status).toBe(200);
  });
});
