import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { consoleApi, PEOPLE, QUEUE } from '@/test/console-fixtures';
import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { IntegrationsPage } from '../integrations/integrations-page';
import { QueuesPage } from './queues-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/queues',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Queues', () => {
  it('lists queues with assignment, default and members', async () => {
    consoleApi();
    renderConsole(<QueuesPage />);
    const table = await screen.findByRole('table', { name: 'Queues' });
    const row = within(table).getByRole('row', { name: 'Support' });
    expect(within(row).getByText('Round robin')).toBeVisible();
    expect(within(row).getByText('Yes')).toBeVisible();
    expect(within(row).getByText('2')).toBeVisible();
    expect(within(row).getByText('Mana K., Pim S.')).toBeInTheDocument();
  });

  it('edits members with a multi-select and saves the ids', async () => {
    const user = userEvent.setup();
    const api = consoleApi({
      overrides: { [`PATCH /v1/queues/${QUEUE.id}`]: { json: QUEUE } },
    });
    renderConsole(<QueuesPage />);
    await user.click(await screen.findByRole('button', { name: 'Support' }));
    const sheet = await screen.findByRole('dialog', { name: 'Support' });
    await user.click(within(sheet).getByRole('button', { name: /Members/ }));
    // Alex Agent is active staff, not yet in the queue: add them; remove Pim.
    await user.click(await screen.findByRole('option', { name: 'Alex Agent' }));
    await user.click(await screen.findByRole('option', { name: /Pim S\./ }));
    await user.keyboard('{Escape}');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(api.callsTo(`/v1/queues/${QUEUE.id}`, 'PATCH')).toHaveLength(1);
    });
    const body = api.callsTo(`/v1/queues/${QUEUE.id}`, 'PATCH')[0]?.body as { memberIds: string[] };
    expect([...body.memberIds].sort()).toEqual([PEOPLE.head.id, PEOPLE.mana.id].sort());
  });

  it('creates a queue and requires a name', async () => {
    const user = userEvent.setup();
    const api = consoleApi({ overrides: { 'POST /v1/queues': { status: 201, json: QUEUE } } });
    renderConsole(<QueuesPage />);
    await screen.findByRole('table', { name: 'Queues' });
    await user.click(screen.getByRole('button', { name: 'New queue' }));
    const sheet = await screen.findByRole('dialog', { name: 'New queue' });
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(within(sheet).getByText('Required.')).toBeVisible();
    await user.type(within(sheet).getByLabelText('Name'), 'Billing');
    await user.click(within(sheet).getByRole('radio', { name: 'Round robin' }));
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/queues', 'POST')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/queues', 'POST')[0]?.body).toEqual({
      name: 'Billing',
      assignmentMode: 'round_robin',
      isDefault: false,
      memberIds: [],
    });
  });

  it('confirms before deleting and shows a refusal as text', async () => {
    const user = userEvent.setup();
    consoleApi({
      overrides: {
        [`DELETE /v1/queues/${QUEUE.id}`]: apiError(
          409,
          'conflict',
          'The default queue cannot be deleted',
        ),
      },
    });
    renderConsole(<QueuesPage />);
    await screen.findByRole('table', { name: 'Queues' });
    await user.click(screen.getByRole('button', { name: 'Delete Support' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Support?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(dialog).findByText('The default queue cannot be deleted')).toBeVisible();
  });

  it('is open to a lead and closed to an agent', async () => {
    consoleApi({ role: 'agent' });
    renderConsole(<QueuesPage />);
    expect(await screen.findByText('You don’t have access to this page.')).toBeVisible();
  });
});

describe('Integrations', () => {
  it('is a placeholder that points at the spec and T-116, for the head only', async () => {
    consoleApi();
    const { unmount } = renderConsole(<IntegrationsPage />);
    expect(await screen.findByText('Integrations arrive with T-116')).toBeVisible();
    expect(screen.getByText('docs/06-UI-SPEC.md §12')).toBeVisible();
    unmount();
    consoleApi({ role: 'lead' });
    renderConsole(<IntegrationsPage />);
    expect(await screen.findByText('It needs the Head role.')).toBeVisible();
  });
});
