import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AssistantReply,
  AssistantStarters,
  Role,
  AssistantPhaseEvent,
} from '@watchtower/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantBubble } from '@/components/assistant/assistant-bubble';
import { AuthGate } from '@/components/auth-gate';
import {
  requestAssistantOpen,
  resetAssistantHiddenCache,
  setAssistantHidden,
} from '@/lib/assistant/assistant-ui';
import { consoleApi } from '@/test/console-api';
import { makeAutonomy } from '@/test/console-fixtures';
import { apiError, type MockHandler } from '@/test/mock-api';
import { renderApp } from '@/test-utils';

let pathname = '/';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname,
}));

const CONVERSATION = '11111111-1111-4111-8111-111111111111';
const PROPOSAL = '22222222-2222-4222-8222-222222222222';
const AT = '2026-11-04T03:00:00.000Z';

const starters = (over: Partial<AssistantStarters> = {}): AssistantStarters => ({
  state: 'ok',
  reason: null,
  starters: [{ id: 'summary', text: 'Summarize this ticket' }],
  limits: { messagesPerHour: 30, remainingThisHour: 29 },
  ...over,
});

const reply = (over: Partial<AssistantReply> = {}): AssistantReply => ({
  conversationId: CONVERSATION,
  messageId: '33333333-3333-4333-8333-333333333333',
  state: 'ok',
  reason: null,
  locale: 'en',
  claims: [
    {
      text: 'The webhook failed twice since 09:00.',
      evidence: [{ kind: 'ticket', label: 'OPS-12', href: '/?ticket=OPS-12' }],
      uncited: false,
    },
    { text: 'It may be the new deploy.', evidence: [], uncited: true },
  ],
  tools: [{ name: 'ticket.read', status: 'ok', mock: false }],
  proposals: [],
  ...over,
});

function setup(
  options: {
    role?: Role;
    starters?: AssistantStarters;
    message?: MockHandler;
    overrides?: Record<string, MockHandler>;
    kill?: boolean;
  } = {},
) {
  const autonomy = makeAutonomy();
  if (options.kill) {
    const kill = autonomy.switches.find((item) => item.key === 'ai_kill_switch');
    if (kill) kill.on = true;
  }
  const api = consoleApi({
    role: options.role ?? 'agent',
    autonomy,
    overrides: {
      'GET /v1/assistant/starters': { json: options.starters ?? starters() },
      'POST /v1/assistant/messages': options.message ?? { json: reply() },
      ...options.overrides,
    },
  });
  renderApp(
    <AuthGate>
      <p>Page</p>
      <AssistantBubble />
    </AuthGate>,
  );
  return api;
}

const bubble = () => screen.findByTestId('assistant-bubble');

