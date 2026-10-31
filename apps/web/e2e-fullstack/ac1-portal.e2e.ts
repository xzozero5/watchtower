import { PORTAL_URGENCY_PRIORITY } from '@watchtower/shared';
import type { BrowserContext, Page } from '@playwright/test';

import {
  Api,
  expect,
  Mailbox,
  newActor,
  ORGS,
  signInStaff,
  type StaffTicket,
  test,
  type TimelineEntryJson,
  unique,
} from './support';

/**
 * AC-1, portal path (PRD 4.1, 4.9): a customer submits on the portal; the ticket exists with its
 * organization, intent and SLA due times within 10 s; staff reply in the workspace; the customer
 * sees the reply on the tracking page; staff resolve; the customer gets the status email.
 * The browser, web, api, worker, Postgres, Redis and Mailpit are all real.
 */
const BUDGET_MS = 10_000;

/**
 * Opens an emailed link as a customer does, in a fresh page load. A link that differs from the page
 * already open only in its #fragment is a same-document navigation and does not reload the page
 * (docs/qa/bugs.md B-001), which a mail client opening a new tab never hits.
 */
async function openLink(page: Page, link: string): Promise<void> {
  await page.goto('about:blank');
  await page.goto(link);
}

interface Actor {
  context: BrowserContext;
  page: Page;
}

