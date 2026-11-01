import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';
import { shiftApi } from '@/test/shift-api';
import {
  blocker,
  nth,
  offShiftStatus,
  rosterEntry,
  shiftSession,
  shiftStatus,
} from '@/test/shift-fixtures';

import { ShiftPage } from './shift-page';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/shift',
}));

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

/** The 409 `handoff_incomplete` answer: the usual error body plus `noConfirmedHandoff` and `blockers`. */
const REFUSAL = (blockers = [blocker(1, { cause: 'moved_away' }), blocker(2)]) => ({
  status: 409,
  json: {
    statusCode: 409,
    error: 'Conflict',
    code: 'handoff_incomplete',
    message: 'handoff_incomplete',
    noConfirmedHandoff: false,
    blockers,
  },
});

describe('My shift: clock in', () => {
  it('shows the roster, keeps location consent off, and goes to the brief after clock in', async () => {
    const user = userEvent.setup();
    const api = shiftApi({
      overrides: {
        'GET /v1/shifts/status': { json: offShiftStatus({ roster: [rosterEntry(0)] }) },
        'POST /v1/shifts/clock-in': { json: shiftSession() },
      },
    });
    renderConsole(<ShiftPage />);
    expect(await screen.findByText('You are off shift')).toBeVisible();
    expect(screen.getByText(/Rostered: Day 08:00–17:00/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Clock in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Clock in' });
    expect(within(dialog).getByText(/Rostered: Day/)).toBeVisible();
    expect(within(dialog).getByRole('checkbox', { name: /Share my location/ })).not.toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Clock in' }));

    await waitFor(() => {
      expect(api.callsTo('/v1/shifts/clock-in', 'POST')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/shifts/clock-in', 'POST')[0]?.body).toMatchObject({
      locationConsent: false,
    });
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/shift/brief');
    });
  });

  it('sends the consent only when the person ticks it', async () => {
    const user = userEvent.setup();
    const api = shiftApi({
      overrides: {
        'GET /v1/shifts/status': { json: offShiftStatus() },
        'POST /v1/shifts/clock-in': { json: shiftSession() },
      },
    });
    renderConsole(<ShiftPage />);
    await user.click(await screen.findByRole('button', { name: 'Clock in' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: /Share my location/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Clock in' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/shifts/clock-in', 'POST')[0]?.body).toMatchObject({
        locationConsent: true,
      });
    });
  });

  it('offers "clock in anyway" when the person is not on the roster today', async () => {
    const user = userEvent.setup();
    shiftApi({ overrides: { 'GET /v1/shifts/status': { json: offShiftStatus({ roster: [] }) } } });
    renderConsole(<ShiftPage />);
    await user.click(await screen.findByRole('button', { name: 'Clock in' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Not on the roster today/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Clock in anyway' })).toBeVisible();
  });

  it('says so when the status cannot be loaded, and retries', async () => {
    const user = userEvent.setup();
    let calls = 0;
    shiftApi({
      overrides: {
        'GET /v1/shifts/status': () => {
          calls += 1;
          return calls === 1 ? apiError(500, 'unknown') : { json: offShiftStatus() };
        },
      },
    });
    renderConsole(<ShiftPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the shift information.');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('You are off shift')).toBeVisible();
  });
});

describe('My shift: clock out and the AC-7 gate', () => {
  const blocked = {
    noConfirmedHandoff: false,
    blockers: [blocker(1, { cause: 'moved_away' }), blocker(2, { reason: 'not_listed' })],
  };

  it('disables clock out, says why, lists each ticket, and sends nothing when pressed', async () => {
    const user = userEvent.setup();
    const api = shiftApi({
      overrides: { 'GET /v1/shifts/status': { json: shiftStatus({ clockOutBlocked: blocked }) } },
    });
    renderConsole(<ShiftPage />);
    const button = await screen.findByRole('button', { name: 'Clock out' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription(
      /Finish the handoff first: 2 items need a next action/,
    );
    const list = screen.getByRole('list', { name: 'What is missing' });
    const first = nth(within(list).getAllByRole('listitem'), 0);
    expect(first).toHaveTextContent('OPS-101');
    expect(first).toHaveTextContent('needs a next action');
    // The cause shows why a ticket the person gave away still counts.
    expect(first).toHaveTextContent('You handed it away or unassigned it during this shift.');
    expect(within(list).getAllByRole('listitem')[1]).toHaveTextContent('not in the handoff');
    expect(screen.getByRole('link', { name: 'Go to the handoff' })).toHaveAttribute(
      'href',
      '/shift/handoff',
    );
    // A priority is icon + code + word, not colour.
    expect(first).toHaveTextContent('P1');
    expect(first).toHaveTextContent('Critical');

    await user.click(button);
    expect(api.callsTo('/v1/shifts/clock-out', 'POST')).toHaveLength(0);
  });

  it('asks for a confirmed handoff when none exists yet', async () => {
    shiftApi({
      overrides: {
        'GET /v1/shifts/status': {
          json: shiftStatus({ clockOutBlocked: { noConfirmedHandoff: true, blockers: [] } }),
        },
      },
    });
    renderConsole(<ShiftPage />);
    expect(await screen.findByText('Confirm the handoff first')).toBeVisible();
  });

  it('clocks out when the gate is open', async () => {
    const user = userEvent.setup();
    const api = shiftApi({
      overrides: {
        'POST /v1/shifts/clock-out': {
          json: {
            session: shiftSession({ clockedOutAt: '2026-11-02T03:01:00.000Z' }),
            overridden: false,
          },
        },
      },
    });
    renderConsole(<ShiftPage />);
    const button = await screen.findByRole('button', { name: 'Clock out' });
    expect(button).not.toHaveAttribute('aria-disabled');
    await user.click(button);
    await waitFor(() => {
      expect(api.callsTo('/v1/shifts/clock-out', 'POST')[0]?.body).toEqual({});
    });
    expect(await screen.findByText('Clocked out.')).toBeVisible();
  });

  it('shows the blockers of a 409 the status did not predict (stale status)', async () => {
    const user = userEvent.setup();
    shiftApi({ overrides: { 'POST /v1/shifts/clock-out': REFUSAL() } });
    renderConsole(<ShiftPage />);
    await user.click(await screen.findByRole('button', { name: 'Clock out' }));
    const list = await screen.findByRole('list', { name: 'What is missing' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Finish the handoff first: 2 items need a next action')).toBeVisible();
  });

  it('lets a lead clock out anyway, with a reason of at least ten characters', async () => {
    const user = userEvent.setup();
    const api = shiftApi({
      role: 'lead',
      overrides: {
        'GET /v1/shifts/status': { json: shiftStatus({ clockOutBlocked: blocked }) },
        'POST /v1/shifts/clock-out': {
          json: {
            session: shiftSession({ clockedOutAt: '2026-11-02T03:01:00.000Z' }),
            overridden: true,
          },
        },
      },
    });
    renderConsole(<ShiftPage />);
    await user.click(await screen.findByRole('button', { name: 'Clock out anyway…' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Clock out without a complete handoff',
    });
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'too short');
    await user.click(within(dialog).getByRole('button', { name: 'Clock out' }));
    expect(within(dialog).getByText('Write at least 10 characters.')).toBeVisible();
    expect(api.callsTo('/v1/shifts/clock-out', 'POST')).toHaveLength(0);

    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), ' enough now');
    await user.click(within(dialog).getByRole('button', { name: 'Clock out' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/shifts/clock-out', 'POST')[0]?.body).toEqual({
        override: { reason: 'too short enough now' },
      });
    });
    expect(await screen.findByText(/Clocked out with an override/)).toBeVisible();
  });

  it('does not show the override to an agent', async () => {
    shiftApi({
      overrides: { 'GET /v1/shifts/status': { json: shiftStatus({ clockOutBlocked: blocked }) } },
    });
    renderConsole(<ShiftPage />);
    await screen.findByRole('button', { name: 'Clock out' });
    expect(screen.queryByRole('button', { name: 'Clock out anyway…' })).not.toBeInTheDocument();
  });

  it('shows a client no shift screen at all', async () => {
    shiftApi({ role: 'client' });
    renderConsole(<ShiftPage />);
    expect(await screen.findByText(/You don’t have access to this page/)).toBeVisible();
  });
});
