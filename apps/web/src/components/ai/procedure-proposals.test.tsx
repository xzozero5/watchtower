import type { ProcedureProposal } from '@watchtower/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetPreferencesCache } from '@/lib/preferences';
import { renderWorkspace } from '@/test-utils';
import { makeInsight, makeReport } from '@/test/ai-fixtures';
import { makeTicket, uuid } from '@/test/fixtures';
import { apiError } from '@/test/mock-api';
import { workspaceApi } from '@/test/scenarios';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

beforeEach(() => {
  localStorage.clear();
  resetPreferencesCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ticket1 = makeTicket(1, { subject: 'Re: Re: login' });
const AT = '2026-11-04T03:00:00.000Z';
const VERSION = uuid(900);

const card = (n: number, over: Partial<ProcedureProposal> = {}): ProcedureProposal => ({
  id: uuid(800 + n),
  stepId: `step_${String(n)}`,
  versionId: VERSION,
  to: { queueKey: 'Billing' },
  note: 'Money is involved.',
  status: 'pending',
  createdAt: AT,
  ...over,
});

const insightWithEscalation = () =>
  makeInsight({
    report: makeReport({
      procedure: {
        versionId: VERSION,
        autosend: 'never',
        checks: [],
        escalations: [
          { stepId: 'step_1', to: { queueKey: 'Billing' }, note: 'Money is involved.' },
        ],
        requireHuman: [],
      },
    }),
  });

async function open(items: ProcedureProposal[], extra: Record<string, never> | object = {}) {
  window.history.replaceState(null, '', '/?ticket=OPS-1');
  const api = workspaceApi({
    tickets: [ticket1],
    ai: { 'OPS-1': insightWithEscalation() },
    overrides: {
      'GET /v1/tickets/:id/procedure-proposals': { json: { items } },
      ...extra,
    },
  });
  renderWorkspace({ locale: 'en' });
  const conversation = await screen.findByRole('region', { name: 'Conversation' });
  return { api, conversation };
}

describe('escalation cards in the AI brief (T-303f)', () => {
  it('shows a queue card with what will happen, never focuses the button, and applies with one press', async () => {
    const user = userEvent.setup();
    const { api, conversation } = await open([card(1, { priority: 'P2' })], {
      'POST /v1/tickets/:id/procedure-proposals/:proposalId/apply': {
        json: {
          proposalId: uuid(801),
          alreadyApplied: false,
          action: 'moved_queue',
          notified: 0,
          priority: 'P2',
        },
      },
    });
    const proposal = await within(conversation).findByTestId('procedure-proposal');
    expect(within(proposal).getByText('Move to queue Billing')).toBeVisible();
    expect(within(proposal).getByText(/The assignee stays/)).toBeVisible();
    expect(within(proposal).getByText('Priority becomes P2')).toBeVisible();
    expect(within(proposal).getByText('Money is involved.')).toBeVisible();
    const button = within(proposal).getByRole('button', { name: 'Apply' });
    expect(button).not.toHaveFocus();
    expect(
      api.callsTo('/v1/tickets/OPS-1/procedure-proposals/' + uuid(801) + '/apply', 'POST'),
    ).toHaveLength(0);
    await user.click(button);
    expect(await within(proposal).findByText('Done: the ticket was moved.')).toBeVisible();
    expect(
      api.callsTo('/v1/tickets/OPS-1/procedure-proposals/' + uuid(801) + '/apply', 'POST'),
    ).toHaveLength(1);
    expect(within(proposal).queryByRole('button', { name: 'Apply' })).toBeNull();
  });

  it('a role card says nobody is assigned, and reports how many were told', async () => {
    const user = userEvent.setup();
    const { conversation } = await open([card(2, { to: { role: 'lead' }, note: '' })], {
      'POST /v1/tickets/:id/procedure-proposals/:proposalId/apply': {
        json: { proposalId: uuid(802), alreadyApplied: false, action: 'asked_role', notified: 2 },
      },
    });
    const proposal = await within(conversation).findByTestId('procedure-proposal');
    expect(within(proposal).getByText('Ask a lead to look')).toBeVisible();
    expect(within(proposal).getByText(/Nobody is assigned/)).toBeVisible();
    await user.click(within(proposal).getByRole('button', { name: 'Apply' }));
    expect(
      await within(proposal).findByText('Done: 2 people were told and a note was left.'),
    ).toBeVisible();
  });

  it('shows an applied card as done and an expired one with the reason, both without a button', async () => {
    const { conversation } = await open([
      card(1, { status: 'applied', appliedAt: AT }),
      card(2, { status: 'expired', expiredReason: 'version_changed' }),
      card(3, { status: 'expired', expiredReason: 'ticket_closed' }),
    ]);
    const cards = await within(conversation).findAllByTestId('procedure-proposal');
    expect(cards).toHaveLength(3);
    expect(within(cards[0] as HTMLElement).getByText('Done')).toBeVisible();
    expect(
      within(cards[1] as HTMLElement).getByText(
        'Expired: the procedure was changed after this was suggested.',
      ),
    ).toBeVisible();
    expect(
      within(cards[2] as HTMLElement).getByText('Expired: the ticket is closed.'),
    ).toBeVisible();
    expect(within(conversation).queryByRole('button', { name: 'Apply' })).toBeNull();
  });

  it('says so when the card expired between loading and pressing (409), and when it is refused (403)', async () => {
    const user = userEvent.setup();
    let status = 409;
    const { conversation } = await open([card(1)], {
      'POST /v1/tickets/:id/procedure-proposals/:proposalId/apply': () =>
        status === 409 ? apiError(409, 'conflict', 'x') : apiError(403, 'forbidden', 'x'),
    });
    const proposal = await within(conversation).findByTestId('procedure-proposal');
    await user.click(within(proposal).getByRole('button', { name: 'Apply' }));
    expect(
      await within(proposal).findByText('Expired. Reload to see the ticket as it is now.'),
    ).toBeVisible();
    status = 403;
    await user.click(within(proposal).getByRole('button', { name: 'Apply' }));
    expect(await within(proposal).findByText('You may not change this ticket.')).toBeVisible();
  });

  it('asks nothing when the report has no escalation', async () => {
    window.history.replaceState(null, '', '/?ticket=OPS-1');
    const api = workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': makeInsight() } });
    renderWorkspace({ locale: 'en' });
    await screen.findByRole('region', { name: 'Conversation' });
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/ai', 'GET').length).toBeGreaterThan(0);
    });
    expect(api.callsTo('/v1/tickets/OPS-1/procedure-proposals', 'GET')).toHaveLength(0);
  });
});
