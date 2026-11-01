import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UNDO_WINDOW_MS } from '@/lib/ai/send-with-undo';
import { resetPreferencesCache } from '@/lib/preferences';
import { renderWorkspace } from '@/test-utils';
import { makeInsight, makeUncitedInsight } from '@/test/ai-fixtures';
import { makeMessage, makeTicket, uuid } from '@/test/fixtures';
import { apiError, type MockHandler } from '@/test/mock-api';
import { workspaceApi } from '@/test/scenarios';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

beforeEach(() => {
  localStorage.clear();
  resetPreferencesCache();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ticket1 = makeTicket(1, { subject: 'Cannot log in' });
const replyResult = {
  status: 201,
  json: {
    message: makeMessage(50, ticket1, {
      direction: 'outbound',
      sender: { type: 'user', id: uuid(900), name: 'Alex Agent' },
    }),
    ticket: ticket1,
  },
};

/**
 * A ticket with a draft. Like the real api will, the brief stops carrying the draft once a reply
 * was sent or the draft was rejected.
 */
async function openDraft(insight = makeInsight(), overrides: Record<string, MockHandler> = {}) {
  let decided = false;
  const decide = (handler: MockHandler): MockHandler => {
    return (request) => {
      decided = true;
      return typeof handler === 'function' ? handler(request) : handler;
    };
  };
  const wrapped = Object.fromEntries(
    Object.entries({ 'POST /v1/tickets/:id/replies': replyResult, ...overrides }).map(
      ([route, handler]) => [route, decide(handler)],
    ),
  );
  const api = workspaceApi({
    tickets: [ticket1],
    ai: { 'OPS-1': insight },
    overrides: {
      ...wrapped,
      'GET /v1/tickets/:id/ai': () => {
        const without = { ...insight, state: 'classified' as const };
        delete without.draft;
        return { json: decided ? without : insight };
      },
    },
  });
  window.history.replaceState(null, '', '/?ticket=OPS-1');
  renderWorkspace();
  const draft = await screen.findByTestId('ai-draft');
  return { api, draft };
}

describe('approve (A)', () => {
  it('A opens a preview of the exact text and who gets it; nothing is sent yet', async () => {
    const user = userEvent.setup();
    const { api } = await openDraft();
    await user.keyboard('a');
    const dialog = await screen.findByRole('dialog', { name: 'Send this reply?' });
    expect(within(dialog).getByText('To Riley Requester via Portal')).toBeVisible();
    expect(within(dialog).getByRole('blockquote', { name: 'Reply preview' })).toHaveTextContent(
      'Hello Riley, your account was locked',
    );
    // The confirm button has the focus: A then Enter is the fast path.
    expect(within(dialog).getByRole('button', { name: 'Approve and send' })).toHaveFocus();
    expect(api.callsTo('/v1/tickets/OPS-1/replies', 'POST')).toHaveLength(0);
  });

  it('sends through the reply path only after the undo window, with the draft text', async () => {
    const user = userEvent.setup();
    const { api, draft } = await openDraft();
    await user.click(within(draft).getByRole('button', { name: /^Approve/ }));
    await user.click(await screen.findByRole('button', { name: 'Approve and send' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(draft).getByRole('status')).toHaveTextContent(/Sending in \d s/);
    expect(api.callsTo('/v1/tickets/OPS-1/replies', 'POST')).toHaveLength(0);

    await waitFor(
      () => {
        expect(api.callsTo('/v1/tickets/OPS-1/replies', 'POST')).toHaveLength(1);
      },
      { timeout: UNDO_WINDOW_MS + 3000 },
    );
    expect(api.callsTo('/v1/tickets/OPS-1/replies', 'POST')[0]?.body).toEqual({
      body: expect.stringContaining('Hello Riley, your account was locked') as unknown,
    });
    // The draft is dealt with: it leaves the page.
    await waitFor(() => {
      expect(screen.queryByTestId('ai-draft')).toBeNull();
    });
  }, 15_000);

  it('Undo takes the reply back: nothing is ever sent', async () => {
    const user = userEvent.setup();
    const { api, draft } = await openDraft();
    await user.click(within(draft).getByRole('button', { name: /^Approve/ }));
    await user.click(await screen.findByRole('button', { name: 'Approve and send' }));
    await user.click(within(draft).getByRole('button', { name: /^Undo/ }));
    // The draft is back, ready for another decision.
    expect(within(draft).getByRole('button', { name: /^Approve/ })).toBeEnabled();
    await new Promise((resolve) => setTimeout(resolve, UNDO_WINDOW_MS + 500));
    expect(api.callsTo('/v1/tickets/OPS-1/replies', 'POST')).toHaveLength(0);
  }, 15_000);

  it('Escape in the preview backs out without sending', async () => {
    const user = userEvent.setup();
    const { api } = await openDraft();
    await user.keyboard('a');
    await screen.findByRole('dialog', { name: 'Send this reply?' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.callsTo('/v1/tickets/OPS-1/replies', 'POST')).toHaveLength(0);
  });

  it('asks again about uncited claims in the preview', async () => {
    const user = userEvent.setup();
    await openDraft(makeUncitedInsight());
    await user.keyboard('a');
    const dialog = await screen.findByRole('dialog', { name: 'Send this reply?' });
    expect(within(dialog).getByText('1 uncited. Approve anyway?')).toBeVisible();
  });

  it('keeps the draft and says so when the send fails', async () => {
    const user = userEvent.setup();
    const { draft } = await openDraft(makeInsight(), {
      'POST /v1/tickets/:id/replies': apiError(500, 'internal'),
    });
    await user.click(within(draft).getByRole('button', { name: /^Approve/ }));
    await user.click(await screen.findByRole('button', { name: 'Approve and send' }));
    expect(
      await screen.findByText('The reply was not sent. The draft is still here.', undefined, {
        timeout: UNDO_WINDOW_MS + 3000,
      }),
    ).toBeVisible();
    expect(screen.getByTestId('ai-draft')).toBeVisible();
  }, 15_000);
});

describe('edit (E)', () => {
  it('E edits in place, shows how much changed and approves the edited text', async () => {
    const user = userEvent.setup();
    const { draft } = await openDraft();
    await user.keyboard('e');
    const box = within(draft).getByRole('textbox', { name: 'Draft text' });
    expect(box).toHaveFocus();
    await user.clear(box);
    await user.type(box, 'Hi Riley, wait 15 minutes and reset again.');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(within(draft).queryByRole('textbox')).toBeNull();
    expect(within(draft).getByText(/^Edited · \d+% changed$/)).toBeVisible();
    expect(within(draft).getByText('Hi Riley, wait 15 minutes and reset again.')).toBeVisible();

    await user.keyboard('a');
    const dialog = await screen.findByRole('dialog', { name: 'Send this reply?' });
    expect(within(dialog).getByRole('blockquote')).toHaveTextContent(
      'Hi Riley, wait 15 minutes and reset again.',
    );
    expect(within(dialog).getByText(/^You edited this draft · \d+% changed$/)).toBeVisible();
  });

  it('Revert puts the AI text back', async () => {
    const user = userEvent.setup();
    const { draft } = await openDraft();
    await user.click(within(draft).getByRole('button', { name: /^Edit/ }));
    await user.type(within(draft).getByRole('textbox', { name: 'Draft text' }), ' extra');
    await user.click(within(draft).getByRole('button', { name: 'Revert' }));
    expect(within(draft).queryByText(/Edited/)).toBeNull();
    expect(draft).toHaveTextContent('Hello Riley, your account was locked');
    expect(draft).not.toHaveTextContent('extra');
  });

  it('A, E and R do not fire while typing in the edit box or the search box', async () => {
    const user = userEvent.setup();
    const { draft } = await openDraft();
    await user.type(screen.getByRole('searchbox', { name: 'Search tickets' }), 'are');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(draft).queryByRole('textbox')).toBeNull();

    await user.click(within(draft).getByRole('button', { name: /^Edit/ }));
    const box = within(draft).getByRole('textbox', { name: 'Draft text' });
    await user.type(box, 'a r');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((box as HTMLTextAreaElement).value).toMatch(/a r$/);
  });
});

describe('reject (R)', () => {
  it('R opens the reason picker; the digits choose a reason and Reject posts it', async () => {
    const user = userEvent.setup();
    const { api, draft } = await openDraft(makeInsight(), {
      'POST /v1/tickets/:id/ai/drafts/:draftId/reject': { status: 204 },
    });
    await user.keyboard('r');
    const dialog = await screen.findByRole('dialog', { name: 'Reject this draft' });
    expect(within(dialog).getAllByRole('radio')).toHaveLength(9);
    const submit = within(dialog).getByRole('button', { name: 'Reject' });
    expect(submit).toBeDisabled();

    await user.keyboard('6');
    expect(within(dialog).getByRole('radio', { name: /^Tone or style/ })).toBeChecked();
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/ai/drafts/draft-1/reject', 'POST')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/tickets/OPS-1/ai/drafts/draft-1/reject', 'POST')[0]?.body).toEqual({
      reason: 'tone_style',
    });
    await waitFor(() => {
      expect(screen.queryByTestId('ai-draft')).toBeNull();
    });
    expect(draft).not.toBeInTheDocument();
  });

  it('needs a comment for "Other"', async () => {
    const user = userEvent.setup();
    const { api } = await openDraft(makeInsight(), {
      'POST /v1/tickets/:id/ai/drafts/:draftId/reject': { status: 204 },
    });
    await user.keyboard('r');
    const dialog = await screen.findByRole('dialog', { name: 'Reject this draft' });
    await user.keyboard('9');
    const submit = within(dialog).getByRole('button', { name: 'Reject' });
    expect(submit).toBeDisabled();
    expect(within(dialog).getByText('Say what was wrong')).toBeVisible();
    await user.type(within(dialog).getByRole('textbox', { name: 'Comment' }), 'Wrong product');
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/ai/drafts/draft-1/reject', 'POST')[0]?.body).toEqual({
        reason: 'other',
        comment: 'Wrong product',
      });
    });
  });

  it('keeps the dialog open with the reason when recording fails', async () => {
    const user = userEvent.setup();
    await openDraft(makeInsight(), {
      'POST /v1/tickets/:id/ai/drafts/:draftId/reject': apiError(404, 'not_found'),
    });
    await user.keyboard('r');
    const dialog = await screen.findByRole('dialog', { name: 'Reject this draft' });
    await user.keyboard('1');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(
      await within(dialog).findByText('The rejection was not recorded. Try again.'),
    ).toBeVisible();
    expect(within(dialog).getByRole('radio', { name: /^Wrong intent/ })).toBeChecked();
    expect(screen.getByTestId('ai-draft')).toBeVisible();
  });
});
