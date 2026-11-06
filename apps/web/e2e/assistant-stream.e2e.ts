import { expect, test } from '@playwright/test';
import type { AssistantPhaseEvent, AssistantReply } from '@watchtower/shared';

import { mockBackend } from './backend';

declare global {
  interface Window {
    t407a: { posts: number; cancels: number; accept: string | null; csrf: string | null };
  }
}

// Browser-only mock: keep a real ReadableStream open so phases and abort are observable separately.
// All other API calls use the existing page.route backend; this flow cannot call a live AI.
test('Ask AI palette → queue/phases → Stop → checked reply and C22 warning', async ({ page }) => {
  const backend = await mockBackend(page, {
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
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    let active: ReadableStreamDefaultController<Uint8Array> | null = null;
    window.t407a = { posts: 0, cancels: 0, accept: null, csrf: null };
    window.addEventListener('t407a-phase', (event) => {
      active?.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify((event as CustomEvent).detail)}\n\n`),
      );
    });
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (!url.endsWith('/v1/assistant/messages')) return original(input, init);
      window.t407a.posts++;
      window.t407a.accept = new Headers(init?.headers).get('accept');
      window.t407a.csrf = new Headers(init?.headers).get('x-csrf-token');
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              active = controller;
            },
            cancel() {
              active = null;
              window.t407a.cancels++;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    };
  });
  const emit = (event: AssistantPhaseEvent) =>
    page.evaluate((detail) => {
      window.dispatchEvent(new CustomEvent('t407a-phase', { detail }));
    }, event);
  await page.goto('/');
  await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('Ask AI');
  await page.getByRole('option', { name: /Ask AI/ }).click();
  const input = page.getByRole('textbox', { name: 'Ask the AI assistant' });
  await input.fill('Check my queue');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.t407a.posts)).toBe(1);
  await emit({ phase: 'queued', position: 2 });
  await expect(page.getByText('In queue · position 2')).toBeVisible();
  await emit({ phase: 'context', chips: [] });
  await expect(page.getByText('Checking context')).toBeVisible();
  await emit({ phase: 'tool', name: 'ticket_get', status: 'running' });
  await expect(page.getByText('Checking ticket_get')).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('Stopped. You can ask again.')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.t407a.cancels)).toBe(1);
  await expect(page.getByTestId('assistant-answer')).toHaveCount(0);
  await input.fill('Suggest an internal note');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.t407a.posts)).toBe(2);
  await emit({ phase: 'answering' });
  await expect(page.getByText('Preparing answer')).toBeVisible();
  const reply: AssistantReply = {
    conversationId: '11111111-1111-4111-8111-111111111111',
    messageId: '22222222-2222-4222-8222-222222222222',
    state: 'ok',
    reason: null,
    locale: 'en',
    claims: [],
    tools: [],
    hadCustomerContent: true,
    proposals: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        kind: 'note',
        status: 'pending',
        target: null,
        changes: [],
        text: 'Review before saving',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    ],
  };
  await emit({ phase: 'reply', reply });
  await expect(page.getByTestId('proposal-customer-warning')).toHaveText(
    'Created from a conversation with customer text — review before confirming',
  );
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.t407a)).toMatchObject({
    posts: 2,
    cancels: 2,
    accept: 'text/event-stream',
    csrf: 'csrf-token-for-tests',
  });
  expect(backend.requests.filter((r) => r.method === 'POST')).toEqual([]);
});
