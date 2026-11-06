import { useQueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AssistantMemory, AssistantReply } from '@watchtower/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthGate } from '@/components/auth-gate';
import { SESSION_QUERY_KEY } from '@/lib/auth/session-key';
import { assistantKeys } from '@/lib/assistant/library';
import { resetAssistantHiddenCache } from '@/lib/assistant/assistant-ui';
import { consoleApi } from '@/test/console-api';
import { makeSession, uuid } from '@/test/fixtures';
import { apiError, type MockHandler } from '@/test/mock-api';
import { renderApp } from '@/test-utils';

import { AssistantBubble } from './assistant-bubble';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
}));
const AT = '2026-11-06T00:00:00.000Z';
const CONVERSATION = uuid(601);
const MESSAGE = uuid(602);
const answer: AssistantReply = {
  conversationId: CONVERSATION,
  messageId: MESSAGE,
  locale: 'en',
  state: 'ok',
  reason: null,
  claims: [{ text: 'Displayed private sentence', evidence: [], uncited: true }],
  proposals: [],
  tools: [],
};
const memoryItem = (n = 1): AssistantMemory => ({
  id: uuid(n + 700),
  body: `Redacted [PERSON_${String(n)}] fact`,
  refs: [],
  sourceMessageId: MESSAGE,
  createdAt: AT,
  lastUsedAt: AT,
  expiresAt: '2027-01-01T00:00:00.000Z',
});
const preview = {
  id: CONVERSATION,
  locale: 'en',
  createdAt: AT,
  updatedAt: AT,
  messageCount: 2,
  preview: 'Question by [PERSON_1]',
};

function SwitchUser({ onSwitch }: { onSwitch: () => void }) {
  const client = useQueryClient();
  return (
    <button
      onClick={() => {
        onSwitch();
        const previous = makeSession('agent');
        client.setQueryData(SESSION_QUERY_KEY, {
          ...previous,
          user: { ...previous.user, id: uuid(999) },
        });
      }}
    >
      Switch test user
    </button>
  );
}

