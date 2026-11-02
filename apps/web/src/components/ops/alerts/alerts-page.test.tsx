import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiError } from '@/test/mock-api';
import { alert, alertDetail, FAR_FUTURE } from '@/test/ops-fixtures';
import { opsApi } from '@/test/ops-api';
import { renderConsole } from '@/test/render-console';
import { uuid } from '@/test/fixtures';

import { AlertsPage } from './alerts-page';

const replace = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
  usePathname: () => '/alerts',
  useSearchParams: () => new URLSearchParams(search),
}));

beforeEach(() => {
  search = '';
});
afterEach(() => {
  vi.unstubAllGlobals();
  replace.mockReset();
});

describe('Alerts list', () => {
  it('shows severity as icon, code and word, and the state in words', async () => {
    opsApi();
    renderConsole(<AlertsPage />);
    const list = await screen.findByRole('list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // Critical -> P1 Critical, warning -> P3 Warning: the words are on screen, not only a colour.
    expect(rows[0]).toHaveTextContent('P1');
    expect(rows[0]).toHaveTextContent('Critical');
    expect(rows[0]).toHaveTextContent('Open');
    expect(rows[1]).toHaveTextContent('P3');
    expect(rows[1]).toHaveTextContent('Warning');
  });

  it('shows an alert with no service as unmapped, in words', async () => {
    opsApi({
      overrides: {
        'GET /v1/alerts': {
          json: { items: [alert(3, { serviceId: null, severity: 'unknown' })], nextCursor: null },
        },
      },
    });
    renderConsole(<AlertsPage />);
    const row = (await screen.findAllByRole('listitem'))[0];
    expect(row).toHaveTextContent('No service');
    expect(row).toHaveTextContent('Severity unmapped');
    expect(row).toHaveTextContent('P3');
  });

  it('asks the api for unmapped alerts in the Unmapped view', async () => {
    search = 'view=unmapped';
    const api = opsApi();
    renderConsole(<AlertsPage />);
    await screen.findAllByRole('listitem');
    expect(
      api.calls.some((c) => c.path === '/v1/alerts' && c.search.includes('unmapped=true')),
    ).toBe(true);
  });

  it('says plainly when nothing needs acknowledgment, and when loading fails', async () => {
    opsApi({
      overrides: { 'GET /v1/alerts': { json: { items: [], nextCursor: null } } },
    });
    const { unmount } = renderConsole(<AlertsPage />);
    expect(await screen.findByText('No alert is waiting for acknowledgment.')).toBeVisible();
    unmount();

    opsApi({ overrides: { 'GET /v1/alerts': apiError(500, 'internal_error') } });
    renderConsole(<AlertsPage />);
    expect(await screen.findByText('Could not load the alerts.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('opens an alert through the address when a row is chosen', async () => {
    opsApi();
    renderConsole(<AlertsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Checkout latency high 1/ }));
    expect(replace).toHaveBeenCalledWith(`/alerts?alert=${uuid(7001)}`);
  });

  it('moves to the next row with J', async () => {
    opsApi();
    renderConsole(<AlertsPage />);
    const user = userEvent.setup();
    await screen.findAllByRole('listitem');
    await user.keyboard('j');
    expect(replace).toHaveBeenCalledWith(`/alerts?alert=${uuid(7001)}`);
  });
});

describe('Alert detail', () => {
  const id = uuid(7001);

  it('acknowledges with the button and says so when somebody was first', async () => {
    search = `alert=${id}`;
    const api = opsApi({
      overrides: {
        'POST /v1/alerts/:id/ack': () => ({
          json: { changed: false, alert: alertDetail(1, { state: 'acknowledged' }) },
        }),
      },
    });
    renderConsole(<AlertsPage />);
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: /Acknowledge/ });
    await user.click(button);
    await waitFor(() => {
      expect(api.calls.some((c) => c.method === 'POST' && c.path === `/v1/alerts/${id}/ack`)).toBe(
        true,
      );
    });
    expect(await screen.findByText('Someone had already acknowledged this alert.')).toBeVisible();
  });

  it('acknowledges with the A key', async () => {
    search = `alert=${id}`;
    const api = opsApi({
      overrides: {
        'POST /v1/alerts/:id/ack': () => ({
          json: { changed: true, alert: alertDetail(1, { state: 'acknowledged' }) },
        }),
      },
    });
    renderConsole(<AlertsPage />);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: /Acknowledge/ });
    await user.keyboard('a');
    await waitFor(() => {
      expect(api.calls.some((c) => c.method === 'POST' && c.path.endsWith('/ack'))).toBe(true);
    });
  });

  it('does not offer to acknowledge without alert.ack, or when already acknowledged', async () => {
    search = `alert=${id}`;
    opsApi({
      overrides: {
        'GET /v1/alerts/:id': {
          json: alertDetail(1, {
            state: 'acknowledged',
            ackedAt: '2026-11-02T03:00:00.000Z',
            ackedVia: 'discord',
          }),
        },
      },
    });
    renderConsole(<AlertsPage />);
    const button = await screen.findByRole('button', { name: /Acknowledge/ });
    expect(button).toBeDisabled();
    expect(await screen.findByText(/Acknowledged via Discord/)).toBeVisible();
  });

  it('shows the escalation that ran, and says a mock post was not delivered', async () => {
    search = `alert=${id}`;
    opsApi();
    renderConsole(<AlertsPage />);
    expect(await screen.findByText(/Step 1: Whoever is on shift/)).toBeVisible();
    expect(screen.getByText(/chat post recorded only, not delivered/)).toBeVisible();
  });

  it('requires a reason to snooze and sends minutes, never a timestamp', async () => {
    search = `alert=${id}`;
    const api = opsApi({
      overrides: {
        'POST /v1/alerts/:id/snooze': () => ({
          json: {
            changed: true,
            alert: alertDetail(1, {
              snoozedUntil: FAR_FUTURE,
              snoozeReason: 'Waiting for the vendor',
            }),
          },
        }),
      },
    });
    renderConsole(<AlertsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Snooze…/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Snooze this alert' });
    await user.click(within(dialog).getByRole('button', { name: 'Snooze' }));
    expect(await within(dialog).findByText('Write at least 3 characters.')).toBeVisible();
    expect(api.calls.some((c) => c.path.endsWith('/snooze'))).toBe(false);

    await user.type(within(dialog).getByLabelText('Reason'), 'Waiting for the vendor');
    await user.click(within(dialog).getByRole('button', { name: 'Snooze' }));
    await waitFor(() => {
      const call = api.calls.find((c) => c.path.endsWith('/snooze'));
      expect(call?.body).toEqual({ minutes: 60, reason: 'Waiting for the vendor' });
    });
  });

  it('hides snooze and lets an agent acknowledge but not snooze', async () => {
    search = `alert=${id}`;
    opsApi({ role: 'agent' });
    renderConsole(<AlertsPage />);
    await screen.findByRole('button', { name: /Acknowledge/ });
    expect(screen.queryByRole('button', { name: /Snooze/ })).not.toBeInTheDocument();
  });

  it('offers to lift a snooze that is in force', async () => {
    search = `alert=${id}`;
    opsApi({
      overrides: {
        'GET /v1/alerts/:id': {
          json: alertDetail(1, { snoozedUntil: FAR_FUTURE, snoozeReason: 'Vendor maintenance' }),
        },
      },
    });
    renderConsole(<AlertsPage />);
    expect(await screen.findByRole('button', { name: 'Lift snooze' })).toBeVisible();
    expect(await screen.findByText(/Vendor maintenance/)).toBeVisible();
  });
});
