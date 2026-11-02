import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import {
  DRAFT_ID,
  makeInsight,
  makeInvestigatingInsight,
  makeLowConfidenceInsight,
  makeUncitedInsight,
} from '../src/test/ai-fixtures';
import { DELIVERY_ID, makeMessage, makeScheduledReply } from '../src/test/fixtures';

import { boardTickets } from './ai-board';
import { type BackendOptions, mockBackend } from './backend';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function openWorkspace(page: Page, options: BackendOptions = {}, path = '/') {
  const backend = await mockBackend(page, { tickets: boardTickets(), ...options });
  await page.goto(path);
  await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-state', 'open');
  return backend;
}

const conversation = (page: Page) => page.getByRole('region', { name: 'Conversation' });
const queue = (page: Page) => page.getByRole('region', { name: 'Queue' });

test.describe('triage board', () => {
  test('groups tickets into Needs you, AI working and Waiting and walks them with J', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWorkspace(page);
    for (const [name, count] of [
      ['Needs you', '3'],
      ['AI working', '1'],
      ['Waiting', '1'],
    ] as const) {
      await expect(queue(page).getByRole('button', { name: new RegExp(`^${name}`) })).toContainText(
        count,
      );
    }
    // Two lines per ticket: the AI summary (the subject, muted, when it said nothing) and its state.
    const first = page.getByRole('option', { name: /OPS-1/ });
    await expect(first).toContainText('Locked out after a reset; reply is ready');
    await expect(first).toContainText('Draft ready');
    await expect(page.getByRole('option', { name: /OPS-5/ })).toContainText('Plain old subject');
    await expect(page.getByRole('option', { name: /OPS-2/ })).toContainText('Investigating');

    // "Needs you" sorts breached first (OPS-4: P1, first response overdue), then priority (OPS-1 P2, OPS-5 default).
    await page.keyboard.press('j');
    await expect(page.getByRole('option', { name: /OPS-4/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('j');
    await expect(page.getByRole('option', { name: /OPS-1/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('j');
    // OPS-4, OPS-1, OPS-5 are "Needs you"; the next row is the first of "AI working".
    await page.keyboard.press('j');
    await expect(page.getByRole('option', { name: /OPS-2/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('listbox', { name: 'AI working' })).toBeFocused();

    // A section folds with its header, reachable by keyboard.
    await queue(page)
      .getByRole('button', { name: /^Waiting/ })
      .focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('option', { name: /OPS-3/ })).toHaveCount(0);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`the board has no axe violations in ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 1440, height: 900 });
      await openWorkspace(page);
      await expect(page.getByRole('option', { name: /OPS-1/ })).toBeVisible();
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(results.violations).toEqual([]);
    });
  }
});

test.describe('ticket with an AI brief', () => {
  const messages = (ticket = boardTickets()[0]) =>
    ticket
      ? [
          makeMessage(1, ticket, {
            bodyText: 'I reset my password and now I cannot sign in at all.',
            createdAt: '2026-11-02T02:50:00.000Z',
          }),
        ]
      : [];

  test('opens with the brief, a draft and the evidence tab; approving previews, then the server holds the reply', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const ticket = boardTickets()[0];
    if (!ticket) throw new Error('no ticket');
    let sent = false;
    const insight = makeInsight();
    const withoutDraft = { ...insight };
    delete withoutDraft.draft;
    const backend = await openWorkspace(
      page,
      {
        ai: { 'OPS-1': insight },
        timelines: { 'OPS-1': messages(ticket) },
        routes: {
          'POST /v1/tickets/OPS-1/replies': () => {
            sent = true;
            return {
              status: 201,
              json: { message: makeScheduledReply(90, ticket, 30_000), ticket },
            };
          },
          'GET /v1/tickets/OPS-1/ai': () => ({
            json: sent ? { ...withoutDraft, state: 'classified' } : insight,
          }),
        },
      },
      '/?ticket=OPS-1',
    );

    const brief = conversation(page).getByRole('region', { name: 'AI brief' });
    await expect(brief).toContainText('Cannot sign in after a reset');
    await expect(brief.getByRole('meter', { name: 'Confidence High 0.86' })).toBeVisible();
    await expect(brief).toContainText('Stage 2 · Draft for approval');
    await expect(brief).toContainText('AI · prompt v3');
    // The composer is out of the way; the right-hand panel opens on Details, Evidence is one click away.
    await expect(conversation(page).getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Details' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByRole('tab', { name: 'Evidence' }).click();
    await expect(page.getByRole('tab', { name: 'Evidence' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      page.getByRole('tabpanel', { name: 'Evidence' }).getByRole('listitem'),
    ).toHaveCount(2);

    // An evidence chip points at its card.
    await brief.getByRole('button', { name: /^KB article: Unlocking/ }).click();
    await expect(page.locator('#evidence-card-ev-kb-1')).toBeFocused();

    // Approve: the preview shows the exact text; nothing is sent until it is confirmed.
    await page.keyboard.press('Escape');
    await conversation(page)
      .getByTestId('ai-draft')
      .getByRole('button', { name: /^Approve/ })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Send this reply?' });
    await expect(dialog).toContainText('Hello Riley, your account was locked');
    expect(backend.to('POST', '/v1/tickets/OPS-1/replies')).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Approve and send' }).click();

    // The reply goes to the server at once, bound to the draft; the server holds it for the undo window.
    await expect.poll(() => backend.to('POST', '/v1/tickets/OPS-1/replies').length).toBe(1);
    expect(backend.to('POST', '/v1/tickets/OPS-1/replies')[0]?.body).toMatchObject({
      body: expect.stringContaining('Hello Riley, your account was locked'),
      aiDraftId: DRAFT_ID,
    });
    await expect(conversation(page).getByTestId('pending-send')).toContainText('Sending in');
    await expect(conversation(page).getByTestId('ai-draft')).toHaveCount(0);
  });

  test('Undo asks the server to cancel the delivery and the draft comes back', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const ticket = boardTickets()[0];
    if (!ticket) throw new Error('no ticket');
    let sent = false;
    const insight = makeInsight();
    const withoutDraft = { ...insight };
    delete withoutDraft.draft;
    const backend = await openWorkspace(
      page,
      {
        ai: { 'OPS-1': insight },
        routes: {
          'POST /v1/tickets/OPS-1/replies': () => {
            sent = true;
            return {
              status: 201,
              json: { message: makeScheduledReply(90, ticket, 30_000), ticket },
            };
          },
          [`POST /v1/tickets/OPS-1/deliveries/${DELIVERY_ID}/cancel`]: () => {
            sent = false;
            return {
              json: {
                delivery: {
                  ...makeScheduledReply(90, ticket).delivery,
                  state: 'cancelled',
                  cancellable: false,
                },
                messageId: makeScheduledReply(90, ticket).id,
                deliveryStatus: 'cancelled',
              },
            };
          },
          'GET /v1/tickets/OPS-1/ai': () => ({
            json: sent ? { ...withoutDraft, state: 'classified' } : insight,
          }),
        },
      },
      '/?ticket=OPS-1',
    );
    const draft = conversation(page).getByTestId('ai-draft');
    await expect(draft).toBeVisible();
    await draft.getByRole('button', { name: /^Approve/ }).click();
    await page
      .getByRole('dialog', { name: 'Send this reply?' })
      .getByRole('button', { name: 'Approve and send' })
      .click();
    const bar = conversation(page).getByTestId('pending-send');
    await expect(bar).toBeVisible();
    await bar.getByRole('button', { name: 'Undo' }).click();
    await expect
      .poll(() => backend.to('POST', `/v1/tickets/OPS-1/deliveries/${DELIVERY_ID}/cancel`).length)
      .toBe(1);
    await expect(conversation(page).getByTestId('ai-draft')).toBeVisible();
    await expect(bar).toHaveCount(0);
  });

  test('rejecting asks for a reason and records the code', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const backend = await openWorkspace(
      page,
      { ai: { 'OPS-1': makeUncitedInsight() } },
      '/?ticket=OPS-1',
    );
    await expect(conversation(page).getByTestId('ai-draft')).toContainText('1 uncited');
    await conversation(page)
      .getByTestId('ai-draft')
      .getByRole('button', { name: /^Reject/ })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Reject this draft' });
    await expect(dialog.getByRole('button', { name: 'Reject' })).toBeDisabled();
    await page.keyboard.press('4');
    await expect(dialog.getByRole('radio', { name: /^Not supported by evidence/ })).toBeChecked();
    await dialog.getByRole('button', { name: 'Reject' }).click();
    await expect
      .poll(() => backend.to('POST', `/v1/tickets/OPS-1/ai/drafts/${DRAFT_ID}/reject`).length)
      .toBe(1);
    expect(backend.to('POST', `/v1/tickets/OPS-1/ai/drafts/${DRAFT_ID}/reject`)[0]?.body).toEqual({
      reason: 'not_grounded',
    });
    await expect(dialog).toHaveCount(0);
  });

  test('shows low confidence in words and lets the person take over', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWorkspace(page, { ai: { 'OPS-1': makeLowConfidenceInsight() } }, '/?ticket=OPS-1');
    const brief = conversation(page).getByRole('region', { name: 'AI brief' });
    await expect(brief).toContainText('Low confidence');
    await expect(conversation(page).getByTestId('ai-draft')).toHaveCount(0);
    await brief.getByRole('button', { name: 'Write myself' }).click();
    await expect(conversation(page).getByRole('textbox', { name: 'Public reply' })).toBeFocused();
  });

  test('shows an investigating brief without a draft', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWorkspace(page, { ai: { 'OPS-2': makeInvestigatingInsight() } }, '/?ticket=OPS-2');
    const brief = conversation(page).getByRole('region', { name: 'AI brief' });
    await expect(brief).toContainText('Investigating');
    await expect(conversation(page).getByTestId('ai-draft')).toHaveCount(0);
  });

  test('says "AI brief unavailable" and nothing more when the api has no brief', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWorkspace(page, {}, '/?ticket=OPS-5');
    await expect(conversation(page).getByText('AI brief unavailable')).toBeVisible();
    await expect(conversation(page).getByRole('region', { name: 'AI brief' })).toHaveCount(0);
    // With nothing to take over from, the composer is simply open.
    await expect(conversation(page).getByRole('textbox', { name: 'Public reply' })).toBeVisible();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`a ticket with a brief, a draft and the evidence tab has no axe violations in ${scheme} mode`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 1440, height: 900 });
      await openWorkspace(
        page,
        { ai: { 'OPS-1': makeUncitedInsight() }, timelines: { 'OPS-1': messages() } },
        '/?ticket=OPS-1',
      );
      await expect(conversation(page).getByTestId('ai-draft')).toBeVisible();
      await page.getByRole('tab', { name: 'Evidence' }).click();
      await expect(page.getByRole('tab', { name: 'Evidence' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      const check = async () => {
        const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
        expect(results.violations).toEqual([]);
      };
      await check();

      await page.keyboard.press('a');
      await expect(page.getByRole('dialog', { name: 'Send this reply?' })).toBeVisible();
      await check();
      await page.keyboard.press('Escape');

      await page.keyboard.press('r');
      await expect(page.getByRole('dialog', { name: 'Reject this draft' })).toBeVisible();
      await check();
    });
  }
});
