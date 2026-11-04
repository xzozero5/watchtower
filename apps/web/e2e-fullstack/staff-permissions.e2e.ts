import type { Browser, BrowserContext, Page } from '@playwright/test';

import { Api, expect, newActor, signInDev, signInStaff, test, unique } from './support';

/**
 * What an agent, a lead and the head (break-glass) can and cannot do, through the browser (T-113).
 * rbac.e2e.ts covers clients; this covers staff roles, each signed in through the mock identity
 * provider of the stack. Every page is checked in the UI and, with the same session, over REST, so
 * a hidden link is never the only barrier.
 */
const DENIED = 'You don’t have access to this page.';

interface Person {
  context: BrowserContext;
  page: Page;
  api: Api;
}

test.describe.serial('staff permissions: agent, lead and head', () => {
  let agent: Person;
  let lead: Person;
  let head: Person;

  async function dev(browser: Browser, role: 'agent' | 'lead'): Promise<Person> {
    const { context, page } = await newActor(browser);
    await signInDev(page, role, unique(role));
    return { context, page, api: new Api(context.request) };
  }

  test.beforeAll(async ({ browser }) => {
    agent = await dev(browser, 'agent');
    lead = await dev(browser, 'lead');
    const { context, page } = await newActor(browser);
    await signInStaff(page);
    head = { context, page, api: new Api(context.request) };
  });

  test.afterAll(async () => {
    for (const who of [agent, lead, head]) await who.context.close();
  });

  test('an agent starts on the queue, sees no Admin or Overview, and is turned away from them', async () => {
    const page = agent.page;
    await page.goto('/');
    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(rail.getByRole('link', { name: /^Admin\b/ })).toHaveCount(0);
    await expect(rail.getByRole('link', { name: /^Home\b/ })).toHaveCount(0);

    for (const path of ['/admin/users', '/admin/audit', '/home', '/shift/overview']) {
      await page.goto(path);
      await expect(page.getByText(DENIED), `${path} for an agent`).toBeVisible();
    }
  });

  test('an agent is refused by the api for lead and head actions', async () => {
    const forbidden = ['/v1/users', '/v1/audit-logs', '/v1/ops/outbox'];
    for (const path of forbidden) {
      const response = await agent.api.get(path);
      expect(response.status, `GET ${path}`).toBe(403);
    }
    const publish = await agent.api.post(
      '/v1/kb/articles/00000000-0000-4000-8000-000000000000/publish',
      {
        version: 1,
        visibility: 'internal',
        orgIds: [],
      },
    );
    expect(publish.status, 'an agent cannot publish a KB article').toBe(403);
    const clockOut = await agent.api.get('/v1/shifts/overview');
    expect(clockOut.status, 'the team overview is for leads').toBe(403);
  });

  test('a lead sees the overview and the user list, but not the audit log or head-only settings', async () => {
    const page = lead.page;
    await page.goto('/shift/overview');
    await expect(
      page.getByRole('heading', { name: 'Unacknowledged handoff items' }).first(),
    ).toBeVisible();
    await page.goto('/admin/users');
    await expect(page.getByText(DENIED)).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Admin sections' })).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Admin sections' });
    await expect(nav.getByRole('link', { name: 'Users' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Queues' })).toBeVisible();
    for (const hidden of ['Audit log', 'Integrations', 'SLA', 'Outbox']) {
      await expect(nav.getByRole('link', { name: hidden }), `${hidden} is head only`).toHaveCount(
        0,
      );
    }
    for (const path of ['/admin/audit', '/admin/integrations', '/admin/sla', '/admin/outbox']) {
      await page.goto(path);
      await expect(page.getByText(DENIED), `${path} for a lead`).toBeVisible();
    }
  });

  test('a lead is refused by the api for head-only actions and allowed lead actions', async () => {
    for (const path of ['/v1/audit-logs', '/v1/ops/outbox']) {
      const response = await lead.api.get(path);
      expect(response.status, `GET ${path}`).toBe(403);
    }
    const users = await lead.api.get('/v1/users');
    expect(users.status).toBe(200);
  });

  test('the head opens the audit log and every admin section a lead cannot', async () => {
    const page = head.page;
    await page.goto('/admin/audit');
    await expect(page.getByText(DENIED)).toHaveCount(0);
    const nav = page.getByRole('navigation', { name: 'Admin sections' });
    for (const visible of ['Users', 'Audit log', 'Integrations', 'SLA', 'Outbox']) {
      await expect(nav.getByRole('link', { name: visible })).toBeVisible();
    }
    const audit = await head.api.get('/v1/audit-logs');
    expect(audit.status).toBe(200);
  });
});
