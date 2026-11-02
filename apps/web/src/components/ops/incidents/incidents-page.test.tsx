import { DEFAULT_ROLE_PERMISSIONS } from '@watchtower/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiError } from '@/test/mock-api';
import { makeSession, uuid } from '@/test/fixtures';
import { changes, comm, incidentDetail, preview } from '@/test/ops-fixtures';
import { opsApi } from '@/test/ops-api';
import { renderConsole } from '@/test/render-console';

import { IncidentsPage } from './incidents-page';

const replace = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
  usePathname: () => '/incidents',
  useSearchParams: () => new URLSearchParams(search),
}));

const INCIDENT = uuid(7600);

beforeEach(() => {
  search = `incident=${INCIDENT}`;
});
afterEach(() => {
  vi.unstubAllGlobals();
  replace.mockReset();
});

async function openUpdates(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('tab', { name: 'Customer updates' }));
}

describe('Incident list and detail', () => {
  it('shows SEV2 with its code and word, and the status in words', async () => {
    opsApi();
    renderConsole(<IncidentsPage />);
    const row = await screen.findByRole('button', { name: /INC-12 · Checkout is slow/ });
    expect(row).toHaveTextContent('SEV2');
    expect(row).toHaveTextContent('Major');
    expect(row).toHaveTextContent('Investigating');
    expect(row).toHaveTextContent('2 tickets, 1 alerts');
  });

  it('shows the timeline, and sends a note as typed', async () => {
    const api = opsApi({
      overrides: { 'POST /v1/incidents/:id/notes': { status: 201, json: { timelineId: uuid(1) } } },
    });
    renderConsole(<IncidentsPage />);
    const user = userEvent.setup();
    expect(await screen.findByText('Rolled back the last deploy')).toBeVisible();
    await user.type(screen.getByLabelText('Add a note'), 'Customer confirmed it is faster');
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => {
      expect(api.calls.find((c) => c.path.endsWith('/notes'))?.body).toEqual({
        text: 'Customer confirmed it is faster',
      });
    });
  });

  it('says plainly when the repository is not connected in What changed', async () => {
    opsApi();
    renderConsole(<IncidentsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'What changed' }));
    expect(await screen.findByText(/v2026.11.1/)).toBeVisible();
    expect(screen.getByText(/No repository is connected/)).toBeVisible();
  });

  it('warns that a repository that could not be read is not the same as no changes', async () => {
    opsApi({
      overrides: {
        'GET /v1/incidents/:id/changes': {
          json: changes({ repoSource: 'live', repoUnavailable: true }),
        },
      },
    });
    renderConsole(<IncidentsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'What changed' }));
    expect(await screen.findByText(/could not be read/)).toBeVisible();
  });

  it('says there are no open incidents', async () => {
    search = '';
    opsApi({ overrides: { 'GET /v1/incidents': { json: { items: [], nextCursor: null } } } });
    renderConsole(<IncidentsPage />);
    expect(await screen.findByText('No open incidents.')).toBeVisible();
  });

  it('shows an error with a way to retry', async () => {
    search = '';
    opsApi({ overrides: { 'GET /v1/incidents': apiError(500, 'internal_error') } });
    renderConsole(<IncidentsPage />);
    expect(await screen.findByText('Could not load the incidents.')).toBeVisible();
  });

  it('keeps a resolved incident read-only', async () => {
    opsApi({
      overrides: {
        'GET /v1/incidents/:id': {
          json: incidentDetail({ status: 'resolved', resolvedAt: '2026-11-02T04:00:00.000Z' }),
        },
      },
    });
    renderConsole(<IncidentsPage />);
    expect(await screen.findByText(/resolved and can no longer be changed/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add note' })).not.toBeInTheDocument();
  });
});

