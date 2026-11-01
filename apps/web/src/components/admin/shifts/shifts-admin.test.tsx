import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderConsole } from '@/test/render-console';
import { shiftApi } from '@/test/shift-api';
import { DAY_SHIFT_ID, rosterEntry, shiftDefinition, SHIFT_TZ, WHO } from '@/test/shift-fixtures';

import { ShiftsAdminPage } from './shifts-admin-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/shifts',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Shifts and roster (admin)', () => {
  it('is for a lead or head, not an agent', async () => {
    shiftApi({ role: 'agent' });
    renderConsole(<ShiftsAdminPage />);
    expect(await screen.findByText(/You don’t have access to this page/)).toBeVisible();
  });

  it('shows the zone the times are in and lists the shifts, with the overnight one marked', async () => {
    const user = userEvent.setup();
    shiftApi({ role: 'lead' });
    renderConsole(<ShiftsAdminPage />);
    expect(
      await screen.findByText(`Times are in ${SHIFT_TZ}, the business calendar zone.`),
    ).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Shifts' }));
    const table = await screen.findByRole('table', { name: 'Shifts' });
    const night = within(table).getByRole('row', { name: 'On-call night' });
    expect(night).toHaveTextContent('22:00–08:00');
    expect(night).toHaveTextContent('ends next day');
    expect(night).toHaveTextContent('Yes');
  });

  it('creates a shift and refuses the same start and end', async () => {
    const user = userEvent.setup();
    const api = shiftApi({
      role: 'lead',
      overrides: {
        'POST /v1/shifts/definitions': {
          status: 201,
          json: shiftDefinition(0, { name: 'Weekend' }),
        },
      },
    });
    renderConsole(<ShiftsAdminPage />);
    await user.click(await screen.findByRole('tab', { name: 'Shifts' }));
    await user.click(await screen.findByRole('button', { name: 'New shift' }));
    const sheet = await screen.findByRole('dialog', { name: 'New shift' });
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(within(sheet).getByText('Required.')).toBeVisible();

    await user.type(within(sheet).getByRole('textbox', { name: 'Name' }), 'Weekend');
    await user.clear(within(sheet).getByLabelText('Ends'));
    await user.type(within(sheet).getByLabelText('Ends'), '08:00');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(within(sheet).getByText('A shift cannot start and end at the same time.')).toBeVisible();
    expect(api.callsTo('/v1/shifts/definitions', 'POST')).toHaveLength(0);

    await user.clear(within(sheet).getByLabelText('Ends'));
    await user.type(within(sheet).getByLabelText('Ends'), '16:00');
    await user.click(within(sheet).getByLabelText(/On-call shift/));
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/shifts/definitions', 'POST')[0]?.body).toEqual({
        name: 'Weekend',
        startsAt: '08:00',
        endsAt: '16:00',
        onCall: true,
      });
    });
  });

  it('puts a person on the roster and takes them off', async () => {
    const user = userEvent.setup();
    const entry = rosterEntry(1, {
      userId: WHO.pim.id,
      userName: WHO.pim.name,
      workDate: '2026-11-03',
    });
    const api = shiftApi({
      role: 'lead',
      overrides: {
        'GET /v1/roster': { json: { timezone: SHIFT_TZ, entries: [entry] } },
        'POST /v1/roster': { status: 201, json: entry },
        [`DELETE /v1/roster/${entry.id}`]: { status: 204 },
      },
    });
    renderConsole(<ShiftsAdminPage />);
    const day = await screen.findByRole('region', { name: 'Roster for 2026-11-03' });
    expect(day).toHaveTextContent('Pim S. · Day');

    const form = screen.getByRole('form', { name: 'Add to the roster' });
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    expect(within(form).getAllByText('Required.').length).toBeGreaterThanOrEqual(2);
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Person' }), WHO.mana.id);
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Shift' }), DAY_SHIFT_ID);
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/roster', 'POST')[0]?.body).toMatchObject({
        shiftId: DAY_SHIFT_ID,
        userId: WHO.mana.id,
      });
    });

    await user.click(
      within(day).getByRole('button', { name: 'Remove Pim S. from Day on 2026-11-03' }),
    );
    await waitFor(() => {
      expect(api.callsTo(`/v1/roster/${entry.id}`, 'DELETE')).toHaveLength(1);
    });
  });

  it('shows an empty state and refuses a range over 62 days', async () => {
    const user = userEvent.setup();
    shiftApi({ role: 'lead' });
    renderConsole(<ShiftsAdminPage />);
    expect(await screen.findByText('Nobody is rostered in this range.')).toBeVisible();
    const to = screen.getByLabelText('To');
    await user.clear(to);
    await user.type(to, '2027-12-31');
    expect(await screen.findByText('The range can be at most 62 days.')).toBeVisible();
  });
});
