import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { handoff } from '../src/test/shift-fixtures';

import { mockShift, OPEN_P1 } from './shift-backend';

const CONFIRM_PATH = `/v1/handoffs/${handoff().id}/confirm`;
const sections = (page: Page) => page.getByRole('navigation', { name: 'Shift sections' });

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
}

async function expectNoViolations(page: Page) {
  // On a soft navigation Next removes the <title> and puts it back when the new page's metadata has
  // streamed in, which can be after the URL and the page body have already changed (measured: the
  // title was missing in ~1 of 3 runs under load). Scan the page once it is whole, not mid-swap;
  // the `document-title` rule still runs below.
  await expect(page).toHaveTitle(/\S/);
  // A toast that is still fading in has a transient opacity that axe reads as low contrast.
  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .exclude('[data-sonner-toaster]')
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html ?? ''}`)).toEqual([]);
}

// AC-7 in the browser: a person with an open P1 ticket cannot leave the shift until the handoff is
// confirmed with a next action for it; the lead then sees nothing left unacknowledged.
test.describe('AC-7: clock out is gated by the handoff', () => {
  test('clock out stays disabled and says why, until the handoff is confirmed, then it works', async ({
    page,
  }) => {
    const backend = await mockShift(page);
    await open(page, '/shift');

    const clockOut = page.getByRole('button', { name: 'Clock out' });
    await expect(clockOut).toHaveAttribute('aria-disabled', 'true');
    await expect(
      page.getByText('Finish the handoff first: 1 item needs a next action'),
    ).toBeVisible();
    const blockers = page.getByRole('list', { name: 'What is missing' });
    await expect(blockers).toContainText(OPEN_P1.key);
    await expect(blockers).toContainText('not in the handoff');
    await expectNoViolations(page);

    // Pressing it sends nothing (`force`: Playwright treats aria-disabled as not clickable).
    await clockOut.click({ force: true });
    expect(backend.to('POST', '/v1/shifts/clock-out')).toHaveLength(0);

    await page.getByRole('link', { name: 'Go to the handoff' }).click();
    await page.waitForURL('**/shift/handoff**');
    await page.getByRole('button', { name: 'Start the handoff' }).click();
    const field = page.getByRole('textbox', { name: `Next action for ${OPEN_P1.key}` });
    await expect(field).toBeVisible();

    // Confirming with no next action is refused on the page, before anything is sent.
    await page.getByRole('button', { name: 'Confirm handoff' }).click();
    const summary = page
      .getByRole('alert')
      .filter({ hasText: 'The handoff cannot be confirmed yet' });
    await expect(summary).toBeVisible();
    await expectNoViolations(page);
    await summary.getByRole('link', { name: `Fix ${OPEN_P1.key}` }).click();
    await expect(field).toBeFocused();
    expect(backend.to('POST', CONFIRM_PATH)).toHaveLength(0);

    await field.fill('Wait for the customer log file');
    await page.getByRole('button', { name: 'Confirm handoff' }).click();
    await expect(page.getByText(/^Confirmed .* The incoming shift can see it\.$/)).toBeVisible();
    expect(backend.state.confirmed).toBe(true);

    // The gate is open now.
    await sections(page).getByRole('link', { name: 'My shift' }).click();
    await page.waitForURL('**/shift');
    const open_ = page.getByRole('button', { name: 'Clock out' });
    await expect(open_).not.toHaveAttribute('aria-disabled', 'true');
    await open_.click();
    await expect(page.getByText('You are off shift')).toBeVisible();
    expect(backend.to('POST', '/v1/shifts/clock-out')).toHaveLength(1);
  });

  test('a 409 handoff_incomplete from the api lists the blockers, whatever the status said', async ({
    page,
  }) => {
    const backend = await mockShift(page, { staleStatus: true });
    await open(page, '/shift');
    const clockOut = page.getByRole('button', { name: 'Clock out' });
    await expect(clockOut).not.toHaveAttribute('aria-disabled', 'true');
    await clockOut.click();

    const blockers = page.getByRole('list', { name: 'What is missing' });
    await expect(blockers).toContainText(OPEN_P1.key);
    await expect(blockers).toContainText('P1');
    await expect(page.getByRole('button', { name: 'Clock out' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(backend.to('POST', '/v1/shifts/clock-out')).toHaveLength(1);
    expect(backend.state.clockedOut).toBe(false);
    await expectNoViolations(page);
  });
});

test.describe('AC-7: acknowledgment and the lead view', () => {
  test('answering every handoff item with the keyboard brings the lead view to 0 unacknowledged', async ({
    page,
  }) => {
    await mockShift(page, { role: 'lead', incoming: 2 });
    await open(page, '/shift/overview');
    await expect(page.getByTestId('unack-summary')).toContainText('2 unacknowledged');

    await sections(page).getByRole('link', { name: 'Daily brief' }).click();
    await page.waitForURL('**/shift/brief');
    await expect(page.getByTestId('ack-progress')).toHaveText('0 of 2 acknowledged');
    await expectNoViolations(page);

    const items = page.getByRole('list', { name: 'Handoff items' }).getByRole('listitem');
    await items.first().focus();
    await page.keyboard.press('1');
    await expect(page.getByTestId('ack-progress')).toHaveText('1 of 2 acknowledged');
    await items.nth(1).focus();
    await page.keyboard.press('1');
    await expect(page.getByTestId('ack-progress')).toHaveText('All items are acknowledged (2).');

    await sections(page).getByRole('link', { name: 'Lead view' }).click();
    await page.waitForURL('**/shift/overview');
    await expect(page.getByTestId('unack-summary')).toContainText('0 unacknowledged');
    await expectNoViolations(page);
  });
});

test.describe('shift notes and roster admin', () => {
  test('have no accessibility violations and are reachable by keyboard shortcuts', async ({
    page,
  }) => {
    await mockShift(page, { role: 'lead' });
    await open(page, '/shift/notes');
    await expect(page.getByRole('heading', { name: 'Leave a note' })).toBeVisible();
    await expectNoViolations(page);

    await open(page, '/admin/shifts');
    await expect(page.getByRole('region', { name: 'Roster for 2026-11-02' })).toBeVisible();
    await expectNoViolations(page);
    await page.getByRole('tab', { name: 'Shifts' }).click();
    await expect(page.getByRole('table', { name: 'Shifts' })).toBeVisible();
    await expectNoViolations(page);

    // g then b goes to the daily brief from anywhere.
    await page.keyboard.press('g');
    await page.keyboard.press('b');
    await page.waitForURL('**/shift/brief');
  });
});
