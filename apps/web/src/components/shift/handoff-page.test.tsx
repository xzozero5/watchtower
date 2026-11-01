import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';
import { shiftApi } from '@/test/shift-api';
import {
  blocker,
  currentHandoff,
  handoff,
  handoffItem,
  p3Item,
  offShiftStatus,
  WHO,
} from '@/test/shift-fixtures';

import { HandoffPage } from './handoff-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/shift/handoff',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const p1 = handoffItem(1, { nextAction: 'Wait for the log file' });
const bare = handoffItem(2);

const nextAction = (key: string) => screen.getByRole('textbox', { name: `Next action for ${key}` });

const REFUSAL = (blockers: unknown[], noConfirmedHandoff = false) => ({
  status: 409,
  json: {
    statusCode: 409,
    error: 'Conflict',
    code: 'handoff_incomplete',
    message: 'handoff_incomplete',
    noConfirmedHandoff,
    blockers,
  },
});

describe('Handoff (outgoing, spec 9.3)', () => {
  it('asks a person who is not clocked in to clock in first', async () => {
    shiftApi({
      overrides: {
        'GET /v1/shifts/status': { json: offShiftStatus() },
        'GET /v1/handoffs/current': apiError(409, 'conflict', 'Not clocked in'),
      },
    });
    renderConsole(<HandoffPage />);
    expect(await screen.findByText('Clock in to write a handoff.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Clock in' })).toHaveAttribute('href', '/shift');
  });

  it('starts the draft from the data', async () => {
    const user = userEvent.setup();
    let started = false;
    const api = shiftApi({
      overrides: {
        'GET /v1/handoffs/current': () => ({
          json: started
            ? currentHandoff({ handoff: handoff({ items: [p1] }) })
            : currentHandoff({ handoff: null }),
        }),
        'POST /v1/handoffs/prefill': () => {
          started = true;
          return { json: handoff({ items: [p1] }) };
        },
      },
    });
    renderConsole(<HandoffPage />);
    await user.click(await screen.findByRole('button', { name: 'Start the handoff' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/handoffs/prefill', 'POST')).toHaveLength(1);
    });
    expect(await screen.findByDisplayValue('Wait for the log file')).toBeVisible();
    expect(screen.getByText('filled from the data')).toBeVisible();
  });

  it('will not confirm while a P1 ticket has no next action, and links to the field', async () => {
    const user = userEvent.setup();
    const api = shiftApi({
      overrides: {
        'GET /v1/handoffs/current': {
          json: currentHandoff({ handoff: handoff({ items: [p1, bare] }) }),
        },
      },
    });
    renderConsole(<HandoffPage />);
    await screen.findByDisplayValue('Wait for the log file');
    await user.click(screen.getByRole('button', { name: 'Confirm handoff' }));

    const summary = await screen.findByRole('alert');
    expect(summary).toHaveTextContent('The handoff cannot be confirmed yet');
    expect(summary).toHaveTextContent('Problems to fix: 1');
    expect(within(summary).getByText(/needs a next action/)).toBeVisible();
    // Nothing was sent: the fix is local.
    expect(api.callsTo('/v1/handoffs/' + handoff().id, 'PUT')).toHaveLength(0);
    expect(api.callsTo('/v1/handoffs/' + handoff().id + '/confirm', 'POST')).toHaveLength(0);

    await user.click(within(summary).getByRole('link', { name: 'Fix OPS-102' }));
    expect(nextAction('OPS-102')).toHaveFocus();
    expect(nextAction('OPS-102')).toHaveAttribute('aria-invalid', 'true');
    expect(nextAction('OPS-102')).toBeRequired();
  });

  it('saves the whole list and then confirms once every P1 has a next action', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const api = shiftApi({
      overrides: {
        'GET /v1/handoffs/current': {
          json: currentHandoff({ handoff: handoff({ items: [p1, bare] }) }),
        },
        [`PUT /v1/handoffs/${handoff().id}`]: () => {
          calls.push('save');
          return { json: handoff({ items: [p1, bare] }) };
        },
        [`POST /v1/handoffs/${handoff().id}/confirm`]: () => {
          calls.push('confirm');
          return {
            json: handoff({ status: 'confirmed', confirmedAt: '2026-11-02T03:00:00.000Z' }),
          };
        },
      },
    });
    renderConsole(<HandoffPage />);
    await screen.findByDisplayValue('Wait for the log file');
    await user.type(nextAction('OPS-102'), 'Call the customer');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Incoming person' }), WHO.pim.id);
    await user.type(
      screen.getByRole('textbox', { name: 'Message for the next shift' }),
      'Watch the export',
    );
    await user.click(screen.getByRole('button', { name: 'Confirm handoff' }));

    await waitFor(() => {
      expect(calls).toEqual(['save', 'confirm']);
    });
    const body = api.callsTo(`/v1/handoffs/${handoff().id}`, 'PUT')[0]?.body as {
      toUserId: string;
      messageForNext: string;
      items: { id: string; nextAction: string | null }[];
    };
    expect(body.toUserId).toBe(WHO.pim.id);
    expect(body.messageForNext).toBe('Watch the export');
    expect(body.items.find((item) => item.id === bare.id)?.nextAction).toBe('Call the customer');
    expect(await screen.findByText('Handoff confirmed.')).toBeVisible();
  });

  it('lists the tickets the api says are missing and adds them to the draft', async () => {
    const user = userEvent.setup();
    const moved = blocker(9, { reason: 'not_listed', cause: 'moved_away' });
    const api = shiftApi({
      overrides: {
        'GET /v1/handoffs/current': { json: currentHandoff({ handoff: handoff({ items: [p1] }) }) },
        [`PUT /v1/handoffs/${handoff().id}`]: { json: handoff({ items: [p1] }) },
        [`POST /v1/handoffs/${handoff().id}/confirm`]: REFUSAL([moved]),
      },
    });
    renderConsole(<HandoffPage />);
    await screen.findByDisplayValue('Wait for the log file');
    await user.click(screen.getByRole('button', { name: 'Confirm handoff' }));

    const summary = await screen.findByRole('alert');
    expect(summary).toHaveTextContent('OPS-109');
    expect(summary).toHaveTextContent('not in the handoff');
    expect(summary).toHaveTextContent('You handed it away or unassigned it during this shift.');
    await user.click(within(summary).getByRole('button', { name: 'Add to handoff' }));

    // The ticket is a row now, with its field focused and still required.
    expect(await screen.findByRole('textbox', { name: 'Next action for OPS-109' })).toHaveFocus();
    expect(api.callsTo(`/v1/handoffs/${handoff().id}/confirm`, 'POST')).toHaveLength(1);
  });

  it('keeps the P1 and P2 rows from being removed, but not a P3', async () => {
    const p3 = p3Item(3);
    shiftApi({
      overrides: {
        'GET /v1/handoffs/current': {
          json: currentHandoff({ handoff: handoff({ items: [p1, p3] }) }),
        },
      },
    });
    renderConsole(<HandoffPage />);
    await screen.findByDisplayValue('Wait for the log file');
    expect(screen.queryByRole('button', { name: /^Remove OPS-101/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Remove OPS-103/ })).toBeVisible();
  });

  it('adds an incident by hand and sends it as a new item', async () => {
    const user = userEvent.setup();
    const api = shiftApi({
      overrides: {
        'GET /v1/handoffs/current': { json: currentHandoff({ handoff: handoff({ items: [p1] }) }) },
        [`PUT /v1/handoffs/${handoff().id}`]: { json: handoff({ items: [p1] }) },
      },
    });
    renderConsole(<HandoffPage />);
    await screen.findByDisplayValue('Wait for the log file');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Required.')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: 'What' }), 'INC-12 monitoring');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByDisplayValue('INC-12 monitoring')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(api.callsTo(`/v1/handoffs/${handoff().id}`, 'PUT')).toHaveLength(1);
    });
    const body = api.callsTo(`/v1/handoffs/${handoff().id}`, 'PUT')[0]?.body as {
      items: { id?: string; kind: string; title: string }[];
    };
    expect(body.items.at(-1)).toMatchObject({ kind: 'incident', title: 'INC-12 monitoring' });
    expect(body.items.at(-1)).not.toHaveProperty('id');
  });

  it('shows a confirmed handoff read-only with a way to reopen it', async () => {
    const user = userEvent.setup();
    const confirmed = handoff({
      status: 'confirmed',
      confirmedAt: '2026-11-02T03:00:00.000Z',
      items: [p1],
    });
    const api = shiftApi({
      overrides: {
        'GET /v1/handoffs/current': {
          json: currentHandoff({
            handoff: confirmed,
            gate: { noConfirmedHandoff: false, blockers: [] },
          }),
        },
        [`POST /v1/handoffs/${handoff().id}/reopen`]: { json: handoff({ items: [p1] }) },
      },
    });
    renderConsole(<HandoffPage />);
    expect(await screen.findByDisplayValue('Wait for the log file')).toBeDisabled();
    expect(screen.getByText('Nothing blocks clock out.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Confirm handoff' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reopen to edit' }));
    await waitFor(() => {
      expect(api.callsTo(`/v1/handoffs/${handoff().id}/reopen`, 'POST')).toHaveLength(1);
    });
  });

  it('shows the api sentence when reopening is refused because the incoming person answered', async () => {
    const user = userEvent.setup();
    const confirmed = handoff({
      status: 'confirmed',
      confirmedAt: '2026-11-02T03:00:00.000Z',
      items: [p1],
    });
    shiftApi({
      overrides: {
        'GET /v1/handoffs/current': { json: currentHandoff({ handoff: confirmed }) },
        [`POST /v1/handoffs/${handoff().id}/reopen`]: apiError(
          409,
          'handoff_locked',
          'The incoming person already answered an item',
        ),
      },
    });
    renderConsole(<HandoffPage />);
    await user.click(await screen.findByRole('button', { name: 'Reopen to edit' }));
    expect(await screen.findByText('The incoming person already answered an item')).toBeVisible();
  });
});
