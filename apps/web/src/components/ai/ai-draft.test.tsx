import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetPendingSends } from '@/lib/outbound/pending-sends';
import { resetPreferencesCache } from '@/lib/preferences';
import { renderWorkspace } from '@/test-utils';
import { DRAFT_ID, makeInsight, makeUncitedInsight } from '@/test/ai-fixtures';
import { DELIVERY_ID, makeScheduledReply, makeTicket } from '@/test/fixtures';
import { apiError, type MockHandler } from '@/test/mock-api';
import { workspaceApi } from '@/test/scenarios';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

beforeEach(() => {
  resetPendingSends();
  localStorage.clear();
  resetPreferencesCache();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ticket1 = makeTicket(1, { subject: 'Cannot log in' });
// Built per call: the hold is measured from now, so a result made at import time would be stale.
const replyResult: MockHandler = () => ({
  status: 201,
  // As on Gmail or LINE: the server holds the reply for its undo window.
  json: { message: makeScheduledReply(50, ticket1, 5000), ticket: ticket1 },
});
const cancelResult = {
  json: {
    delivery: {
      ...makeScheduledReply(50, ticket1).delivery,
      state: 'cancelled',
      cancellable: false,
    },
    messageId: makeScheduledReply(50, ticket1).id,
    deliveryStatus: 'cancelled',
  },
};
const CANCEL_ROUTE = 'POST /v1/tickets/:id/deliveries/:deliveryId/cancel';

/**
 * A ticket with a draft. Like the real api will, the brief stops carrying the draft once a reply
 * was sent or the draft was rejected.
 */
async function openDraft(insight = makeInsight(), overrides: Record<string, MockHandler> = {}) {
  // True while the draft is not waiting for a person: after a reply or a reject, until an Undo.
  let decided = false;
  const settle = (handler: MockHandler, value: boolean): MockHandler => {
    return async (request) => {
      const result = typeof handler === 'function' ? await handler(request) : handler;
      if ((result.status ?? 200) < 400) decided = value;
      return result;
    };
  };
  const routes: Record<string, MockHandler> = {
    'POST /v1/tickets/:id/replies': replyResult,
    [CANCEL_ROUTE]: cancelResult,
    ...overrides,
  };
  const wrapped = Object.fromEntries(
    Object.entries(routes).map(([route, handler]) => [
      route,
      settle(handler, route !== CANCEL_ROUTE),
    ]),
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

  it('posts the reply at once, bound to the draft; the server holds it for the undo window', async () => {
    const user = userEvent.setup();
    const { api, draft } = await openDraft();
    await user.click(within(draft).getByRole('button', { name: /^Approve/ }));
    await user.click(await screen.findByRole('button', { name: 'Approve and send' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/replies', 'POST')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/tickets/OPS-1/replies', 'POST')[0]?.body).toEqual({
      body: expect.stringContaining('Hello Riley, your account was locked') as unknown,
      aiDraftId: DRAFT_ID,
    });
    expect(await screen.findByTestId('pending-send')).toHaveTextContent(/Sending in [1-5] s/);
    // The draft is dealt with: it leaves the page. Undo is on the bar, not on the card.
    await waitFor(() => {
      expect(screen.queryByTestId('ai-draft')).toBeNull();
    });
  });

  it('Undo calls the server cancel endpoint and the draft comes back', async () => {
    const user = userEvent.setup();
    const { api } = await openDraft();
    await user.keyboard('a');
    await user.click(await screen.findByRole('button', { name: 'Approve and send' }));
    const bar = await screen.findByTestId('pending-send');
    await user.click(within(bar).getByRole('button', { name: /^Undo/ }));

    await waitFor(() => {
      expect(
        api.callsTo(`/v1/tickets/OPS-1/deliveries/${DELIVERY_ID}/cancel`, 'POST'),
      ).toHaveLength(1);
    });
    expect(await screen.findByTestId('ai-draft')).toBeVisible();
    expect(screen.queryByTestId('pending-send')).toBeNull();
  });

  it('U undoes the pending send', async () => {
    const user = userEvent.setup();
    const { api } = await openDraft();
    await user.keyboard('a');
    await user.click(await screen.findByRole('button', { name: 'Approve and send' }));
    await screen.findByTestId('pending-send');
    await user.keyboard('u');
    await waitFor(() => {
      expect(
        api.callsTo(`/v1/tickets/OPS-1/deliveries/${DELIVERY_ID}/cancel`, 'POST'),
      ).toHaveLength(1);
    });
  });

  it('says it is too late when the window already ended (409)', async () => {
    const user = userEvent.setup();
    await openDraft(makeInsight(), { [CANCEL_ROUTE]: apiError(409, 'conflict') });
    await user.keyboard('a');
    await user.click(await screen.findByRole('button', { name: 'Approve and send' }));
    const bar = await screen.findByTestId('pending-send');
    await user.click(within(bar).getByRole('button', { name: /^Undo/ }));
    expect(await screen.findByText('Too late: the reply is already being sent.')).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByTestId('pending-send')).toBeNull();
    });
  });

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
      await screen.findByText('The reply was not sent. The draft is still here.'),
    ).toBeVisible();
    expect(screen.getByTestId('ai-draft')).toBeVisible();
    expect(screen.queryByTestId('pending-send')).toBeNull();
  });
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
      expect(api.callsTo(`/v1/tickets/OPS-1/ai/drafts/${DRAFT_ID}/reject`, 'POST')).toHaveLength(1);
    });
    expect(api.callsTo(`/v1/tickets/OPS-1/ai/drafts/${DRAFT_ID}/reject`, 'POST')[0]?.body).toEqual({
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
      expect(
        api.callsTo(`/v1/tickets/OPS-1/ai/drafts/${DRAFT_ID}/reject`, 'POST')[0]?.body,
      ).toEqual({
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

describe('edit on an email ticket (T-171)', () => {
  it('opens the draft in the rich editor of the email composer instead of a text box', async () => {
    const user = userEvent.setup();
    const gmail = makeTicket(1, { subject: 'Cannot log in', channel: 'gmail' });
    workspaceApi({ tickets: [gmail], ai: { 'OPS-1': makeInsight() } });
    window.history.replaceState(null, '', '/?ticket=OPS-1');
    renderWorkspace();
    const draft = await screen.findByTestId('ai-draft');
    await user.click(within(draft).getByRole('button', { name: /^Edit/ }));

    const editor = await screen.findByRole('textbox', { name: 'Public reply' });
    await waitFor(() => {
      expect(editor).toHaveTextContent('Hello Riley, your account was locked');
    });
    expect(screen.getByTestId('email-composer')).toBeVisible();
    // No plain text box inside the card: the words moved to the editor.
    expect(within(draft).queryByRole('textbox')).toBeNull();
    expect(screen.getByTestId('ai-draft-note')).toBeVisible();
  });
});