describe('T407a phase stream and customer warning', () => {
  it.each([
    { state: 'unavailable' as const, starterState: 'ok' as const, disabled: false },
    { state: 'paused' as const, starterState: 'ok' as const, disabled: true },
    { state: 'budget' as const, starterState: 'ok' as const, disabled: true },
  ])(
    'Retry → Stop clears transient $state while respecting starters $starterState',
    async ({ state, disabled }) => {
      const api = setup();
      let calls = 0;
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (!url.endsWith('/v1/assistant/messages')) return api.fetchMock(input, init);
        calls++;
        if (calls === 1)
          return Promise.resolve(
            new Response(
              `data: ${JSON.stringify({ phase: 'error', state, reason: 'assistant_queue_full' })}\n\n`,
              { headers: { 'content-type': 'text/event-stream' } },
            ),
          );
        return Promise.resolve(
          new Response(new ReadableStream<Uint8Array>(), {
            headers: { 'content-type': 'text/event-stream' },
          }),
        );
      });
      await userEvent.click(await bubble());
      const input = await screen.findByRole('textbox', { name: 'Ask the AI assistant' });
      await userEvent.type(input, 'check queue{Enter}');
      const retry = await screen.findByRole('button', { name: 'Try again' });
      await userEvent.click(retry);
      await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
      expect(await screen.findByText('Stopped. You can ask again.')).toBeVisible();
      expect(input).toHaveProperty('disabled', disabled);
    },
  );
  it.each(['Stop', 'New chat'])(
    'ignores a late response after %s, even if fetch ignores abort',
    async (button) => {
      const api = setup();
      let resolveOld: (response: Response) => void = () => undefined;
      let calls = 0;
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (!url.endsWith('/v1/assistant/messages')) return api.fetchMock(input, init);
        calls++;
        if (calls === 1)
          return new Promise<Response>((resolve) => {
            resolveOld = resolve;
          });
        return Promise.resolve(
          new Response(JSON.stringify(reply()), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      });
      await userEvent.click(await bubble());
      const input = await screen.findByRole('textbox', { name: 'Ask the AI assistant' });
      await userEvent.type(input, 'old question{Enter}');
      await userEvent.click(screen.getByRole('button', { name: button }));
      await userEvent.type(input, 'new question{Enter}');
      await screen.findByTestId('assistant-answer');
      await act(async () => {
        resolveOld(
          new Response(
            JSON.stringify(
              reply({ claims: [{ text: 'STALE RESPONSE', evidence: [], uncited: true }] }),
            ),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
        await Promise.resolve();
      });
      expect(screen.queryByText('STALE RESPONSE')).not.toBeInTheDocument();
      expect(screen.getAllByTestId('assistant-answer')).toHaveLength(1);
    },
  );
  it('shows queue/context/tool/answering, Stop cancels, and only the next completed reply appears', async () => {
    const api = setup();
    let stream: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (!url.endsWith('/v1/assistant/messages')) return api.fetchMock(input, init);
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
            cancel,
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    });
    const emit = async (event: AssistantPhaseEvent) => {
      await act(async () => {
        stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        await Promise.resolve();
      });
    };
    await userEvent.click(await bubble());
    const input = await screen.findByRole('textbox', { name: 'Ask the AI assistant' });
    await userEvent.type(input, 'first{Enter}');
    await emit({ phase: 'queued', position: 3 });
    expect(await screen.findByText('In queue · position 3')).toBeVisible();
    await emit({ phase: 'context', chips: [] });
    expect(await screen.findByText('Checking context')).toBeVisible();
    await emit({ phase: 'tool', name: 'ticket_get', status: 'running' });
    expect(await screen.findByText('Checking ticket_get')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Stopped. You can ask again.')).toBeVisible();
    expect(cancel).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('assistant-answer')).not.toBeInTheDocument();
    await userEvent.type(input, 'second{Enter}');
    await emit({ phase: 'answering' });
    expect(await screen.findByText('Preparing answer')).toBeVisible();
    await emit({ phase: 'reply', reply: reply() });
    expect(await screen.findByTestId('assistant-answer')).toBeVisible();
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it.each(['en', 'th'] as const)(
    'shows C22 only for customer-bearing turns (%s)',
    async (locale) => {
      const card = {
        id: PROPOSAL,
        kind: 'note' as const,
        status: 'pending' as const,
        target: null,
        changes: [],
        text: 'Review this note',
        expiresAt: AT,
      };
      consoleApi({
        overrides: {
          'GET /v1/assistant/starters': { json: starters() },
          'POST /v1/assistant/messages': {
            json: reply({ hadCustomerContent: true, proposals: [card] }),
          },
        },
      });
      renderApp(
        <AuthGate>
          <AssistantBubble />
        </AuthGate>,
        { locale },
      );
      await userEvent.click(await bubble());
      const input = await screen.findByRole('textbox', {
        name: locale === 'en' ? 'Ask the AI assistant' : 'ถามผู้ช่วย AI',
      });
      await userEvent.type(input, 'note{Enter}');
      expect(await screen.findByTestId('proposal-customer-warning')).toHaveTextContent(
        locale === 'en'
          ? 'Created from a conversation with customer text — review before confirming'
          : 'สร้างจากบทสนทนาที่มีข้อความลูกค้า — ตรวจก่อนกด',
      );
    },
  );
});

