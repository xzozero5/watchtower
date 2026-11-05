import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AssistantReply, AssistantStarters, Role } from '@watchtower/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AskAiButton } from '@/components/assistant/ask-ai-button';
import { AssistantBubble } from '@/components/assistant/assistant-bubble';
import { AuthGate } from '@/components/auth-gate';
import { resetAssistantHiddenCache } from '@/lib/assistant/assistant-ui';
import { entityStarters, pageStarters } from '@/lib/assistant/starters';
import { ASSISTANT_ENTITY_KINDS, ASSISTANT_PAGES } from '@watchtower/shared';
import { getMessages, translate } from '@/i18n';
import { consoleApi } from '@/test/console-api';
import { renderApp } from '@/test-utils';

let pathname = '/incidents';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname,
}));

const INCIDENT = '44444444-4444-4444-8444-444444444444';

const starters: AssistantStarters = {
  state: 'ok',
  reason: null,
  starters: [{ id: 'server', text: 'From the api' }],
  limits: { messagesPerHour: 30, remainingThisHour: 29 },
};

const reply: AssistantReply = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  messageId: '33333333-3333-4333-8333-333333333333',
  state: 'ok',
  reason: null,
  locale: 'en',
  claims: [{ text: 'Fine.', evidence: [], uncited: true }],
  tools: [],
  proposals: [],
};

function setup(role: Role = 'agent') {
  const api = consoleApi({
    role,
    overrides: {
      'GET /v1/assistant/starters': { json: starters },
      'POST /v1/assistant/messages': { json: reply },
    },
  });
  renderApp(
    <AuthGate>
      <AskAiButton entity={{ kind: 'incident', ref: INCIDENT }} label="INC-7" />
      <AssistantBubble />
    </AuthGate>,
  );
  return api;
}

beforeEach(() => {
  localStorage.clear();
  resetAssistantHiddenCache();
  pathname = '/incidents';
  window.history.replaceState(null, '', '/incidents');
});

describe('Ask AI about this', () => {
  it('opens the assistant with that one thing as a removable chip, and sends exactly that', async () => {
    const api = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Ask AI about INC-7' }));
    const group = await screen.findByRole('group', { name: 'Sent with your question' });
    expect(within(group).getByText('Incident: INC-7')).toBeInTheDocument();
    // The api only knows ticket prompts, so the entity's own prompts are shown, not the api's.
    expect(screen.queryByText('From the api')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Summarize this incident and its impact' }),
    ).toBeVisible();

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Ask the AI assistant' }),
      'why?{Enter}',
    );
    await screen.findByTestId('assistant-answer');
    const sent = api.callsTo('/v1/assistant/messages', 'POST')[0]?.body as {
      context: Record<string, unknown>;
    };
    expect(sent.context).toEqual({
      page: 'incident',
      entity: { kind: 'incident', ref: INCIDENT },
    });
    // The name on the chip is for the eye; it is not sent.
    expect(JSON.stringify(sent)).not.toContain('INC-7');
  });

  it('sends no entity once the person removes the chip', async () => {
    const api = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Ask AI about INC-7' }));
    const group = await screen.findByRole('group', { name: 'Sent with your question' });
    await userEvent.click(
      within(group).getByRole('button', { name: 'Do not send: Incident: INC-7' }),
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Ask the AI assistant' }),
      'hi{Enter}',
    );
    await screen.findByTestId('assistant-answer');
    const sent = api.callsTo('/v1/assistant/messages', 'POST')[0]?.body as {
      context: Record<string, unknown>;
    };
    expect(sent.context.entity).toBeUndefined();
  });

  it('is a keyboard-reachable button with a name, and absent for someone who cannot ask the AI', async () => {
    setup('client');
    await screen.findByText(/./);
    expect(screen.queryByRole('button', { name: 'Ask AI about INC-7' })).not.toBeInTheDocument();
  });

  it('shows the web prompts for the page when the api has none', async () => {
    pathname = '/shift/brief';
    window.history.replaceState(null, '', '/shift/brief');
    consoleApi({
      role: 'agent',
      overrides: { 'GET /v1/assistant/starters': { json: { ...starters, starters: [] } } },
    });
    renderApp(
      <AuthGate>
        <AssistantBubble />
      </AuthGate>,
    );
    await userEvent.click(await screen.findByTestId('assistant-bubble'));
    expect(
      await screen.findByRole('button', {
        name: 'Give me the three things that matter in this brief',
      }),
    ).toBeVisible();
  });
});

describe('local starters', () => {
  it('has two different prompts for every page kind and every entity kind, in both languages', () => {
    for (const locale of ['en', 'th'] as const) {
      const catalogue = getMessages(locale);
      const lists = [
        ...ASSISTANT_PAGES.map(pageStarters),
        ...ASSISTANT_ENTITY_KINDS.map(entityStarters),
      ];
      for (const list of lists) {
        expect(list).toHaveLength(2);
        const texts = list.map((item) => translate(catalogue, item.key));
        for (const [index, text] of texts.entries()) {
          // A missing key comes back as the key itself.
          expect(text).not.toBe(list[index]?.key);
          expect(text.length).toBeGreaterThan(5);
        }
        expect(texts[0]).not.toBe(texts[1]);
      }
    }
  });
});
