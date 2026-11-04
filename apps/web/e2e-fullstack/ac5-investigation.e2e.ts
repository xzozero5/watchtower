import type { Browser, BrowserContext, Page } from '@playwright/test';

import {
  Api,
  expect,
  fakeGmail,
  newActor,
  ORGS,
  signInDev,
  type StaffTicket,
  test,
  unique,
} from './support';

/**
 * AC-5 (PRD section 4.5): from a `webhook_not_received` ticket one click runs the intent's log template for the
 * organization and attaches an evidence card; runs cannot exceed the shared Logging rate budget.
 *
 * Real api, worker, web and database; the logs are the tools' mock fixtures (examples/tools/fixtures.json, the
 * stack sets AI_TOOL_FIXTURES_DIR), never GCP. The demo seed has no investigation template, so the head of this
 * test saves two (that is what `POST /v1/tools/templates` is for): one generic filter, and one scoped to the
 * ticket's organization. The fixture lines belong to other, made-up organizations, so the scoped one must find
 * nothing of theirs.
 *
 * The budget half: one person takes at most 20 Logging units a minute and all people together at most 55
 * (`LOGGING_RATE_BUDGET`, the provider's quota is 60). Several people click far more often than that in one
 * minute; the runs the api accepted never exceed the budget, the rest are 429 with Retry-After, and no 5xx.
 */
const PERSON_PER_MINUTE = 20;
const TOTAL_PER_MINUTE = 55;

interface Person {
  context: BrowserContext;
  page: Page;
  api: Api;
}
interface ToolButtons {
  intentKey: string | null;
  buttons: {
    templateId: string;
    kind: string;
    name: string;
    title: string;
    inputParams: string[];
    connected: boolean;
    mock: boolean;
  }[];
}
interface EvidenceCard {
  id: string;
  ticketId: string | null;
  kind: string;
  templateName: string;
  title: string;
  summary: string;
  excerpt: string;
  resultCount: number;
}