beforeEach(() => {
  localStorage.clear();
  resetAssistantHiddenCache();
  pathname = '/';
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AssistantBubble', () => {
  it('is a quiet button that opens the panel, with its state and shortcut announced', async () => {
    setup();
    const button = await bubble();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+/ Meta+/');
    expect(screen.queryByTestId('assistant-panel')).not.toBeInTheDocument();
    await userEvent.click(button);
    expect(await screen.findByRole('dialog', { name: 'Birdday' })).toBeVisible();
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows nothing to a customer, who holds no ticket read', async () => {
    consoleApi({ role: 'client' });
    renderApp(
      <AuthGate>
        <p>Page</p>
        <AssistantBubble />
      </AuthGate>,
    );
    await screen.findByText('Page');
    expect(screen.queryByTestId('assistant-bubble')).not.toBeInTheDocument();
  });

  it('Ctrl+/ opens and closes it, also from a text field; Esc closes and returns focus', async () => {
    setup();
    const button = await bubble();
    fireEvent.keyDown(document, { key: '/', code: 'Slash', ctrlKey: true });
    const input = await screen.findByRole('textbox', { name: 'Ask the AI assistant' });
    await waitFor(() => {
      expect(input).toHaveFocus();
    });
    fireEvent.keyDown(input, { key: '/', code: 'Slash', metaKey: true });
    await waitFor(() => {
      expect(screen.queryByTestId('assistant-panel')).not.toBeVisible();
    });
    fireEvent.keyDown(document, { key: '/', code: 'Slash', ctrlKey: true });
    await waitFor(() => {
      expect(screen.getByTestId('assistant-panel')).toBeVisible();
    });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.getByTestId('assistant-panel')).not.toBeVisible();
    });
    expect(button).toHaveFocus();
  });

  it('keeps what was typed when it is folded away', async () => {
    setup();
    await userEvent.click(await bubble());
    const input = await screen.findByRole('textbox', { name: 'Ask the AI assistant' });
    await userEvent.type(input, 'half a thought');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(await bubble());
    expect(await screen.findByRole('textbox', { name: 'Ask the AI assistant' })).toHaveValue(
      'half a thought',
    );
  });

  it('sends the page and the open ticket as chips, and the person can remove one', async () => {
    pathname = '/';
    window.history.replaceState(null, '', '/?ticket=OPS-12');
    const api = setup();
    await userEvent.click(await bubble());
    const group = await screen.findByRole('group', { name: 'Sent with your question' });
    expect(within(group).getByText('OPS-12')).toBeInTheDocument();
    expect(within(group).getByText('Ticket')).toBeInTheDocument();

    await userEvent.click(within(group).getByRole('button', { name: 'Do not send: Ticket' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Ask the AI assistant' }),
      'hi{Enter}',
    );
    await screen.findByTestId('assistant-answer');
    const sent = api.callsTo('/v1/assistant/messages', 'POST')[0]?.body as Record<string, unknown>;
    expect(sent).toMatchObject({ text: 'hi', locale: 'en', context: { ticket: 'OPS-12' } });
    expect((sent.context as Record<string, unknown>).page).toBeUndefined();
  });

  it('answers with claims and evidence links, and marks a claim with no evidence', async () => {
    setup();
    await userEvent.click(await bubble());
    await userEvent.click(await screen.findByRole('button', { name: 'Summarize this ticket' }));
    const answer = await screen.findByTestId('assistant-answer');
    const link = within(answer).getByRole('link', { name: 'OPS-12' });
    expect(link).toHaveAttribute('href', '/?ticket=OPS-12');
    expect(within(answer).getByText('It may be the new deploy.')).toBeInTheDocument();
    // Icon and words, not colour: the uncited claim says so.
    expect(within(answer).getByText('No evidence')).toBeInTheDocument();
    expect(within(answer).getByText('Steps taken (1)')).toBeInTheDocument();
  });

  it('says so when nothing is backed by evidence', async () => {
    setup({ message: { json: reply({ claims: [], tools: [] }) } });
    await userEvent.click(await bubble());
    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Ask the AI assistant' }),
      'anything{Enter}',
    );
    expect(await screen.findByText('No evidence found')).toBeInTheDocument();
  });

  it('labels a demo source and never turns a bad link into one', async () => {
    setup({
      message: {
        json: reply({
          claims: [
            {
              text: 'A similar case.',
              evidence: [
                { kind: 'kb', label: 'Webhook guide', mock: true },
                { kind: 'repo', label: 'abc123', href: 'https://example.com/c/abc123' },
              ],
              uncited: false,
            },
          ],
        }),
      },
    });
    await userEvent.click(await bubble());
    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Ask the AI assistant' }),
      'similar{Enter}',
    );
    const answer = await screen.findByTestId('assistant-answer');
    expect(within(answer).getByText('Demo')).toBeInTheDocument();
    expect(within(answer).queryByRole('link', { name: 'Webhook guide' })).not.toBeInTheDocument();
    const repo = within(answer).getByRole('link', { name: 'abc123' });
    expect(repo).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it.each([
    ['paused', 'AI is paused'],
    ['budget', 'AI budget used up'],
    ['unavailable', 'AI is offline'],
  ] as const)('closes the input when the assistant is %s', async (state, words) => {
    setup({ starters: starters({ state, reason: state, starters: [] }) });
    await userEvent.click(await bubble());
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Ask the AI assistant' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('shows the pause icon state on the button while the emergency switch is on', async () => {
    setup({ role: 'head', kill: true });
    const button = await bubble();
    await waitFor(() => {
      expect(button).toHaveAttribute('aria-label', 'Open Birdday (AI is paused)');
    });
  });

  it('keeps the message and offers Try again when the answer fails', async () => {
    let calls = 0;
    const api = setup({
      message: () => {
        calls += 1;
        return calls === 1 ? apiError(500, 'internal_error') : { json: reply() };
      },
    });
    await userEvent.click(await bubble());
    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Ask the AI assistant' }),
      'will it work{Enter}',
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not get an answer. Your message is still here.',
    );
    expect(screen.getByText('will it work')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('assistant-answer');
    expect(api.callsTo('/v1/assistant/messages', 'POST')).toHaveLength(2);
    // The retry is the same text and does not add a second copy of the question.
    expect(screen.getAllByText('will it work')).toHaveLength(1);
  });

  it('speaks Thai from the glossary when the app is in Thai', async () => {
    consoleApi({
      role: 'agent',
      overrides: { 'GET /v1/assistant/starters': { json: starters() } },
    });
    renderApp(
      <AuthGate>
        <AssistantBubble />
      </AuthGate>,
      { locale: 'th' },
    );
    await userEvent.click(await bubble());
    expect(await screen.findByRole('dialog', { name: 'Birdday' })).toBeVisible();
    expect(screen.getByRole('group', { name: 'ส่งไปพร้อมคำถาม' })).toBeInTheDocument();
  });

  it('never asks for a change without a card, and a card runs only on one press', async () => {
    const card = {
      id: PROPOSAL,
      kind: 'assign' as const,
      status: 'pending' as const,
      target: { key: 'OPS-12', label: 'OPS-12 Webhook', href: '/?ticket=OPS-12' },
      changes: [{ field: 'assignee', from: null, to: 'Mana' }],
      expiresAt: '2026-11-04T04:00:00.000Z',
    };
    const api = setup({
      message: { json: reply({ proposals: [card] }) },
      overrides: {
        'POST /v1/assistant/proposals/:id/confirm': {
          json: {
            outcome: 'done',
            proposal: { ...card, status: 'confirmed' },
            result: { key: 'OPS-12', href: '/?ticket=OPS-12' },
          },
        },
      },
    });
    await userEvent.click(await bubble());
    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Ask the AI assistant' }),
      'assign it to Mana{Enter}',
    );
    const proposal = await screen.findByTestId('assistant-proposal');
    // Server values, before -> after; focus did not jump to the button (a stray Enter cannot confirm).
    expect(within(proposal).getByText('Mana')).toBeInTheDocument();
    expect(within(proposal).queryByTestId('proposal-customer-warning')).not.toBeInTheDocument();
    expect(within(proposal).getByRole('button', { name: 'Confirm' })).not.toHaveFocus();
    expect(api.callsTo('/v1/assistant/proposals/' + PROPOSAL + '/confirm', 'POST')).toHaveLength(0);

    await userEvent.click(within(proposal).getByRole('button', { name: 'Confirm' }));
    expect(await within(proposal).findByText('Done')).toBeInTheDocument();
    expect(api.callsTo('/v1/assistant/proposals/' + PROPOSAL + '/confirm', 'POST')).toHaveLength(1);
    expect(within(proposal).queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
  });

  it('says nothing was done when the ticket changed after the card was made', async () => {
    const card = {
      id: PROPOSAL,
      kind: 'status' as const,
      status: 'pending' as const,
      target: null,
      changes: [{ field: 'status', from: 'open', to: 'resolved' }],
      expiresAt: AT,
    };
    setup({
      message: { json: reply({ proposals: [card] }) },
      overrides: {
        'POST /v1/assistant/proposals/:id/confirm': {
          json: { outcome: 'stale', proposal: { ...card, status: 'expired' }, result: null },
        },
      },
    });
    await userEvent.click(await bubble());
    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Ask the AI assistant' }),
      'resolve it{Enter}',
    );
    const proposal = await screen.findByTestId('assistant-proposal');
    await userEvent.click(within(proposal).getByRole('button', { name: 'Confirm' }));
    expect(
      await within(proposal).findByText(
        'The ticket changed after this card was made. Nothing was done.',
      ),
    ).toBeInTheDocument();
  });

  it('renders Birdday greeting, tagline, and BirddayAvatar in the empty state', async () => {
    setup();
    await userEvent.click(await bubble());
    expect(await screen.findByRole('dialog', { name: 'Birdday' })).toBeVisible();
    expect(screen.getByText('Cockatiel AI · Tech Ops')).toBeInTheDocument();
    expect(screen.getByText('Hi! Birdday is perched and ready.')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Ask about tickets, SLAs, incidents, or your shift — every sentence links to its source.',
      ),
    ).toBeInTheDocument();
    const avatars = document.querySelectorAll('[data-slot="birdday-avatar"]');
    expect(avatars.length).toBeGreaterThanOrEqual(1);
  });

  it('toggles chat panel width on desktop via widen/restore button', async () => {
    setup();
    await userEvent.click(await bubble());
    const panel = await screen.findByTestId('assistant-panel');
    expect(panel.className).toContain('md:w-[26.5rem]');
    expect(panel.className).not.toContain('md:w-[38rem]');

    const widenBtn = screen.getByRole('button', { name: 'Widen chat panel' });
    await userEvent.click(widenBtn);
    expect(panel.className).toContain('md:w-[38rem]');

    const restoreBtn = screen.getByRole('button', { name: 'Restore chat width' });
    await userEvent.click(restoreBtn);
    expect(panel.className).toContain('md:w-[26.5rem]');
  });

  it('displays live multi-step phase timeline when SSE sends multiple phases before reply', async () => {
    const api = setup();
    let stream: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (!url.endsWith('/v1/assistant/messages')) return api.fetchMock(input, init);
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    });
    const emit = async (event: AssistantPhaseEvent) => {
      await act(async () => {
        stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        await Promise.resolve();
      });
    };

    await userEvent.click(await bubble());
    const input = await screen.findByRole('textbox', { name: 'Ask the AI assistant' });
    await userEvent.type(input, 'investigate issue{Enter}');

    await emit({ phase: 'queued', position: 1 });
    expect(await screen.findByText('In queue · position 1')).toBeVisible();

    await emit({ phase: 'context', chips: [] });
    expect(await screen.findByText('Checking context')).toBeVisible();
    expect(screen.getByText('In queue · position 1')).toBeInTheDocument();

    await emit({ phase: 'tool', name: 'ticket_search', status: 'running' });
    expect(await screen.findByText('Checking ticket_search')).toBeVisible();
    expect(screen.getByText('Checking context')).toBeInTheDocument();

    await emit({ phase: 'answering' });
    expect(await screen.findByText('Preparing answer')).toBeVisible();
    expect(screen.getByText('Checking ticket_search')).toBeInTheDocument();

    await emit({ phase: 'reply', reply: reply() });
    expect(await screen.findByTestId('assistant-answer')).toBeVisible();
  });
});