test.describe.serial('AC-1: portal submission to resolution', () => {
  let customer: Actor;
  let staff: Actor;
  let staffApi: Api;
  let mailbox: Mailbox;
  let ticketKey = '';
  let ticketId = '';
  let trackingLink = '';
  const requestText = `The export fails with a 500 (${unique('case')}).`;
  const replyText = `We found the cause and are fixing it (${unique('reply')}).`;
  const noteText = `INTERNAL ${unique('note')}: customer is on the old plan.`;

  test.beforeAll(async ({ browser }) => {
    // The customer writes from an address on Acme's claimed domain: the api places the ticket.
    mailbox = new Mailbox(`${unique('e2e-ada')}@${ORGS.acme.domain}`);
    customer = await newActor(browser);
    staff = await newActor(browser);
    await signInStaff(staff.page);
    staffApi = new Api(staff.context.request);
  });

  test.afterAll(async () => {
    await mailbox.delete();
    await customer.context.close();
    await staff.context.close();
  });

  const conversation = () => staff.page.getByRole('region', { name: 'Conversation' });
  const panel = () => staff.page.getByRole('region', { name: 'Details & AI' });

  test('submit on the portal: ticket with org, intent and SLA due within 10 s', async () => {
    const testInfo = test.info();
    const page = customer.page;
    await page.goto('/portal');
    // The page solves the proof of work itself in a Web Worker; Submit also waits for it.
    await expect(page.getByText('Verified. You can submit your request.')).toBeVisible();

    await page.getByLabel('Your name').fill('Ada Demo');
    await page.getByLabel('Email address').fill(mailbox.address);
    await page.getByLabel('What is it about?').selectOption('api_error');
    await page.getByRole('radio', { name: /Something is broken/ }).check();
    await page.getByLabel('What happened?').fill(requestText);

    // The clock starts at the click and stops when the ticket can be read, complete, through the
    // staff API: the same thing a person sees in the queue.
    const startedAt = Date.now();
    await page.getByRole('button', { name: 'Submit request' }).click();
    await page.waitForURL('**/portal/submitted');
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toContainText(/We received your request OPS-\d+/);
    ticketKey = /OPS-\d+/.exec((await heading.textContent()) ?? '')?.[0] ?? '';
    expect(ticketKey).not.toBe('');

    let ticket: StaffTicket | undefined;
    while (Date.now() - startedAt < BUDGET_MS + 5_000) {
      const found = await staffApi.get<StaffTicket>(`/v1/tickets/${ticketKey}`);
      if (found.status === 200) {
        ticket = found.json;
        break;
      }
      await page.waitForTimeout(100);
    }
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `[AC-1] submit click -> ticket ${ticketKey} readable with org/intent/SLA: ${String(elapsedMs)} ms (budget ${String(BUDGET_MS)} ms)`,
    );
    testInfo.annotations.push({ type: 'AC-1 time to ticket (ms)', description: String(elapsedMs) });

    expect(ticket, 'the ticket exists').toBeDefined();
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
    if (!ticket) return;
    ticketId = ticket.id;
    expect(ticket.org.name).toBe(ORGS.acme.name);
    expect(ticket.channel).toBe('portal');
    expect(ticket.intent?.key).toBe('api_error');
    expect(ticket.priority).toBe(PORTAL_URGENCY_PRIORITY.something_broken);
    expect(ticket.slaPolicyId, 'an SLA policy was applied').not.toBeNull();
    const now = Date.now();
    for (const due of [ticket.firstResponseDueAt, ticket.resolutionDueAt]) {
      expect(due, 'an SLA due time is set').not.toBeNull();
      expect(Date.parse(due ?? '')).toBeGreaterThan(now - 60_000);
    }
    expect(Date.parse(ticket.resolutionDueAt ?? '')).toBeGreaterThan(
      Date.parse(ticket.firstResponseDueAt ?? ''),
    );
  });

  test('the staff queue and ticket details show the new ticket', async () => {
    const page = staff.page;
    await page.goto(`/?ticket=${ticketKey}`);
    await expect(
      conversation().getByRole('heading', { name: requestText, level: 3 }),
    ).toBeVisible();
    const row = page.getByRole('listbox', { name: 'Tickets' }).getByRole('option', {
      name: new RegExp(ticketKey),
    });
    await expect(row).toBeVisible();
    await expect(row).toContainText(ORGS.acme.name);

    // Properties live in the right-hand "Details & AI" panel; fields are inline comboboxes.
    const details = panel();
    await expect(details).toContainText(ORGS.acme.name);
    await expect(details).toContainText('Portal');
    const intentName = (await staffApi.get<StaffTicket>(`/v1/tickets/${ticketKey}`)).json.intent
      ?.name;
    expect(intentName).toBe('API error');
    await expect(details.getByRole('button', { name: /^Intent:/ })).toContainText(
      intentName ?? 'missing',
    );
    // The SLA badge is shown with a running (not "none") state, and a first-response time is set.
    await expect(conversation().locator('[data-sla]')).toBeVisible();
    await expect(details).not.toContainText('Not set');
  });

  test('the customer gets a confirmation email whose link opens the tracking page', async () => {
    const email = await mailbox.next(new RegExp(`We received your request ${ticketKey}\\b`));
    expect(email.text).toContain(requestText.slice(0, 20));
    trackingLink = email.link;
    expect(new URL(trackingLink).pathname).toBe(`/portal/tickets/${ticketKey}`);

    const page = customer.page;
    await page.goto(trackingLink);
    await expect(page.getByRole('heading', { name: ticketKey, level: 1 })).toBeVisible();
    await expect(page.getByText('Received', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Conversation' }).getByText(requestText),
    ).toBeVisible();
    // The secret in the link is moved out of the address bar.
    expect(page.url()).not.toContain('token=');
  });

  test('staff reply in the workspace; the customer sees it on the tracking page', async () => {
    const page = staff.page;
    await page.goto(`/?ticket=${ticketKey}`);
    const body = page.getByRole('textbox', { name: 'Public reply' });
    await body.fill(replyText);
    await page.getByRole('button', { name: 'Send reply', exact: true }).click();
    await expect(page.getByText('Reply sent.')).toBeVisible();
    // It is in the timeline of the workspace too.
    await expect(conversation().getByText(replyText)).toBeVisible();

    const reply = await mailbox.next(new RegExp(`New reply on ${ticketKey}\\b`));
    expect(reply.text).toContain(ticketKey);
    expect(reply.text, 'the email names the reply, not its text').not.toContain(replyText);

    const cust = customer.page;
    await openLink(cust, reply.link);
    const timeline = cust.getByRole('region', { name: 'Conversation' });
    await expect(timeline.getByText(replyText)).toBeVisible();
    await expect(timeline.getByText(requestText)).toBeVisible();

    const details = await staffApi.get<{ firstRespondedAt: string | null }>(
      `/v1/tickets/${ticketKey}`,
    );
    expect(
      details.json.firstRespondedAt,
      'the first response is recorded for the SLA',
    ).not.toBeNull();
  });

  test('an internal note stays inside: not on the tracking page, no email', async () => {
    const page = staff.page;
    await page.goto(`/?ticket=${ticketKey}`);
    await page.getByRole('radio', { name: 'Internal note' }).click();
    await page.getByRole('textbox', { name: 'Internal note' }).fill(noteText);
    await page.getByRole('button', { name: 'Add note', exact: true }).click();
    await expect(page.getByText('Note added.')).toBeVisible();
    await expect(conversation().getByText(noteText)).toBeVisible();

    const cust = customer.page;
    await openLink(cust, trackingLink);
    await expect(
      cust.getByRole('region', { name: 'Conversation' }).getByText(requestText),
    ).toBeVisible();
    await expect(cust.getByText(noteText)).toHaveCount(0);
    await expect(cust.getByText('INTERNAL')).toHaveCount(0);

    const subjects = await mailbox.subjects();
    expect(subjects.filter((subject) => subject.includes(ticketKey))).toHaveLength(2);
    const timeline = await staffApi.get<{ entries: TimelineEntryJson[] }>(
      `/v1/tickets/${ticketId}/timeline`,
    );
    expect(
      timeline.json.entries.some((e) => e.visibility === 'internal' && e.bodyText === noteText),
    ).toBe(true);
  });

  test('staff resolve the ticket; the customer receives the status email and sees Resolved', async () => {
    const page = staff.page;
    await page.goto(`/?ticket=${ticketKey}`);
    const details = panel();
    await details.getByRole('button', { name: /^Status:/ }).click();
    await page.getByRole('option', { name: /^Resolved/ }).click();
    await expect(details.getByText('Saved.')).toBeVisible();

    const email = await mailbox.next(new RegExp(`${ticketKey} is now: Resolved`));
    expect(email.text).toContain('The status of your request');
    expect(email.text).toContain('reopen it');

    const cust = customer.page;
    await openLink(cust, email.link);
    await expect(cust.getByRole('heading', { name: ticketKey, level: 1 })).toBeVisible();
    await expect(cust.getByText('Resolved', { exact: true }).first()).toBeVisible();
    await expect(
      cust.getByRole('region', { name: 'Conversation' }).getByText(replyText),
    ).toBeVisible();
    await expect(cust.getByText(noteText)).toHaveCount(0);

    const after = await staffApi.get<{ status: string; resolvedAt: string | null }>(
      `/v1/tickets/${ticketKey}`,
    );
    expect(after.json.status).toBe('resolved');
    expect(after.json.resolvedAt).not.toBeNull();
  });

  // Known bug B-001 (docs/qa/bugs.md): the page open in this tab is for the same ticket, so a newer
  // emailed link that differs only in its #fragment does not reload it and the new reply is missing.
  // `test.fail` keeps the suite green while the bug exists and turns red when it is fixed: then
  // delete the `test.fail` line (and the openLink workaround above).
  test('B-001: a newer emailed link opened in the same tab shows the new reply', async () => {
    test.fail();
    const followUp = `One more thing: please retry the export (${unique('later')}).`;
    const sent = await staffApi.post(`/v1/tickets/${ticketId}/replies`, { body: followUp });
    expect(sent.status).toBe(201);
    const email = await mailbox.next(new RegExp(`New reply on ${ticketKey}\\b`));

    const cust = customer.page; // still on the tracking page of the previous test
    await cust.goto(email.link);
    await expect(
      cust.getByRole('region', { name: 'Conversation' }).getByText(followUp),
    ).toBeVisible({ timeout: 5_000 });
  });
});
