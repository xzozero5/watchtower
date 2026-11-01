import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { consoleApi } from '@/test/console-api';
import { PEOPLE, USERS } from '@/test/console-fixtures';
import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { UsersPage } from './users-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/users',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const rowOf = (name: string) => screen.getByRole('row', { name });

/** Radix menus ignore the synthetic pointer click in jsdom: choose with the keyboard, as the other tests do. */
async function choose(user: ReturnType<typeof userEvent.setup>, item: HTMLElement) {
  item.focus();
  await user.keyboard('{Enter}');
}

describe('Users', () => {
  it('lists staff with role and status in words, and leaves out customers', async () => {
    consoleApi({
      overrides: {
        'GET /v1/users': {
          json: {
            users: [
              ...USERS,
              {
                ...USERS[2],
                id: 'a0000000-0000-4000-8000-000000000999',
                name: 'Casey Customer',
                role: 'client',
              },
            ],
          },
        },
      },
    });
    renderConsole(<UsersPage />);
    await screen.findByRole('table', { name: 'Users' });
    expect(within(rowOf('Pim S.')).getByText('Agent')).toBeVisible();
    expect(within(rowOf('Pim S.')).getByText('Active')).toBeVisible();
    expect(within(rowOf('Dao N.')).getByText('Disabled')).toBeVisible();
    expect(screen.queryByText('Casey Customer')).not.toBeInTheDocument();
  });

  it('locks your own row and the emergency account, with the reason as text', async () => {
    consoleApi();
    renderConsole(<UsersPage />);
    await screen.findByRole('table', { name: 'Users' });
    // The session user is "Alex Agent" (see fixtures); the fixture list has them as the head row.
    expect(
      within(rowOf('Alex Agent')).getByText('You can’t change your own role or status.'),
    ).toBeVisible();
    expect(
      within(rowOf('Break Glass')).getByText('Emergency sign-in account — not editable here'),
    ).toBeVisible();
    expect(within(rowOf('Alex Agent')).queryByRole('button')).not.toBeInTheDocument();
    expect(within(rowOf('Break Glass')).queryByRole('button')).not.toBeInTheDocument();
  });

  it('lets the head change a role from the row, and asks before making someone a head', async () => {
    const user = userEvent.setup();
    const api = consoleApi({
      overrides: { [`PATCH /v1/users/${PEOPLE.pim.id}`]: { json: { ...USERS[2], role: 'lead' } } },
    });
    renderConsole(<UsersPage />);
    await screen.findByRole('table', { name: 'Users' });
    await user.click(within(rowOf('Pim S.')).getByRole('button', { name: /Role/ }));
    await user.click(await screen.findByRole('option', { name: 'Lead' }));
    await waitFor(() => {
      expect(api.callsTo(`/v1/users/${PEOPLE.pim.id}`, 'PATCH')).toHaveLength(1);
    });
    expect(api.callsTo(`/v1/users/${PEOPLE.pim.id}`, 'PATCH')[0]?.body).toEqual({ role: 'lead' });

    await user.click(within(rowOf('Pim S.')).getByRole('button', { name: /Role/ }));
    await user.click(await screen.findByRole('option', { name: 'Head' }));
    const dialog = await screen.findByRole('dialog', { name: 'Make Pim S. a head?' });
    expect(
      within(dialog).getByText('Heads can change integrations, users and AI controls.'),
    ).toBeVisible();
    // Nothing was sent for the second change yet.
    expect(api.callsTo(`/v1/users/${PEOPLE.pim.id}`, 'PATCH')).toHaveLength(1);
  });

  it('disables an account after a confirmation that says what happens', async () => {
    const user = userEvent.setup();
    const api = consoleApi({
      overrides: {
        [`PATCH /v1/users/${PEOPLE.pim.id}`]: { json: { ...USERS[2], status: 'disabled' } },
      },
    });
    renderConsole(<UsersPage />);
    await screen.findByRole('table', { name: 'Users' });
    await user.click(within(rowOf('Pim S.')).getByRole('button', { name: 'Actions for Pim S.' }));
    await choose(user, await screen.findByRole('menuitem', { name: 'Disable…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disable Pim S.?' });
    expect(within(dialog).getByText('Their sessions end now.')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Disable…' }));
    await waitFor(() => {
      expect(api.callsTo(`/v1/users/${PEOPLE.pim.id}`, 'PATCH')).toHaveLength(1);
    });
    expect(api.callsTo(`/v1/users/${PEOPLE.pim.id}`, 'PATCH')[0]?.body).toEqual({
      status: 'disabled',
    });
  });

  it('signs a person out everywhere after a confirmation', async () => {
    const user = userEvent.setup();
    const api = consoleApi({
      overrides: {
        [`POST /v1/users/${PEOPLE.pim.id}/force-logout`]: { json: { revokedSessions: 2 } },
      },
    });
    renderConsole(<UsersPage />);
    await screen.findByRole('table', { name: 'Users' });
    await user.click(within(rowOf('Pim S.')).getByRole('button', { name: 'Actions for Pim S.' }));
    await choose(user, await screen.findByRole('menuitem', { name: 'Sign out everywhere' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign Pim S. out everywhere?' });
    await user.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => {
      expect(api.callsTo(`/v1/users/${PEOPLE.pim.id}/force-logout`, 'POST')).toHaveLength(1);
    });
  });

  it('invites a person with email, name and role, and checks the address first', async () => {
    const user = userEvent.setup();
    const api = consoleApi({
      overrides: { 'POST /v1/users': { status: 201, json: { ...USERS[2], name: 'Nok Newcomer' } } },
    });
    renderConsole(<UsersPage />);
    await screen.findByRole('table', { name: 'Users' });
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    const sheet = await screen.findByRole('dialog', { name: 'Invite' });
    expect(within(sheet).getByText('They sign in with Google using this address.')).toBeVisible();
    await user.click(within(sheet).getByRole('button', { name: 'Invite' }));
    expect(within(sheet).getByText('Enter a valid email address.')).toBeVisible();
    expect(api.callsTo('/v1/users', 'POST')).toHaveLength(0);
    await user.type(within(sheet).getByLabelText('Email'), 'nok@example.com');
    await user.type(within(sheet).getByLabelText('Name'), 'Nok Newcomer');
    await user.selectOptions(within(sheet).getByLabelText('Role'), 'lead');
    await user.click(within(sheet).getByRole('button', { name: 'Invite' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/users', 'POST')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/users', 'POST')[0]?.body).toEqual({
      email: 'nok@example.com',
      name: 'Nok Newcomer',
      role: 'lead',
    });
  });

  it('asks before throwing away a half-filled invitation', async () => {
    const user = userEvent.setup();
    consoleApi();
    renderConsole(<UsersPage />);
    await screen.findByRole('table', { name: 'Users' });
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    const sheet = await screen.findByRole('dialog', { name: 'Invite' });
    await user.type(within(sheet).getByLabelText('Name'), 'Nok');
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('dialog', { name: 'Discard your changes?' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('dialog', { name: 'Invite' })).toBeVisible();
  });

  it('shows the api’s sentence above the form when the invitation conflicts', async () => {
    const user = userEvent.setup();
    consoleApi({
      overrides: {
        'POST /v1/users': apiError(409, 'conflict', 'A user with this email already exists'),
      },
    });
    renderConsole(<UsersPage />);
    await screen.findByRole('table', { name: 'Users' });
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    const sheet = await screen.findByRole('dialog', { name: 'Invite' });
    await user.type(within(sheet).getByLabelText('Email'), 'pim@example.com');
    await user.type(within(sheet).getByLabelText('Name'), 'Pim S.');
    await user.click(within(sheet).getByRole('button', { name: 'Invite' }));
    const alert = await within(sheet).findByRole('alert');
    expect(alert).toHaveTextContent('Your changes were not saved.');
    expect(alert).toHaveTextContent('A user with this email already exists');
  });

  it('is read-only for a lead: no invite, no role field, no actions', async () => {
    consoleApi({ role: 'lead' });
    renderConsole(<UsersPage />);
    await screen.findByRole('table', { name: 'Users' });
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
    expect(within(rowOf('Pim S.')).queryByRole('button')).not.toBeInTheDocument();
    expect(within(rowOf('Pim S.')).getByText('Agent')).toBeVisible();
  });

  it('is closed to an agent', async () => {
    consoleApi({ role: 'agent' });
    renderConsole(<UsersPage />);
    expect(await screen.findByText('You don’t have access to this page.')).toBeVisible();
  });

  it('offers a retry when the list cannot be loaded, and an empty line when it is empty', async () => {
    consoleApi({ overrides: { 'GET /v1/users': apiError(500, 'unknown') } });
    const { unmount } = renderConsole(<UsersPage />);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeVisible();
    unmount();
    consoleApi({ overrides: { 'GET /v1/users': { json: { users: [] } } } });
    renderConsole(<UsersPage />);
    expect(await screen.findByText('No users yet.')).toBeVisible();
  });
});