describe('AssistantBubble: staying out of the way', () => {
  it('opens from the palette request, also when the button is hidden', async () => {
    setup();
    await bubble();
    requestAssistantOpen();
    expect(await screen.findByRole('dialog', { name: 'Birdday' })).toBeVisible();
  });

  it('hides the button by choice, and the shortcut still opens it and Esc gives focus back', async () => {
    setAssistantHidden(true);
    setup();
    await screen.findByText('Page');
    expect(screen.queryByTestId('assistant-bubble')).not.toBeInTheDocument();

    const origin = document.createElement('button');
    origin.textContent = 'Where I was';
    document.body.append(origin);
    origin.focus();
    fireEvent.keyDown(document, { key: '/', code: 'Slash', ctrlKey: true });
    const input = await screen.findByRole('textbox', { name: 'Ask the AI assistant' });
    await waitFor(() => {
      expect(input).toHaveFocus();
    });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.getByTestId('assistant-panel')).not.toBeVisible();
    });
    expect(origin).toHaveFocus();
    origin.remove();
  });

  it('brings the button back when the choice is undone', async () => {
    setAssistantHidden(true);
    setup();
    await screen.findByText('Page');
    expect(screen.queryByTestId('assistant-bubble')).not.toBeInTheDocument();
    act(() => {
      setAssistantHidden(false);
    });
    expect(await bubble()).toBeVisible();
  });

  it('steps aside while another dialog is open, and not for its own sheet', async () => {
    setup();
    await bubble();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('data-state', 'open');
    document.body.append(dialog);
    await waitFor(() => {
      expect(screen.queryByTestId('assistant-bubble')).not.toBeInTheDocument();
    });
    dialog.remove();
    expect(await bubble()).toBeVisible();
  });

  it('lifts above a bar at the foot of the window and settles back when it goes', async () => {
    setup();
    await bubble();
    const bar = document.createElement('form');
    bar.setAttribute('data-sticky-footer', '');
    bar.getBoundingClientRect = () =>
      ({
        top: window.innerHeight - 60,
        right: window.innerWidth,
        bottom: window.innerHeight,
        height: 60,
      }) as DOMRect;
    document.body.append(bar);
    await waitFor(async () => {
      expect((await bubble()).style.marginBottom).toBe('68px');
    });
    bar.remove();
    await waitFor(async () => {
      expect((await bubble()).style.marginBottom).toBe('');
    });
  });
});