describe('Customer updates: draft, preview, confirm, send (N3)', () => {
  it('drafts without sending anything', async () => {
    const api = opsApi({
      overrides: {
        'POST /v1/incidents/:id/comms': { status: 201, json: comm({ body: 'Hello' }) },
      },
    });
    renderConsole(<IncidentsPage />);
    const user = userEvent.setup();
    await openUpdates(user);
    await user.type(await screen.findByLabelText('Write an update'), 'We are on it.');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(api.calls.find((c) => c.method === 'POST' && c.path.endsWith('/comms'))?.body).toEqual(
        {
          body: 'We are on it.',
        },
      );
    });
    expect(api.calls.some((c) => c.path.endsWith('/send'))).toBe(false);
  });

  it('shows the exact recipient count and sends only after it is confirmed, with that count', async () => {
    const api = opsApi({
      overrides: {
        'POST /v1/incidents/:id/comms/:commId/send': {
          json: { recipients: 7, sent: 7, failed: 0 },
        },
      },
    });
    renderConsole(<IncidentsPage />);
    const user = userEvent.setup();
    await openUpdates(user);
    await user.click(await screen.findByRole('button', { name: 'Review and send…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send this update to customers' });
    expect(await within(dialog).findByText('It reaches 7 customers now.')).toBeVisible();
    expect(
      within(dialog).getByText(/1 tickets on another channel and 2 closed tickets/),
    ).toBeVisible();

    const send = within(dialog).getByRole('button', { name: 'Send to 7 customers' });
    expect(send).toBeDisabled();
    await user.click(
      within(dialog).getByRole('checkbox', {
        name: 'I checked the words. Send to exactly 7 customers.',
      }),
    );
    expect(send).toBeEnabled();
    expect(api.calls.some((c) => c.path.endsWith('/send'))).toBe(false);

    await user.click(send);
    await waitFor(() => {
      expect(api.calls.find((c) => c.path.endsWith('/send'))?.body).toEqual({
        confirmRecipients: 7,
      });
    });
    expect(await within(dialog).findByText('Sent to 7 of 7. 0 failed.')).toBeVisible();
  });

  it('refuses to send when the audience changed (409) and asks again with the new count', async () => {
    let count = 7;
    const api = opsApi({
      overrides: {
        'GET /v1/incidents/:id/comms/preview': () => ({ json: preview({ recipients: count }) }),
        'POST /v1/incidents/:id/comms/:commId/send': () => {
          count = 9;
          return apiError(409, 'conflict', 'The audience changed');
        },
      },
    });
    renderConsole(<IncidentsPage />);
    const user = userEvent.setup();
    await openUpdates(user);
    await user.click(await screen.findByRole('button', { name: 'Review and send…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send this update to customers' });
    await within(dialog).findByText('It reaches 7 customers now.');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Send to 7 customers' }));

    expect(await within(dialog).findByText(/The audience changed since you looked/)).toBeVisible();
    // The new number is shown and has to be confirmed again.
    expect(await within(dialog).findByText('It reaches 9 customers now.')).toBeVisible();
    expect(within(dialog).getByRole('checkbox')).not.toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Send to 9 customers' })).toBeDisabled();
    expect(api.calls.filter((c) => c.path.endsWith('/send'))).toHaveLength(1);
  });

  it('cannot send to nobody', async () => {
    opsApi({
      overrides: { 'GET /v1/incidents/:id/comms/preview': { json: preview({ recipients: 0 }) } },
    });
    renderConsole(<IncidentsPage />);
    const user = userEvent.setup();
    await openUpdates(user);
    await user.click(await screen.findByRole('button', { name: 'Review and send…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send this update to customers' });
    expect(await within(dialog).findByText(/Nobody would receive this update/)).toBeVisible();
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Send to 0 customers' })).toBeDisabled();
  });

  it('labels an AI draft, and still needs a person to send it', async () => {
    opsApi({
      overrides: {
        'GET /v1/incidents/:id/comms': { json: { items: [comm({ origin: 'ai' })] } },
      },
    });
    renderConsole(<IncidentsPage />);
    const user = userEvent.setup();
    await openUpdates(user);
    expect(await screen.findByText('AI draft')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Review and send…' })).toBeVisible();
  });

  it('lets an agent draft but names who sends, with no Send button', async () => {
    opsApi({ role: 'agent' });
    renderConsole(<IncidentsPage />);
    const user = userEvent.setup();
    await openUpdates(user);
    expect(await screen.findByLabelText('Write an update')).toBeVisible();
    expect(screen.getByText('A lead or head sends this update.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Review and send…' })).not.toBeInTheDocument();
  });

  it('hides customer updates completely without the permission to draft or send', async () => {
    const permissions = DEFAULT_ROLE_PERMISSIONS.agent.filter(
      (p) => p !== 'incident.create' && p !== 'incident.manage',
    );
    opsApi({
      overrides: { 'GET /v1/auth/session': { json: makeSession('agent', { permissions }) } },
    });
    renderConsole(<IncidentsPage />);
    await screen.findByRole('tab', { name: 'Timeline' });
    expect(screen.queryByRole('tab', { name: 'Customer updates' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New incident' })).not.toBeInTheDocument();
  });
});