test.describe.serial('AC-5: one click investigates a webhook_not_received ticket', () => {
  let head: Person;
  let agent: Person;
  let ticket: StaffTicket;
  const genericName = `ac5-logs-${unique('g').slice(-6)}`;
  const scopedName = `ac5-org-${unique('o').slice(-6)}`;
  let genericTitle = '';

  async function person(browser: Browser, role: 'head' | 'agent'): Promise<Person> {
    const { context, page } = await newActor(browser);
    await signInDev(page, role, unique(role));
    return { context, page, api: new Api(context.request) };
  }

  test.beforeAll(async ({ browser }) => {
    head = await person(browser, 'head');
    agent = await person(browser, 'agent');
  });

  test.afterAll(async () => {
    for (const who of [head, agent]) await who.context.close();
  });

  test('setup: a mail about missing webhooks becomes a webhook_not_received ticket; the head saves two log templates', async () => {
    const tag = unique('ac5');
    const customer = `${unique('ops')}@${ORGS.acme.domain}`;
    fakeGmail({
      from: customer,
      subject: `Webhooks are not arriving ${tag}`,
      body: 'Our webhook callbacks have not been delivered since this morning. Please check the delivery logs.',
    });
    await expect
      .poll(
        async () => {
          const all = await agent.api.all<StaffTicket>('/v1/tickets');
          const found = all.find((candidate) => candidate.subject.includes(tag));
          if (found) ticket = found;
          return found?.intent?.key;
        },
        { message: 'the mail became a classified ticket' },
      )
      .toBe('webhook_not_received');
    expect(ticket.org.name).toBe(ORGS.acme.name);

    genericTitle = 'Delivery errors (last hour)';
    const generic = await head.api.post('/v1/tools/templates', {
      kind: 'logs',
      name: genericName,
      title: genericTitle,
      intentKey: 'webhook_not_received',
      body: 'service="example-delivery" severity>=ERROR',
      runByAi: false,
    });
    expect(generic.status).toBe(201);
    const scoped = await head.api.post('/v1/tools/templates', {
      kind: 'logs',
      name: scopedName,
      title: 'Errors of this organization',
      intentKey: 'webhook_not_received',
      body: 'service="example-delivery" labels.org_ref={{org_id}}',
      runByAi: false,
    });
    expect(scoped.status).toBe(201);
  });

  test("the ticket shows the intent's buttons; one click in the browser pins an evidence card", async () => {
    const buttons = await agent.api.get<ToolButtons>(`/v1/tickets/${ticket.id}/tools`);
    expect(buttons.status).toBe(200);
    expect(buttons.json.intentKey).toBe('webhook_not_received');
    const generic = buttons.json.buttons.find((button) => button.name === genericName);
    expect(generic, "the intent's template is a button of the ticket").toBeDefined();
    expect(generic).toMatchObject({ kind: 'logs', connected: true, mock: true, inputParams: [] });

    await agent.page.goto(`/?ticket=${ticket.key}`);
    const investigate = agent.page.getByRole('region', { name: 'Investigate' });
    await expect(investigate).toBeVisible();
    const empty = await agent.api.get<{ items: unknown[] }>(`/v1/tickets/${ticket.id}/evidence`);
    expect(empty.json.items).toEqual([]);

    // One click, no typed value.
    await investigate.getByRole('button', { name: genericTitle }).click();
    const pinned = investigate.getByRole('list', { name: 'Pinned results' });
    await expect(pinned.getByRole('article')).toHaveCount(1);
    await expect(pinned).toContainText(`Logs: ${genericTitle}`);
    // The card says it is sample data, not the real system.
    await expect(pinned).toContainText('Mock');

    const cards = await agent.api.get<{ items: EvidenceCard[] }>(
      `/v1/tickets/${ticket.id}/evidence`,
    );
    expect(cards.json.items, 'exactly one card for one click').toHaveLength(1);
    const card = cards.json.items[0];
    expect(card).toMatchObject({ ticketId: ticket.id, kind: 'logs', templateName: genericName });
    expect(card?.resultCount, 'the fixture has delivery errors').toBeGreaterThan(0);
    expect(card?.summary).toMatch(/log entries/);
    // N4: personal data of the fixture lines is replaced before a card is stored or shown.
    expect(card?.excerpt).not.toContain('jane.doe@example.com');
    expect(card?.excerpt).not.toContain('+66 81 234 5678');
  });

  test("the template scoped to the organization finds none of the other organizations' lines", async () => {
    const buttons = await agent.api.get<ToolButtons>(`/v1/tickets/${ticket.id}/tools`);
    const scoped = buttons.json.buttons.find((button) => button.name === scopedName);
    expect(scoped?.inputParams, 'org_id is filled from the ticket, never typed').toEqual([]);
    const run = await agent.api.post<EvidenceCard>(`/v1/tickets/${ticket.id}/tools/run`, {
      templateId: scoped?.templateId,
    });
    expect(run.status).toBe(201);
    expect(run.json.resultCount).toBe(0);
    expect(run.json.excerpt).not.toContain('other customer');
    expect(run.json.excerpt).not.toContain('sam.example@example.org');
    // The caller cannot choose another organization.
    const forged = await agent.api.post(`/v1/tickets/${ticket.id}/tools/run`, {
      templateId: scoped?.templateId,
      params: { org_id: '22222222-2222-4222-8222-222222222222' },
    });
    expect(forged.status).toBe(400);
  });

  test('the Logging rate budget holds: people clicking far more than 20 a minute are accepted at most 20 each and 55 together', async ({
    browser,
  }) => {
    const buttons = await agent.api.get<ToolButtons>(`/v1/tickets/${ticket.id}/tools`);
    const templateId = buttons.json.buttons.find(
      (button) => button.name === genericName,
    )?.templateId;
    expect(templateId).toBeDefined();

    // The budget window is one minute. Start early in a minute so the burst cannot straddle two windows.
    const secondsIntoMinute = new Date().getSeconds();
    if (secondsIntoMinute > 30) {
      await new Promise((resolve) => setTimeout(resolve, (62 - secondsIntoMinute) * 1_000));
    }

    const people = [
      agent,
      ...(await Promise.all([
        person(browser, 'agent'),
        person(browser, 'agent'),
        person(browser, 'agent'),
      ])),
    ];
    try {
      const attemptsEach = PERSON_PER_MINUTE + 10;
      const results = await Promise.all(
        people.map(async (who) => {
          const out: { status: number; retryAfter: string | null }[] = [];
          for (let i = 0; i < attemptsEach; i += 1) {
            const response = await who.api.post(`/v1/tickets/${ticket.id}/tools/run`, {
              templateId,
            });
            out.push({
              status: response.status,
              retryAfter: response.headers['retry-after'] ?? null,
            });
          }
          return out;
        }),
      );
      const accepted = results.map((list) => list.filter((r) => r.status === 201).length);
      const refused = results.flatMap((list) => list.filter((r) => r.status === 429));
      const others = results.flatMap((list) =>
        list.filter((r) => r.status !== 201 && r.status !== 429),
      );
      console.log(
        `[AC-5] logging budget: accepted per person ${accepted.join('/')} (total ${String(accepted.reduce((a, b) => a + b, 0))}), refused ${String(refused.length)}`,
      );
      expect(others, 'nothing but 201 and 429').toEqual([]);
      for (const count of accepted) expect(count).toBeLessThanOrEqual(PERSON_PER_MINUTE);
      expect(accepted.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(TOTAL_PER_MINUTE);
      expect(refused.length, 'the budget actually refused something').toBeGreaterThan(0);
      for (const r of refused)
        expect(r.retryAfter, 'a refusal says when to come back').not.toBeNull();
    } finally {
      for (const who of people.slice(1)) await who.context.close();
    }
  });
});
