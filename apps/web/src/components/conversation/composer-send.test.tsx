import type { LineQuota } from '@watchtower/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetPendingSends } from '@/lib/outbound/pending-sends';
import { resetPreferencesCache } from '@/lib/preferences';
import { renderWorkspace } from '@/test-utils';
import { DELIVERY_ID, makeMessage, makeScheduledReply, makeTicket, uuid } from '@/test/fixtures';
import { apiError } from '@/test/mock-api';
import type { MockResult } from '@/test/mock-api';
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
  vi.unstubAllGlobals();
});

const lineTicket = makeTicket(1, { subject: 'Cannot log in', channel: 'line' });
const portalTicket = makeTicket(2, { subject: 'Invoice' });

const quota = (level: LineQuota['accounts'][number]['level'], used: number): LineQuota => ({
  accounts: [
    {
      channelAccountId: uuid(1200),
      name: 'Support LINE',
      period: '2026-11',
      used,
      limit: 200,
      remaining: 200 - used,
      percentUsed: (used / 200) * 100,
      level,
      reconciledAt: null,
    },
  ],
});

async function openComposer(key = 'OPS-1') {
  window.history.replaceState(null, '', `/?ticket=${key}`);
  renderWorkspace();
  return screen.findByRole('textbox', { name: 'Public reply' });
}

describe('Send via and the LINE allowance', () => {
  it('names the channel the reply goes through', async () => {
    workspaceApi({ tickets: [lineTicket] });
    await openComposer();
    expect(screen.getByTestId('send-via')).toHaveTextContent('Via LINE');
  });

  it('shows how much of the LINE allowance is used, in words and a number', async () => {
    workspaceApi({
      tickets: [lineTicket],
      overrides: { 'GET /v1/line/quota': { json: quota('ok', 60) } },
    });
    await openComposer();
    const note = await screen.findByTestId('line-quota');
    expect(within(note).getByText('60 of 200 used')).toBeVisible();
    expect(note).toHaveAttribute('data-level', 'ok');
    expect(within(note).queryByRole('status')).toBeNull();
  });

  it('warns from 80 percent and says what to do', async () => {
    workspaceApi({
      tickets: [lineTicket],
      overrides: { 'GET /v1/line/quota': { json: quota('warn', 170) } },
    });
    await openComposer();
    const note = await screen.findByTestId('line-quota');
    expect(
      within(note).getByText(
        'LINE allowance is nearly used up. Prefer email if the customer has one.',
      ),
    ).toBeVisible();
  });

  it('says a push will be refused when the allowance is gone', async () => {
    workspaceApi({
      tickets: [lineTicket],
      overrides: { 'GET /v1/line/quota': { json: quota('exhausted', 200) } },
    });
    await openComposer();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'LINE allowance is used up. A push message will be refused; use email.',
    );
  });

  it('draws nothing when the allowance is unknown or the api cannot say', async () => {
    const api = workspaceApi({
      tickets: [lineTicket],
      overrides: { 'GET /v1/line/quota': apiError(500, 'internal') },
    });
    await openComposer();
    await waitFor(() => {
      expect(api.callsTo('/v1/line/quota', 'GET')).toHaveLength(1);
    });
    expect(screen.queryByTestId('line-quota')).toBeNull();
  });

  it('does not ask for the LINE allowance on another channel', async () => {
    const api = workspaceApi({ tickets: [portalTicket] });
    await openComposer('OPS-2');
    expect(screen.getByTestId('send-via')).toHaveTextContent('Via Portal');
    expect(api.callsTo('/v1/line/quota', 'GET')).toHaveLength(0);
  });
});

