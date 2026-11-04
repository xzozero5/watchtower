import AxeBuilder from '@axe-core/playwright';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import {
  Api,
  expect,
  findOrgId,
  newActor,
  signInDev,
  signInStaff,
  test,
  unique,
  type StaffTicket,
} from './support';

/**
 * AC-7 and PRD 5.4 in a real browser against the real stack: an agent cannot clock out with an open
 * assigned P1 ticket that has no handoff entry; the incoming agent sees it in the brief and must
 * acknowledge it (keyboard only); the lead's view shows 0 unacknowledged items afterwards.
 * Agent, incoming agent and lead each sign in through the mock identity provider (dev login).
 */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

interface Person {
  context: BrowserContext;
  page: Page;
  api: Api;
  id: string;
  email: string;
}

async function expectNoViolations(page: Page): Promise<void> {
  // A toast that is still fading in has a transient opacity that axe reads as low contrast.
  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .exclude('[data-sonner-toaster]')
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html ?? ''}`)).toEqual([]);
}

test.describe.serial('AC-7 / 5.4: clock out is gated by the handoff', () => {
  let head: Person;
  let outgoing: Person;
  let incoming: Person;
  let lead: Person;
  let p1: StaffTicket;
  const subject = `P1 outage for the shift test ${unique('p1')}`;
  const nextAction = `Wait for the customer's log file ${unique('na')}`;

  async function person(browser: Browser, role: 'agent' | 'lead', name: string): Promise<Person> {
    const { context, page } = await newActor(browser);
    const { email } = await signInDev(page, role, name);
    const api = new Api(context.request);
    const session = await api.get<{ user: { id: string } }>('/v1/auth/session');
    return { context, page, api, id: session.json.user.id, email };
  }

  async function clockIn(who: Person): Promise<void> {
    await who.page.goto('/shift');
    await who.page.getByRole('button', { name: 'Clock in' }).first().click();
    const dialog = who.page.getByRole('dialog', { name: 'Clock in' });
    await expect(dialog).toBeVisible();
    // Nobody is on the roster in a fresh stack: the dialog asks to confirm clocking in anyway.
    await dialog.getByRole('button', { name: /^Clock in( anyway)?$/ }).click();
    await expect(who.page.getByText('Clocked in.').first()).toBeVisible();
  }

  test.beforeAll(async ({ browser }) => {
    const { context, page } = await newActor(browser);
    await signInStaff(page);
    const api = new Api(context.request);
    const session = await api.get<{ user: { id: string } }>('/v1/auth/session');
    head = { context, page, api, id: session.json.user.id, email: 'break-glass' };
    outgoing = await person(browser, 'agent', unique('out'));
    incoming = await person(browser, 'agent', unique('in'));
    lead = await person(browser, 'lead', unique('lead'));
  });

  test.afterAll(async () => {
    for (const who of [head, outgoing, incoming, lead]) await who.context.close();
  });

  test('the outgoing agent clocks in and takes an open P1 ticket', async () => {
    await clockIn(outgoing);
    const orgId = await findOrgId(head.api, 'Acme Logistics');
    const created = await head.api.post<{ ticket: StaffTicket }>('/v1/tickets/manual', {
      orgId,
      channel: 'phone',
      subject,
      body: 'The whole integration is down for this customer.',
      requester: { email: `${unique('caller')}@acme-logistics.example.com`, name: 'Caller' },
      priority: 'P1',
    });
    expect(created.status).toBe(201);
    p1 = created.json.ticket;
    expect(p1.priority).toBe('P1');
    const assigned = await head.api.post(`/v1/tickets/${p1.id}/assign`, {
      assigneeId: outgoing.id,
    });
    expect(assigned.status).toBeLessThan(300);
  });

  test('clock out is blocked with the P1 ticket named; the api refuses too (409)', async () => {
    const page = outgoing.page;
    await page.goto('/shift');
    const clockOut = page.getByRole('button', { name: 'Clock out' });
    await expect(clockOut).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText(/Finish the handoff first/)).toBeVisible();
    const blockers = page.getByRole('list', { name: 'What is missing' });
    await expect(blockers).toContainText(p1.key);
    await expect(blockers).toContainText('not in the handoff');
    await expectNoViolations(page);

    const refused = await outgoing.api.post<{ code: string; blockers: { ticketId: string }[] }>(
      '/v1/shifts/clock-out',
      {},
    );
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('handoff_incomplete');
    expect(refused.json.blockers.map((blocker) => blocker.ticketId)).toContain(p1.id);
  });

  test('the handoff cannot be confirmed without a next action; with one, clock out works', async () => {
    const page = outgoing.page;
    await page.getByRole('link', { name: 'Go to the handoff' }).click();
    await page.waitForURL('**/shift/handoff**');
    await page.getByRole('button', { name: 'Start the handoff' }).click();
    const field = page.getByRole('textbox', { name: `Next action for ${p1.key}` });
    await expect(field).toBeVisible();
    await expectNoViolations(page);

    await page.getByRole('button', { name: 'Confirm handoff' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'The handoff cannot be confirmed yet' }),
    ).toBeVisible();

    await field.fill(nextAction);
    await page.getByRole('button', { name: 'Confirm handoff' }).click();
    await expect(page.getByText(/^Confirmed .* The incoming shift can see it\.$/)).toBeVisible();

    await page.goto('/shift');
    const clockOut = page.getByRole('button', { name: 'Clock out' });
    await expect(clockOut).not.toHaveAttribute('aria-disabled', 'true');
    await clockOut.click();
    await expect(page.getByText('You are off shift')).toBeVisible();
  });

  test('the lead sees the item unacknowledged', async () => {
    const page = lead.page;
    await page.goto('/shift/overview');
    await expect(page.getByTestId('unack-summary')).toContainText('1 unacknowledged');
    await expect(page.getByRole('region', { name: /Unacknowledged handoff items/ })).toContainText(
      p1.key,
    );
    await expectNoViolations(page);
  });

  test('the incoming agent sees it in the brief and acknowledges it with the keyboard only', async () => {
    await clockIn(incoming);
    const page = incoming.page;
    await page.goto('/shift/brief');
    await expect(page.getByTestId('ack-progress')).toHaveText('0 of 1 acknowledged');
    const items = page.getByRole('list', { name: 'Handoff items' }).getByRole('listitem');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText(p1.key);
    await expect(items.first()).toContainText(nextAction);
    await expectNoViolations(page);

    // Keyboard only: focus the item, "1" accepts it (the shortcut shown on the page).
    await items.first().focus();
    await page.keyboard.press('1');
    await expect(page.getByTestId('ack-progress')).toHaveText('All items are acknowledged (1).');

    // Accepting hands the ticket over.
    const moved = await incoming.api.get<StaffTicket>(`/v1/tickets/${p1.key}`);
    expect(moved.json.assignee?.id).toBe(incoming.id);
  });

  test('the lead view then shows 0 unacknowledged', async () => {
    const page = lead.page;
    await page.goto('/shift/overview');
    await expect(page.getByTestId('unack-summary')).toContainText('0 unacknowledged');
    await expect(
      page.getByRole('region', { name: /Unacknowledged handoff items/ }),
    ).not.toContainText(p1.key);
    await expectNoViolations(page);
  });
});
