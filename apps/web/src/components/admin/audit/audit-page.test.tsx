import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { consoleApi } from '@/test/console-api';
import { auditEntry } from '@/test/console-fixtures';
import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { actionLabel, AuditPage } from './audit-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/audit',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('actionLabel', () => {
  it('reads a code as words and keeps single-word codes', () => {
    expect(actionLabel('ticket.status_change')).toBe('Ticket · status change');
    expect(actionLabel('autonomy.switch_set')).toBe('Autonomy · switch set');
    expect(actionLabel('login')).toBe('Login');
  });
});

describe('Audit log', () => {
  it('lists who did what to which target, with the outcome as an icon and a word', async () => {
    consoleApi();
    renderConsole(<AuditPage />);
    const table = await screen.findByRole('table', { name: 'Audit log' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText('Mana K.')).toBeVisible();
    expect(within(rows[0] as HTMLElement).getByText('autonomy.stage_set')).toBeVisible();
    expect(within(rows[0] as HTMLElement).getByText('Autonomy · stage set')).toBeVisible();
    expect(within(rows[0] as HTMLElement).getByText('Success')).toBeVisible();
    expect(within(rows[1] as HTMLElement).getByText('Denied')).toBeVisible();
    // No address, no before/after, no email in the list itself.
    expect(within(table).queryByText('203.0.113.7')).not.toBeInTheDocument();
    expect(screen.getByText('Opening this log is itself recorded.')).toBeVisible();
  });

  it('names system, AI and anonymous actors', async () => {
    consoleApi({
      overrides: {
        'GET /v1/audit-logs': {
          json: {
            entries: [
              auditEntry(1, { actorType: 'system', actorId: null }),
              auditEntry(2, { actorType: 'ai', actorId: null }),
              auditEntry(3, { actorType: 'anonymous', actorId: null }),
            ],
            nextCursor: null,
          },
        },
      },
    });
    renderConsole(<AuditPage />);
    await screen.findByRole('table', { name: 'Audit log' });
    for (const name of ['System', 'AI', 'Anonymous']) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    }
  });

  it('filters by outcome and defaults to the last 24 hours', async () => {
    const user = userEvent.setup();
    const api = consoleApi();
    renderConsole(<AuditPage />);
    await screen.findByRole('table', { name: 'Audit log' });
    const first = api.callsTo('/v1/audit-logs', 'GET')[0];
    const from = new URLSearchParams(first?.search).get('from');
    expect(Date.now() - Date.parse(from ?? '')).toBeLessThan(24 * 3_600_000 + 60_000);
    expect(Date.now() - Date.parse(from ?? '')).toBeGreaterThan(24 * 3_600_000 - 60_000);
    expect(new URLSearchParams(first?.search).has('outcome')).toBe(false);

    await user.click(screen.getByRole('radio', { name: 'Denied' }));
    await waitFor(() => {
      const last = api.callsTo('/v1/audit-logs', 'GET').at(-1);
      expect(new URLSearchParams(last?.search).get('outcome')).toBe('denied');
    });
  });

  it('filters by actor type', async () => {
    const user = userEvent.setup();
    const api = consoleApi();
    renderConsole(<AuditPage />);
    await screen.findByRole('table', { name: 'Audit log' });
    await user.selectOptions(screen.getByLabelText('Actor type'), 'system');
    await waitFor(() => {
      const last = api.callsTo('/v1/audit-logs', 'GET').at(-1);
      expect(new URLSearchParams(last?.search).get('actorType')).toBe('system');
    });
  });

  it('offers a CSV export with the same filters to the head', async () => {
    consoleApi();
    renderConsole(<AuditPage />);
    const link = await screen.findByRole('link', { name: 'Export CSV' });
    expect(link).toHaveAttribute('download');
    const url = new URL(link.getAttribute('href') ?? '');
    expect(url.pathname).toBe('/v1/audit-logs/export');
    expect(url.searchParams.has('from')).toBe(true);
  });

  it('loads more with the cursor', async () => {
    const user = userEvent.setup();
    const api = consoleApi({
      overrides: {
        'GET /v1/audit-logs': ({ url }) =>
          url.searchParams.has('cursor')
            ? { json: { entries: [auditEntry(9)], nextCursor: null } }
            : { json: { entries: [auditEntry(1)], nextCursor: 'next-page' } },
      },
    });
    renderConsole(<AuditPage />);
    await screen.findByRole('table', { name: 'Audit log' });
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => {
      expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3);
    });
    expect(api.callsTo('/v1/audit-logs', 'GET').at(-1)?.search).toContain('cursor=next-page');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('opens an entry in a sheet and keeps the address and the changes hidden until Show', async () => {
    const user = userEvent.setup();
    consoleApi();
    renderConsole(<AuditPage />);
    const table = await screen.findByRole('table', { name: 'Audit log' });
    await user.click(within(table).getAllByRole('row')[1] as HTMLElement);
    const sheet = await screen.findByRole('dialog', { name: 'Autonomy · stage set' });
    expect(within(sheet).getByText('req-1')).toBeVisible();
    expect(within(sheet).queryByText('203.0.113.7')).not.toBeInTheDocument();
    expect(within(sheet).queryByText('"stage"')).not.toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Show' }));
    expect(within(sheet).getByText('203.0.113.7')).toBeVisible();
    const diff = within(sheet).getByRole('table', { name: 'Changes' });
    expect(within(diff).getByText('stage')).toBeVisible();
    expect(within(diff).getByText('1')).toBeVisible();
    expect(within(diff).getByText('2')).toBeVisible();
    await user.click(within(sheet).getByRole('button', { name: 'Hide' }));
    expect(within(sheet).queryByText('203.0.113.7')).not.toBeInTheDocument();
  });

  it('says nothing matches when the filters find nothing, and offers a retry on failure', async () => {
    consoleApi({
      overrides: { 'GET /v1/audit-logs': { json: { entries: [], nextCursor: null } } },
    });
    const { unmount } = renderConsole(<AuditPage />);
    expect(await screen.findByText('No entries match these filters.')).toBeVisible();
    unmount();
    consoleApi({ overrides: { 'GET /v1/audit-logs': apiError(500, 'unknown') } });
    renderConsole(<AuditPage />);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('is for the head only: a lead is told it needs the head role', async () => {
    consoleApi({ role: 'lead' });
    renderConsole(<AuditPage />);
    expect(await screen.findByText('It needs the Head role.')).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
