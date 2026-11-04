import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GoldenAnswer } from '@watchtower/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { consoleApi } from '@/test/console-api';
import { uuid } from '@/test/fixtures';
import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { GoldenPage } from './golden-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/golden',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const AT = '2026-11-02T03:00:00.000Z';

const ROW: GoldenAnswer = {
  id: uuid(50),
  ticketId: uuid(40),
  ticketKey: 'OPS-7',
  messageId: uuid(41),
  intent: { key: 'password_reset', name: 'Password reset' },
  text: 'Hello [NAME_1], we reset your password.',
  language: 'en',
  shareable: false,
  createdBy: { id: uuid(900), name: 'Lena Lead' },
  createdAt: AT,
};

function open(items: GoldenAnswer[] | 'error', role: 'lead' | 'head' | 'agent' = 'lead') {
  const api = consoleApi({
    role,
    overrides: {
      'GET /v1/ai/golden':
        items === 'error' ? apiError(500, 'internal', 'boom') : { json: { items } },
      'DELETE /v1/ai/golden/:id': { json: { id: ROW.id } },
    },
  });
  renderConsole(<GoldenPage />);
  return api;
}

describe('Golden answers (admin)', () => {
  it('lists the redacted replies with their intent, ticket and who marked them', async () => {
    open([ROW]);
    const table = await screen.findByRole('table', { name: 'Golden answers' });
    const row = within(table).getByRole('row', { name: /OPS-7/ });
    expect(within(row).getByText('Password reset')).toBeVisible();
    expect(within(row).getByText('Hello [NAME_1], we reset your password.')).toBeVisible();
    expect(within(row).getByText('Lena Lead')).toBeVisible();
    expect(within(row).getByRole('link', { name: 'OPS-7' })).toBeVisible();
  });

  it('marks a shareable answer with a badge and no other', async () => {
    open([ROW, { ...ROW, id: uuid(51), ticketKey: 'OPS-8', shareable: true }]);
    const table = await screen.findByRole('table', { name: 'Golden answers' });
    expect(
      within(within(table).getByRole('row', { name: /OPS-8/ })).getByText('Shareable'),
    ).toBeVisible();
    expect(
      within(within(table).getByRole('row', { name: /OPS-7/ })).queryByText('Shareable'),
    ).toBeNull();
  });

  it('asks first, then removes the answer and says so', async () => {
    const user = userEvent.setup();
    const api = open([ROW]);
    await user.click(
      await screen.findByRole('button', { name: 'Remove the golden answer of OPS-7' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Remove this golden answer?' });
    expect(
      within(dialog).getByText(/stops using it as an example for Password reset/),
    ).toBeVisible();
    expect(api.callsTo(`/v1/ai/golden/${ROW.id}`, 'DELETE')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(api.callsTo(`/v1/ai/golden/${ROW.id}`, 'DELETE')).toHaveLength(1);
    });
    expect(await screen.findByText('Golden answer removed')).toBeVisible();
  });

  it('says there is none yet and how to make one', async () => {
    open([]);
    expect(await screen.findByText('No golden answers yet')).toBeVisible();
    expect(screen.getByText(/mark a good reply as golden/)).toBeVisible();
  });

  it('says it could not load, with a retry', async () => {
    open('error');
    expect(await screen.findByText('Could not load the golden answers.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('is closed to an agent', async () => {
    open([ROW], 'agent');
    expect(await screen.findByText(/You don.t have access to this page/)).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