describe('AssistantBubble: below 768 px', () => {
  const phone = () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  };

  it('is a modal sheet that takes focus, keeps the thread when closed, and returns focus', async () => {
    phone();
    setup();
    const button = await bubble();
    await userEvent.click(button);
    const sheet = await screen.findByRole('dialog', { name: 'Birdday' });
    expect(sheet).toHaveAttribute('data-assistant-surface');
    const input = within(sheet).getByRole('textbox', { name: 'Ask the AI assistant' });
    await waitFor(() => {
      expect(input).toHaveFocus();
    });
    // Modal: the page behind is hidden from assistive technology and focus cannot leave the sheet.
    expect(screen.getByText('Page', { selector: '[aria-hidden]' })).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    await userEvent.type(input, 'half a thought');
    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    expect(sheet).toContainElement(document.activeElement as HTMLElement);

    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(button).toHaveFocus();

    await userEvent.click(button);
    expect(await screen.findByRole('textbox', { name: 'Ask the AI assistant' })).toHaveValue(
      'half a thought',
    );
  });

  it('does not count its own sheet as "another dialog" (the button stays for its Close)', async () => {
    phone();
    setup();
    await userEvent.click(await bubble());
    await screen.findByRole('dialog', { name: 'Birdday' });
    // On a phone the button is hidden by CSS while the sheet covers the page, but it is not removed.
    expect(screen.getByTestId('assistant-bubble')).toBeInTheDocument();
  });
});
