import { expect, test } from '@playwright/test';
import type { AssistantMemory, AssistantReply } from '@watchtower/shared';

import { mockBackend } from './backend';

// JSON compatibility on the original POST; assistant-stream.e2e.ts covers SSE separately.
// Every assistant request is answered by mockBackend, with no live AI or outbound delivery.
test('own assistant library: New chat preserves history, claim pins, feedback and explicit deletion retry', async ({ page }) => {
  const firstConversation = '11111111-1111-4111-8111-111111111111';
  const conversation = '22222222-2222-4222-8222-222222222222';
  const message = '33333333-3333-4333-8333-333333333333';
  const at = '2026-11-06T00:00:00.000Z';
  const fact: AssistantMemory = {
    id: '44444444-4444-4444-8444-444444444444',
    body: 'Remembered [PERSON_1] fact',
    refs: [],
    sourceMessageId: message,
    createdAt: at,
    lastUsedAt: at,
    expiresAt: '2027-01-01T00:00:00.000Z',
  };
  const reply: AssistantReply = {
    conversationId: conversation,
    messageId: message,
    state: 'ok',
    reason: null,
    locale: 'en',
    claims: [
      { text: 'First example sentence', evidence: [], uncited: true },
      { text: 'Second example sentence', evidence: [], uncited: true },
    ],
    proposals: [],
    tools: [],
  };
  let turns = 0;
  let items: AssistantMemory[] = [];
  let deletes = 0;
  const preview = (id: string, text: string) => ({
    id, locale: 'en', createdAt: at, updatedAt: at, messageCount: 2, preview: text,
  });
  const backend = await mockBackend(page, {
    routes: {
      'GET /v1/assistant/starters': () => ({ json: {
        state: 'ok', reason: null, starters: [],
        limits: { messagesPerHour: 30, remainingThisHour: 30 },
      } }),
      'POST /v1/assistant/messages': () => ({ json: ++turns === 1
        ? { ...reply, conversationId: firstConversation, messageId: '55555555-5555-4555-8555-555555555555' }
        : reply }),
      'GET /v1/assistant/conversations': () => ({ json: { items: [
        preview(firstConversation, 'Earlier [PERSON_1] question'),
        ...(turns >= 2 && deletes < 2 ? [preview(conversation, 'Current [PERSON_2] question')] : []),
      ] } }),
      'GET /v1/assistant/memory': () => ({ json: { items } }),
      'POST /v1/assistant/memory': () => {
        items = [fact];
        return { json: fact };
      },
      [`DELETE /v1/assistant/memory/${fact.id}`]: () => {
        items = [];
        return { json: { deleted: true } };
      },
      'POST /v1/assistant/feedback': (request) => ({ json: {
        id: '66666666-6666-4666-8666-666666666666',
        ...(request.body as object), updatedAt: at,
      } }),
      [`DELETE /v1/assistant/conversations/${conversation}`]: () => ++deletes === 1
        ? { status: 500, json: { code: 'internal_error', message: 'Mock deletion failed', statusCode: 500 } }
        : { json: { deleted: true } },
    },
  });

  await page.goto('/');
  await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
  await page.getByTestId('assistant-bubble').click();
  const input = page.getByRole('textbox', { name: 'Ask the AI assistant' });
  await input.fill('First example question');
  await input.press('Enter');
  await expect(page.getByTestId('assistant-answer')).toHaveCount(1);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(page.getByTestId('assistant-answer')).toHaveCount(0);
  expect(backend.requests.filter((request) => request.method === 'DELETE')).toEqual([]);

  await input.fill('Second example question');
  await input.press('Enter');
  await expect(page.getByTestId('assistant-answer')).toHaveCount(1);
  expect(backend.to('POST', '/v1/assistant/messages').map((request) => request.body)).toEqual([
    expect.not.objectContaining({ conversationId: expect.anything() }),
    expect.not.objectContaining({ conversationId: expect.anything() }),
  ]);
  await page.getByRole('button', { name: 'Remember this sentence', exact: true }).nth(1).click();
  await expect(page.getByRole('button', { name: 'Remembered', exact: true })).toBeDisabled();
  expect(backend.to('POST', '/v1/assistant/memory').map((request) => request.body)).toEqual([
    { messageId: message, claim: 1 },
  ]);
  await page.getByText('Remembered facts', { exact: true }).click();
  const memory = page.getByRole('region', { name: 'Remembered facts' });
  await expect(memory.getByText(fact.body, { exact: true })).toBeVisible();
  await memory.getByRole('button', { name: 'Forget', exact: true }).click();
  await expect(memory.getByText('No remembered facts.', { exact: true })).toBeVisible();
  expect(backend.to('DELETE', `/v1/assistant/memory/${fact.id}`)).toHaveLength(1);

  await page.getByRole('button', { name: 'Not helpful', exact: true }).click();
  expect(backend.to('POST', '/v1/assistant/feedback')).toHaveLength(0);
  await page.getByRole('combobox', { name: 'Reason', exact: true }).selectOption('misleading');
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(page.getByText('Feedback saved', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Not helpful', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(backend.to('POST', '/v1/assistant/feedback').map((request) => request.body)).toEqual([
    { target: { kind: 'message', id: message }, rating: 'down', reason: 'misleading' },
  ]);

  await page.getByText('My chat history', { exact: true }).click();
  const history = page.getByRole('region', { name: 'My chat history' });
  await expect(history.getByText('Earlier [PERSON_1] question', { exact: true })).toBeVisible();
  const current = history.getByRole('listitem').filter({ hasText: 'Current [PERSON_2] question' });
  await current.getByRole('button', { name: 'Delete chat', exact: true }).click();
  await expect(page.getByText('Could not delete. Try again.', { exact: true })).toBeVisible();
  await expect(current).toBeVisible();
  await expect(page.getByTestId('assistant-answer')).toHaveCount(1);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(current).toHaveCount(0);
  await expect(page.getByTestId('assistant-answer')).toHaveCount(0);
  await expect(history.getByText('Earlier [PERSON_1] question', { exact: true })).toBeVisible();
  expect(backend.to('DELETE', `/v1/assistant/conversations/${conversation}`)).toHaveLength(2);
  expect(backend.to('DELETE', `/v1/assistant/conversations/${firstConversation}`)).toHaveLength(0);
});
