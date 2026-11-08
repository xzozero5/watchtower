import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import type { AssistantPhaseEvent, AssistantReply } from '@watchtower/shared';

import { mockBackend } from './backend';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

declare global {
  interface Window {
    t410sse: { posts: number; cancels: number };
  }
}

/** Install in-browser mock for SSE streaming without calling live AI backend */
async function installSseMock(page: Page) {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    let active: ReadableStreamDefaultController<Uint8Array> | null = null;
    window.t410sse = { posts: 0, cancels: 0 };
    window.addEventListener('t410-phase', (event) => {
      active?.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify((event as CustomEvent).detail)}\n\n`),
      );
    });
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (!url.endsWith('/v1/assistant/messages')) return original(input, init);
      window.t410sse.posts++;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              active = controller;
            },
            cancel() {
              active = null;
              window.t410sse.cancels++;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    };
  });
}

function emitPhase(page: Page, event: AssistantPhaseEvent) {
  return page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('t410-phase', { detail }));
  }, event);
}

test.describe('T-410 Gate: Accessibility (Axe WCAG 2.x A/AA)', () => {
  test('assistant panel and palette have 0 axe violations', async ({ page }) => {
    await mockBackend(page, {
      routes: {
        'GET /v1/assistant/starters': () => ({
          json: {
            state: 'ok',
            reason: null,
            starters: [],
            limits: { messagesPerHour: 30, remainingThisHour: 30 },
          },
        }),
      },
    });

    await page.goto('/');
    await expect(page.locator('[data-hydrated="true"]')).toBeAttached();

    // 1. Open assistant panel via bubble button
    const bubble = page.getByTestId('assistant-bubble');
    await expect(bubble).toBeVisible();
    await bubble.click();

    const panel = page.getByTestId('assistant-panel');
    await expect(panel).toBeVisible();

    // Verify accessibility of open assistant panel
    const panelAxe = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(panelAxe.violations).toEqual([]);

    // 2. Open palette via Ctrl+K and test Ask AI option
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('combobox').fill('Ask AI');
    await expect(page.getByRole('option', { name: /Ask AI/ })).toBeVisible();

    const paletteAxe = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(paletteAxe.violations).toEqual([]);
  });
});

test.describe('T-410 Gate: Offline and Budget Handling', () => {
  test('offline state (provider_offline) renders notice and disables input', async ({ page }) => {
    await mockBackend(page, {
      routes: {
        'GET /v1/assistant/starters': () => ({
          json: {
            state: 'unavailable',
            reason: 'provider_offline',
            starters: [],
            limits: { messagesPerHour: 30, remainingThisHour: 30 },
          },
        }),
      },
    });

    await page.goto('/');
    await expect(page.locator('[data-hydrated="true"]')).toBeAttached();

    await page.getByTestId('assistant-bubble').click();
    const notice = page.getByTestId('assistant-state');
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute('data-state', 'unavailable');

    await expect(page.getByText('AI is offline')).toBeVisible();
    await expect(
      page.getByText('The AI cannot be reached right now. Everything else still works.'),
    ).toBeVisible();

    const input = page.getByRole('textbox', { name: 'Ask the AI assistant' });
    await expect(input).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();

    // Verify axe compliance of offline notice
    const axeResults = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(axeResults.violations).toEqual([]);
  });

  test('budget exceeded state (budget_stop) renders notice and disables input', async ({
    page,
  }) => {
    await mockBackend(page, {
      routes: {
        'GET /v1/assistant/starters': () => ({
          json: {
            state: 'budget',
            reason: 'budget_stop',
            starters: [],
            limits: { messagesPerHour: 30, remainingThisHour: 0 },
          },
        }),
      },
    });

    await page.goto('/');
    await expect(page.locator('[data-hydrated="true"]')).toBeAttached();

    await page.getByTestId('assistant-bubble').click();
    const notice = page.getByTestId('assistant-state');
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute('data-state', 'budget');

    await expect(page.getByText('AI budget used up')).toBeVisible();
    await expect(
      page.getByText('The AI budget is used up for today. Everything else still works.'),
    ).toBeVisible();

    const input = page.getByRole('textbox', { name: 'Ask the AI assistant' });
    await expect(input).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();

    // Verify axe compliance of budget notice
    const axeResults = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(axeResults.violations).toEqual([]);
  });
});

test.describe('T-410 Gate: Queue Positions and Queue Full Error', () => {
  test('in-queue position updates and assistant_queue_full emits rate error notice', async ({
    page,
  }) => {
    await installSseMock(page);
    await mockBackend(page, {
      routes: {
        'GET /v1/assistant/starters': () => ({
          json: {
            state: 'ok',
            reason: null,
            starters: [],
            limits: { messagesPerHour: 30, remainingThisHour: 30 },
          },
        }),
      },
    });

    await page.goto('/');
    await expect(page.locator('[data-hydrated="true"]')).toBeAttached();

    await page.getByTestId('assistant-bubble').click();
    const input = page.getByRole('textbox', { name: 'Ask the AI assistant' });
    await input.fill('What is the queue status?');
    await input.press('Enter');

    await expect.poll(() => page.evaluate(() => window.t410sse.posts)).toBe(1);

    // Queue position event
    await emitPhase(page, { phase: 'queued', position: 4 });
    await expect(page.getByText('In queue · position 4')).toBeVisible();

    // Queue full terminal error
    await emitPhase(page, { phase: 'error', state: 'unavailable', reason: 'assistant_queue_full' });
    await expect(
      page.getByText('You asked too many questions this hour. Try again later.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

test.describe('T-410 Gate: Streaming Stop & C-22 Proposal Warning', () => {
  test('stop button halts streaming; C-22 customer warning is displayed on proposal', async ({
    page,
  }) => {
    await installSseMock(page);
    await mockBackend(page, {
      routes: {
        'GET /v1/assistant/starters': () => ({
          json: {
            state: 'ok',
            reason: null,
            starters: [],
            limits: { messagesPerHour: 30, remainingThisHour: 30 },
          },
        }),
      },
    });

    await page.goto('/');
    await expect(page.locator('[data-hydrated="true"]')).toBeAttached();

    await page.getByTestId('assistant-bubble').click();
    const input = page.getByRole('textbox', { name: 'Ask the AI assistant' });

    // Step 1: Submit question and verify Stop button works
    await input.fill('Check ticket status');
    await input.press('Enter');
    await expect.poll(() => page.evaluate(() => window.t410sse.posts)).toBe(1);

    await emitPhase(page, { phase: 'context', chips: [] });
    await expect(page.getByText('Checking context')).toBeVisible();

    const stopButton = page.getByRole('button', { name: 'Stop', exact: true });
    await expect(stopButton).toBeVisible();
    await stopButton.click();

    await expect(page.getByText('Stopped. You can ask again.')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.t410sse.cancels)).toBe(1);

    // Step 2: Submit second query and receive C-22 flagged reply with proposal
    await input.fill('Suggest next action');
    await input.press('Enter');
    await expect.poll(() => page.evaluate(() => window.t410sse.posts)).toBe(2);

    await emitPhase(page, { phase: 'answering' });
    await expect(page.getByText('Preparing answer')).toBeVisible();

    const reply: AssistantReply = {
      conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      state: 'ok',
      reason: null,
      locale: 'en',
      claims: [],
      tools: [],
      hadCustomerContent: true,
      proposals: [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          kind: 'note',
          status: 'pending',
          target: null,
          changes: [],
          text: 'Internal follow-up note',
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      ],
    };

    await emitPhase(page, { phase: 'reply', reply });

    // C-22 Warning must be visible
    const warning = page.getByTestId('proposal-customer-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toHaveText(
      'Created from a conversation with customer text — review before confirming',
    );
    await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
  });
});