function setup(overrides: Record<string, MockHandler> = {}, onSwitch = () => undefined) {
  const api = consoleApi({
    role: 'agent',
    overrides: {
      'GET /v1/assistant/starters': {
        json: {
          state: 'ok',
          reason: null,
          starters: [],
          limits: { messagesPerHour: 30, remainingThisHour: 30 },
        },
      },
      'POST /v1/assistant/messages': { json: answer },
      'GET /v1/assistant/conversations': { json: { items: [preview] } },
      'GET /v1/assistant/memory': { json: { items: [] } },
      ...overrides,
    },
  });
  renderApp(
    <AuthGate>
      <SwitchUser onSwitch={onSwitch} />
      <AssistantBubble />
    </AuthGate>,
  );
  return api;
}
async function open() {
  await userEvent.click(await screen.findByTestId('assistant-bubble'));
}
async function ask() {
  const input = await screen.findByRole('textbox', { name: 'Ask the AI assistant' });
  await userEvent.type(input, 'ask privately{Enter}');
  await screen.findByTestId('assistant-answer');
}
beforeEach(() => {
  localStorage.clear();
  resetAssistantHiddenCache();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('assistant history, pins and feedback', () => {
  it('a deferred delete of A cannot clear or abort a new B SSE turn', async () => {
    let finishDelete: (result: { json: { deleted: true } }) => void = () => undefined;
    let deleted = false;
    const api = setup({
      'GET /v1/assistant/conversations': () => ({ json: { items: deleted ? [] : [preview] } }),
      'DELETE /v1/assistant/conversations/:id': () =>
        new Promise((resolve) => {
          finishDelete = resolve;
        }),
    });
    let requests = 0;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (!url.endsWith('/v1/assistant/messages') || ++requests === 1)
        return api.fetchMock(input, init);
      signal = init?.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    });
    await open();
    await ask();
    await userEvent.click(screen.getByText('My chat history'));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Ask the AI assistant' }),
      'B pending{Enter}',
    );
    await act(async () => {
      deleted = true;
      finishDelete({ json: { deleted: true } });
      await Promise.resolve();
    });
    await screen.findByText('No saved chats.');
    expect(screen.getByText('B pending')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible();
    expect(signal?.aborted).toBe(false);
    await act(async () => {
      controller.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ phase: 'reply', reply: { ...answer, conversationId: uuid(604) } })}\n\n`,
        ),
      );
      await Promise.resolve();
    });
    expect(await screen.findByTestId('assistant-answer')).toBeVisible();
  });
  it('keeps history on New chat; lists server previews; explicit deletion retries and clears only after success', async () => {
    let loads = 0;
    let deletes = 0;
    const api = setup({
      'GET /v1/assistant/conversations': () =>
        ++loads === 1
          ? apiError(500, 'internal_error')
          : { json: { items: deletes >= 2 ? [] : [preview] } },
      'DELETE /v1/assistant/conversations/:id': () =>
        ++deletes === 1 ? apiError(500, 'internal_error') : { json: { deleted: true } },
    });
    await open();
    await ask();
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.queryByTestId('assistant-answer')).not.toBeInTheDocument();
    expect(api.callsTo(`/v1/assistant/conversations/${CONVERSATION}`, 'DELETE')).toHaveLength(0);
    await ask();
    await userEvent.click(screen.getByText('My chat history'));
    const history = await screen.findByRole('region', { name: 'My chat history' });
    await userEvent.click(await within(history).findByRole('button', { name: 'Try again' }));
    expect(await within(history).findByText(preview.preview)).toBeVisible();
    await userEvent.click(within(history).getByRole('button', { name: 'Delete chat' }));
    expect(await screen.findByText('Could not delete. Try again.')).toBeVisible();
    expect(screen.getByTestId('assistant-answer')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(screen.queryByTestId('assistant-answer')).not.toBeInTheDocument();
    });
    expect(await within(history).findByText('No saved chats.')).toBeVisible();
    expect(deletes).toBe(2);
  });

  it('pins only a server messageId/claim, forgets individually/all, and sends feedback reason without text', async () => {
    let items: AssistantMemory[] = [];
    let feedbackAttempts = 0;
    const api = setup({
      'GET /v1/assistant/memory': () => ({ json: { items } }),
      'POST /v1/assistant/memory': () => {
        items = [memoryItem()];
        return { json: items[0] };
      },
      'DELETE /v1/assistant/memory/:id': () => {
        items = [];
        return { json: { deleted: true } };
      },
      'DELETE /v1/assistant/memory': () => {
        items = [];
        return { json: { deleted: 1 } };
      },
      'POST /v1/assistant/feedback': (request) => {
        if (++feedbackAttempts === 1) return apiError(500, 'internal_error');
        const body = request.body as {
          target: { kind: 'message'; id: string };
          rating: 'up' | 'down';
          reason?: string;
        };
        return { json: { id: uuid(710), ...body, reason: body.reason ?? null, updatedAt: AT } };
      },
    });
    await open();
    await ask();
    await userEvent.click(await screen.findByRole('button', { name: 'Remember this sentence' }));
    expect(await screen.findByRole('button', { name: 'Remembered' })).toBeDisabled();
    expect(api.callsTo('/v1/assistant/memory', 'POST')[0]?.body).toEqual({
      messageId: MESSAGE,
      claim: 0,
    });
    await userEvent.click(screen.getByText('Remembered facts'));
    const memory = await screen.findByRole('region', { name: 'Remembered facts' });
    expect(await within(memory).findByText(memoryItem().body)).toBeVisible();
    await userEvent.click(within(memory).getByRole('button', { name: 'Forget' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remember this sentence' })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Remember this sentence' }));
    await within(memory).findByText(memoryItem().body);
    await userEvent.click(within(memory).getByRole('button', { name: 'Forget all' }));
    expect(await within(memory).findByText('No remembered facts.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Not helpful' }));
    expect(api.callsTo('/v1/assistant/feedback', 'POST')).toHaveLength(0);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Reason' }), 'misleading');
    await userEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    await screen.findByText('Could not save feedback. Try again.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Feedback saved')).toBeVisible();
    expect(api.callsTo('/v1/assistant/feedback', 'POST').map((call) => call.body)).toEqual(
      Array.from({ length: 2 }, () => ({
        target: { kind: 'message', id: MESSAGE },
        rating: 'down',
        reason: 'misleading',
      })),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Helpful' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Helpful' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
    expect(api.callsTo('/v1/assistant/feedback', 'POST').at(-1)?.body).toEqual({
      target: { kind: 'message', id: MESSAGE },
      rating: 'up',
    });
  });

  it('disables new pins at 20 and handles a server-side full race without optimistic success', async () => {
    let items: AssistantMemory[] = Array.from({ length: 20 }, (_, n) => memoryItem(n));
    const api = setup({
      'GET /v1/assistant/memory': () => ({ json: { items } }),
      'DELETE /v1/assistant/memory/:id': () => {
        items = items.slice(1);
        return { json: { deleted: true } };
      },
      'POST /v1/assistant/memory': apiError(409, 'assistant_memory_full'),
    });
    await open();
    await ask();
    await screen.findByText('You have 20 remembered facts. Forget one before adding another.');
    expect(screen.getByRole('button', { name: 'Remember this sentence' })).toBeDisabled();
    expect(api.callsTo('/v1/assistant/memory', 'POST')).toHaveLength(0);
    await userEvent.click(screen.getByText('Remembered facts'));
    const memory = await screen.findByRole('region', { name: 'Remembered facts' });
    const firstForget = within(memory).getAllByRole('button', { name: 'Forget' })[0];
    if (!firstForget) throw new Error('missing forget button');
    await userEvent.click(firstForget);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remember this sentence' })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Remember this sentence' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You have 20 remembered facts.');
    expect(screen.queryByRole('button', { name: 'Remembered' })).not.toBeInTheDocument();
  });

  it('scopes cached reads by user and drops thread, draft and pending mutation state on session change', async () => {
    let switched = false;
    let finishPin: (value: { json: AssistantMemory }) => void = () => undefined;
    setup(
      {
        'GET /v1/assistant/memory': () => ({ json: { items: switched ? [] : [memoryItem()] } }),
        'GET /v1/assistant/conversations': () => ({ json: { items: switched ? [] : [preview] } }),
        'POST /v1/assistant/memory': () =>
          new Promise((resolve) => {
            finishPin = resolve;
          }),
      },
      () => {
        switched = true;
      },
    );
    await open();
    await ask();
    await userEvent.click(screen.getByText('My chat history'));
    await screen.findByText(preview.preview);
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Ask the AI assistant' }),
      'unsent secret draft',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remember this sentence' }));
    await userEvent.click(screen.getByRole('button', { name: 'Switch test user' }));
    expect(screen.queryByText('Displayed private sentence')).not.toBeInTheDocument();
    expect(screen.queryByText(preview.preview)).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Ask the AI assistant' })).toHaveValue('');
    await act(async () => {
      finishPin({ json: memoryItem(2) });
      await Promise.resolve();
    });
    await userEvent.click(screen.getByText('Remembered facts'));
    expect(await screen.findByText('No remembered facts.')).toBeVisible();
    expect(screen.queryByText(memoryItem(2).body)).not.toBeInTheDocument();
    expect(assistantKeys(uuid(900)).memory).toEqual(['user', uuid(900), 'assistant', 'memory']);
    expect(assistantKeys(uuid(999)).conversations).not.toEqual(
      assistantKeys(uuid(900)).conversations,
    );
  });
});