describe('undo send, held by the server', () => {
  // Built when the api answers: the hold is measured from that moment. A reply made at setup would
  // already be past its 5 s window if typing under load took longer, and no Undo bar would show.
  const sentReply = (ticket: typeof lineTicket) => () => ({
    status: 201,
    json: { message: makeScheduledReply(60, ticket, 5000), ticket },
  });

  it('shows "Sending in N s" with Undo after a reply and cancels through the server', async () => {
    const user = userEvent.setup();
    const api = workspaceApi({
      tickets: [lineTicket],
      overrides: {
        'POST /v1/tickets/:id/replies': sentReply(lineTicket),
        'POST /v1/tickets/:id/deliveries/:deliveryId/cancel': {
          json: {
            delivery: {
              ...makeScheduledReply(60, lineTicket).delivery,
              state: 'cancelled',
              cancellable: false,
            },
            messageId: makeScheduledReply(60, lineTicket).id,
            deliveryStatus: 'cancelled',
          },
        },
      },
    });
    const box = await openComposer();
    await user.type(box, 'We are looking into it.');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    const bar = await screen.findByTestId('pending-send');
    expect(within(bar).getByRole('status')).toHaveTextContent(/Sending in \d s/);
    // A plain reply carries neither draft id.
    expect(api.callsTo('/v1/tickets/OPS-1/replies', 'POST')[0]?.body).toEqual({
      body: 'We are looking into it.',
    });

    await user.click(within(bar).getByRole('button', { name: /^Undo/ }));
    await waitFor(() => {
      expect(
        api.callsTo(`/v1/tickets/OPS-1/deliveries/${DELIVERY_ID}/cancel`, 'POST'),
      ).toHaveLength(1);
    });
    expect(await screen.findByText('Send undone. Nothing reached the customer.')).toBeVisible();
    expect(screen.queryByTestId('pending-send')).toBeNull();
  });

  it('shows no Undo for a reply the server sent at once (portal: no delivery)', async () => {
    const user = userEvent.setup();
    workspaceApi({
      tickets: [portalTicket],
      overrides: {
        'POST /v1/tickets/:id/replies': {
          status: 201,
          json: {
            message: makeMessage(61, portalTicket, { direction: 'outbound', delivery: null }),
            ticket: portalTicket,
          },
        },
      },
    });
    const box = await openComposer('OPS-2');
    await user.type(box, 'Thanks, fixed.');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(await screen.findByText('Reply sent.')).toBeVisible();
    expect(screen.queryByTestId('pending-send')).toBeNull();
  });
});

describe('pending composer transaction', () => {
  it.each(['success', 'failure'] as const)(
    'freezes the draft and modes until %s',
    async (outcome) => {
      const user = userEvent.setup();
      let finish!: (response: MockResult) => void;
      const api = workspaceApi({
        tickets: [portalTicket],
        overrides: {
          'POST /v1/tickets/:id/replies': () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        },
      });
      const box = await openComposer('OPS-2');
      await user.type(box, 'Preserve this draft');
      await user.click(screen.getByRole('button', { name: 'Send reply' }));
      await waitFor(() => {
        expect(api.callsTo('/v1/tickets/OPS-2/replies', 'POST')).toHaveLength(1);
      });
      expect(box).toBeDisabled();
      expect(screen.getByRole('radio', { name: 'Internal note' })).toBeDisabled();
      await user.keyboard('n');
      expect(screen.queryByRole('textbox', { name: 'Internal note' })).toBeNull();
      finish(
        outcome === 'failure'
          ? apiError(500, 'internal')
          : {
              status: 201,
              json: {
                message: makeMessage(61, portalTicket, { direction: 'outbound', delivery: null }),
                ticket: portalTicket,
              },
            },
      );
      await waitFor(() => expect(box).toBeEnabled());
      expect(box).toHaveValue(outcome === 'failure' ? 'Preserve this draft' : '');
      expect(screen.getByRole('radio', { name: 'Internal note' })).toBeEnabled();
    },
  );
});

describe('a reply in the timeline', () => {
  it('says an undone reply was not sent, and offers Undo while the server still allows it', async () => {
    const user = userEvent.setup();
    const held = makeScheduledReply(70, lineTicket, 30_000);
    const undone = makeMessage(71, lineTicket, {
      direction: 'outbound',
      bodyText: 'Never mind',
      deliveryStatus: 'cancelled',
    });
    const api = workspaceApi({
      tickets: [lineTicket],
      timelines: { 'OPS-1': [held, undone] },
      overrides: {
        'POST /v1/tickets/:id/deliveries/:deliveryId/cancel': apiError(409, 'conflict'),
      },
    });
    await openComposer();
    expect(await screen.findByText('Undone, not sent')).toBeVisible();
    expect(screen.getByText('Waiting to send')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(api.callsTo(`/v1/tickets/OPS-1/deliveries/${DELIVERY_ID}/cancel`)).toHaveLength(1);
    });
    expect(await screen.findByText('Too late: the reply is already being sent.')).toBeVisible();
  });
});
