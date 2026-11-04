import type { Browser, BrowserContext, Page } from '@playwright/test';

import {
  Api,
  expect,
  findOrgId,
  newActor,
  openComposer,
  signInDev,
  test,
  unique,
  type StaffTicket,
} from './support';

/**
 * AC-4 in a real browser against the real stack (mock AI and embeddings): searching "webhook retry"
 * returns the article with a section-level citation; resolving a ticket that cited no article
 * produces a draft article in the review queue within 5 minutes, written by the AI, that its
 * requester cannot publish and that nobody can find until a person publishes it. The KB has no
 * screen yet (T-107e), so articles are written and searched over REST with the session of the
 * browser context; the ticket is replied to and resolved in the workspace itself.
 */
const FIVE_MINUTES_MS = 5 * 60_000;

interface Person {
  context: BrowserContext;
  page: Page;
  api: Api;
  id: string;
}

interface Article {
  id: string;
  version: number;
  status: string;
  visibility: string;
  orgIds: string[];
  sources: { type: string; ref: string }[];
  title: string;
}

interface Hit {
  articleId: string;
  title: string;
  section: string;
  snippet: string;
}

test.describe.serial('AC-4: KB search with a section citation; a gap becomes a draft', () => {
  let agent: Person;
  let lead: Person;
  let secondLead: Person;
  let article: Article;
  let ticket: StaffTicket;
  let drafted: Article;
  const marker = unique('whr').replace(/-/g, '');
  const slug = `webhook-retry-${marker}`;
  const title = `Webhook retry policy ${marker}`;
  const sectionHeading = 'Backoff schedule';
  const subject = `Our callbacks never arrive ${unique('gap')}`;
  const reply = `We re-sent the callbacks by hand and raised your retry limit ${unique('fix')}.`;

  async function person(browser: Browser, role: 'agent' | 'lead'): Promise<Person> {
    const { context, page } = await newActor(browser);
    await signInDev(page, role, unique(role));
    const api = new Api(context.request);
    const session = await api.get<{ user: { id: string } }>('/v1/auth/session');
    return { context, page, api, id: session.json.user.id };
  }

  test.beforeAll(async ({ browser }) => {
    agent = await person(browser, 'agent');
    lead = await person(browser, 'lead');
    secondLead = await person(browser, 'lead');
  });

  test.afterAll(async () => {
    for (const who of [agent, lead, secondLead]) await who.context.close();
  });

  test('an agent writes an article; a lead publishes it after review; it becomes searchable', async () => {
    const created = await agent.api.post<Article>('/v1/kb/articles', {
      slug,
      title,
      lang: 'en',
      visibility: 'internal',
      intentTags: ['integration_issue'],
      bodyMd: [
        `# ${title}`,
        '',
        'A failed webhook delivery is tried again by the platform.',
        '',
        `## ${sectionHeading}`,
        '',
        `The webhook retry runs after 1, 5 and 30 minutes, then the delivery is marked failed. ${marker}`,
        '',
        '## Replaying a delivery',
        '',
        'Open the delivery log of the customer and press replay once the endpoint answers again.',
      ].join('\n'),
    });
    expect(created.status).toBe(201);
    article = created.json;
    expect(article.status).toBe('draft');

    // Nothing is searchable while it is a draft.
    const before = await agent.api.get<{ hits: Hit[] }>(
      `/v1/kb/search?q=${encodeURIComponent(marker)}`,
    );
    expect(before.json.hits.map((hit) => hit.articleId)).not.toContain(article.id);

    // An agent cannot publish; two people are needed.
    const review = await agent.api.post<Article>(`/v1/kb/articles/${article.id}/transition`, {
      to: 'in_review',
    });
    expect(review.status).toBeLessThan(300);
    const refused = await agent.api.post(`/v1/kb/articles/${article.id}/publish`, {
      version: article.version,
      visibility: article.visibility,
      orgIds: [],
    });
    expect(refused.status).toBe(403);

    const published = await lead.api.post<Article>(`/v1/kb/articles/${article.id}/publish`, {
      version: article.version,
      visibility: article.visibility,
      orgIds: [],
    });
    expect(published.status).toBe(200);
    expect(published.json.status).toBe('published');
  });

  test('searching "webhook retry" returns the article with a section-level citation', async () => {
    // Indexing is the worker's job after the publish; poll for the hit, not for a fixed time.
    // The search returns up to two chunks of one article. "webhook retry" matches both the opening
    // chunk (under the title) and the "Backoff schedule" chunk equally in the keyword list, and ties
    // are broken by chunk id (a random uuid), so which comes first is not defined. Look at the
    // article's hits as a set, not at whichever one happens to be first.
    let hits: Hit[] = [];
    await expect
      .poll(
        async () => {
          const found = await agent.api.get<{ mode: string; hits: Hit[] }>(
            `/v1/kb/search?q=${encodeURIComponent('webhook retry')}`,
          );
          expect(found.status).toBe(200);
          hits = found.json.hits.filter((candidate) => candidate.articleId === article.id);
          return hits.length > 0;
        },
        { message: 'the published article reaches the search index' },
      )
      .toBe(true);
    expect(hits.every((hit) => hit.title === title)).toBe(true);
    const cited = hits.find((hit) => hit.section.includes(sectionHeading));
    expect(cited, 'a citation down to the section').toBeDefined();
    expect(cited?.snippet).toContain('1, 5 and 30 minutes');
  });

  test('a ticket is answered and resolved in the workspace without citing any article', async () => {
    const orgId = await findOrgId(lead.api, 'Acme Logistics');
    const created = await lead.api.post<StaffTicket>('/v1/tickets', {
      orgId,
      subject,
      body: 'Our systems never receive the callbacks you promised.',
      requester: { email: `${unique('caller')}@acme-logistics.example.com`, name: 'Caller' },
    });
    expect(created.status).toBe(201);
    ticket = created.json;

    const page = lead.page;
    await page.goto(`/?ticket=${ticket.key}`);
    await openComposer(page, 'reply');
    await page.getByRole('textbox', { name: 'Public reply' }).fill(reply);
    await page.getByRole('button', { name: 'Send reply', exact: true }).click();
    await expect(page.getByText('Reply sent.')).toBeVisible();

    const details = page.getByRole('region', { name: 'Details & AI' });
    await details.getByRole('tab', { name: 'Details' }).click();
    await details.getByRole('button', { name: /^Status:/ }).click();
    await page.getByRole('option', { name: /^Resolved/ }).click();
    await expect(page.getByText('Saved.').first()).toBeVisible();
    const after = await lead.api.get<StaffTicket>(`/v1/tickets/${ticket.key}`);
    expect(after.json.status).toBe('resolved');
  });

  test('within 5 minutes a draft article waits in the review queue, written by the AI', async () => {
    const started = Date.now();
    await expect
      .poll(
        async () => {
          const list = await lead.api.all<{ id: string; status: string }>(
            '/v1/kb/articles?status=in_review',
          );
          for (const item of list) {
            const full = await lead.api.get<Article>(`/v1/kb/articles/${item.id}`);
            if (full.json.sources.some((s) => s.type === 'ticket' && s.ref === ticket.id)) {
              drafted = full.json;
              return true;
            }
          }
          return false;
        },
        {
          message: 'AC-4: a draft article for the resolved ticket (queued 30 s after resolving)',
          timeout: FIVE_MINUTES_MS,
          intervals: [2_000],
        },
      )
      .toBe(true);
    const elapsed = Date.now() - started;
    expect(elapsed, 'AC-4: within 5 minutes').toBeLessThan(FIVE_MINUTES_MS);
    expect(drafted.status).toBe('in_review');
    expect(drafted.visibility, 'an AI draft is internal until a person decides').toBe('internal');
  });

  test('the draft is not searchable, its requester cannot publish it, another lead can', async () => {
    const probe = async (): Promise<boolean> => {
      const found = await agent.api.get<{ hits: Hit[] }>(
        `/v1/kb/search?q=${encodeURIComponent(drafted.title)}`,
      );
      return found.json.hits.some((hit) => hit.articleId === drafted.id);
    };
    expect(await probe(), 'an in_review draft is not searchable').toBe(false);

    const body = { version: drafted.version, visibility: drafted.visibility, orgIds: [] };
    const own = await lead.api.post<{ code?: string }>(
      `/v1/kb/articles/${drafted.id}/publish`,
      body,
    );
    expect(own.status, 'the person who resolved the ticket may not publish the AI text').toBe(403);

    const other = await secondLead.api.post<Article>(`/v1/kb/articles/${drafted.id}/publish`, body);
    expect(other.status).toBe(200);
    expect(other.json.status).toBe('published');
    await expect.poll(probe, { message: 'published, then indexed' }).toBe(true);
  });
});
