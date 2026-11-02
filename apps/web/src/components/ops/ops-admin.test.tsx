import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { uuid } from '@/test/fixtures';
import { mockApi, apiError } from '@/test/mock-api';
import { healthSnapshot, policy, service, statusPost } from '@/test/ops-fixtures';
import { opsApi } from '@/test/ops-api';
import { renderConsole } from '@/test/render-console';
import { makeSession } from '@/test/fixtures';

import { ServicesPage } from './alerts/services-page';
import { OrgHealthCard } from './org-health-card';
import { StatusAdminPage } from './status/status-admin-page';

let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/alerts/services',
  useSearchParams: () => new URLSearchParams(search),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  search = '';
});

describe('Status page admin: publishing is a person pressing a button (N3)', () => {
  it('shows exactly what goes public and how many subscribers are told, and publishes only on confirm', async () => {
    const api = opsApi({
      overrides: {
        'GET /v1/status-page/posts': {
          json: { items: [statusPost(1)], nextCursor: null },
        },
        'POST /v1/status-page/posts/:id/publish': () => ({
          json: { post: statusPost(1, { state: 'published' }), subscribers: 12 },
        }),
      },
    });
    renderConsole(<StatusAdminPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish this post?' });
    expect(await within(dialog).findByText(/emailed to 12 confirmed subscribers/)).toBeVisible();
    expect(
      within(dialog).getByText('We are investigating an issue affecting Component 1.'),
    ).toBeVisible();
    expect(api.calls.some((c) => c.path.endsWith('/publish'))).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => {
      expect(api.calls.some((c) => c.method === 'POST' && c.path.endsWith('/publish'))).toBe(true);
    });
  });

  it('lets an agent draft but not publish, and says who publishes', async () => {
    opsApi({
      role: 'agent',
      overrides: {
        'GET /v1/status-page/posts': {
          json: { items: [statusPost(1)], nextCursor: null },
        },
      },
    });
    renderConsole(<StatusAdminPage />);
    expect(await screen.findByText('A lead or head publishes this.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New post' })).toBeVisible();
    // Subscribers are for incident.manage only.
    expect(screen.queryByRole('tab', { name: 'Subscribers' })).not.toBeInTheDocument();
  });

  it('shows the subscriber counts without any address', async () => {
    opsApi();
    renderConsole(<StatusAdminPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Subscribers' }));
    const confirmed = await screen.findByText('Confirmed');
    expect(confirmed.parentElement).toHaveTextContent('12');
    expect(screen.getByText(/Addresses are never listed/)).toBeVisible();
  });

  it('keeps a component hidden unless it is shown on purpose', async () => {
    opsApi({
      overrides: {
        'GET /v1/status-page/components': {
          json: {
            items: [
              {
                id: uuid(8001),
                slug: 'internal-tools',
                name: 'Internal tools',
                description: null,
                serviceId: null,
                public: false,
                position: 0,
                status: 'operational',
              },
            ],
          },
        },
      },
    });
    renderConsole(<StatusAdminPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Components' }));
    const row = await screen.findByText('Internal tools');
    expect(row.closest('li')).toHaveTextContent('Hidden');
  });
});

describe('Services, policies and heartbeats', () => {
  it('lists services with their matching rules and the unmapped explanation', async () => {
    opsApi();
    renderConsole(<ServicesPage />);
    expect(await screen.findByText('Checkout API')).toBeVisible();
    expect(screen.getByText('gcp_monitoring · Checkout latency · env=prod')).toBeVisible();
  });

  it('creates a service with its rule and sends labels as a map', async () => {
    const api = opsApi({
      overrides: {
        'POST /v1/services': {
          status: 201,
          json: service({ slug: 'search-api', name: 'Search API' }),
        },
      },
    });
    renderConsole(<ServicesPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add service' }));
    const sheet = await screen.findByRole('dialog');
    await user.type(within(sheet).getByLabelText('Name'), 'Search API');
    await user.type(within(sheet).getByLabelText('Identifier'), 'search-api');
    await user.click(within(sheet).getByRole('button', { name: 'Add rule' }));
    await user.type(within(sheet).getByLabelText(/^Labels/), 'env=prod');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const call = api.calls.find((c) => c.method === 'POST' && c.path === '/v1/services');
      expect(call?.body).toMatchObject({
        slug: 'search-api',
        name: 'Search API',
        matchRules: [{ labels: { env: 'prod' } }],
      });
    });
  });

  it('checks the slug before asking the api', async () => {
    const api = opsApi();
    renderConsole(<ServicesPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add service' }));
    const sheet = await screen.findByRole('dialog');
    await user.type(within(sheet).getByLabelText('Name'), 'Search');
    await user.type(within(sheet).getByLabelText('Identifier'), 'Not A Slug');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(await within(sheet).findByText(/Use lower case letters/)).toBeVisible();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('hides the buttons that change a service from someone who may only read', async () => {
    opsApi({ role: 'agent' });
    renderConsole(<ServicesPage />);
    await screen.findByText('Checkout API');
    expect(screen.queryByRole('button', { name: 'Add service' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('shows escalation policy steps in minutes, and refuses steps out of order', async () => {
    search = 'tab=policies';
    const api = opsApi({
      overrides: {
        'GET /v1/escalation-policies': { json: { items: [policy()] } },
        'POST /v1/escalation-policies': {
          status: 201,
          json: policy({ id: uuid(7201), name: 'Strict', isDefault: false }),
        },
      },
    });
    renderConsole(<ServicesPage />);
    expect(await screen.findByText('The lead after 5 min')).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add policy' }));
    const sheet = await screen.findByRole('dialog');
    await user.type(within(sheet).getByLabelText('Name'), 'Strict');
    await user.click(within(sheet).getByRole('button', { name: 'Add step' }));
    // The second step is not later than the first (0 and 0).
    const [, second] = within(sheet).getAllByLabelText('After (minutes)');
    if (!second) throw new Error('no second step');
    await user.type(second, '0');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(
      await within(sheet).findByText('Each step must come later than the one before.'),
    ).toBeVisible();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('shows a missing heartbeat in words with its icon', async () => {
    search = 'tab=heartbeats';
    opsApi({
      overrides: {
        'GET /v1/heartbeats': {
          json: {
            items: [
              {
                id: uuid(7300),
                slug: 'nightly-export',
                name: 'Nightly export',
                expectedIntervalSeconds: 86_400,
                graceSeconds: 3600,
                severity: 'error',
                serviceId: null,
                active: true,
                state: 'missing',
                lastBeatAt: null,
                missingSince: '2026-11-02T01:00:00.000Z',
                createdAt: '2026-11-01T00:00:00.000Z',
                updatedAt: '2026-11-01T00:00:00.000Z',
              },
            ],
          },
        },
      },
    });
    renderConsole(<ServicesPage />);
    const row = (await screen.findByText('Nightly export')).closest('li');
    expect(row).toHaveTextContent('Missing');
    expect(row).toHaveTextContent('No signal received yet');
  });
});

describe('Org Health Score card', () => {
  const ORG = uuid(500);

  it('asks for nothing and shows nothing without org.health.read', async () => {
    const api = mockApi({
      'GET /v1/auth/session': { json: makeSession('agent') },
    });
    renderConsole(<OrgHealthCard orgId={ORG} />);
    await waitFor(() => {
      expect(api.calls.some((c) => c.path === '/v1/auth/session')).toBe(true);
    });
    expect(screen.queryByText('Client Health Score')).not.toBeInTheDocument();
    expect(api.calls.some((c) => c.path.endsWith('/health'))).toBe(false);
  });

  it('shows the score with the parts and says the weights are an assumption', async () => {
    mockApi({
      'GET /v1/auth/session': { json: makeSession('lead') },
      'GET /v1/orgs/:id/health': { json: { snapshot: healthSnapshot() } },
    });
    renderConsole(<OrgHealthCard orgId={ORG} />);
    expect(await screen.findByText('74')).toBeVisible();
    expect(screen.getByText(/weights of the formula are an assumption/)).toBeVisible();
    expect(screen.getByText('Customer satisfaction').closest('tr')).toHaveTextContent('No data');
  });

  it('states plainly that there is not enough data and shows no number', async () => {
    mockApi({
      'GET /v1/auth/session': { json: makeSession('lead') },
      'GET /v1/orgs/:id/health': {
        json: {
          snapshot: healthSnapshot({
            status: 'insufficient_data',
            score: null,
            components: [{ key: 'sla', weight: 0.3, status: 'no_data', score: null, detail: {} }],
          }),
        },
      },
    });
    renderConsole(<OrgHealthCard orgId={ORG} />);
    expect(await screen.findByText('Not enough data for a score')).toBeVisible();
    expect(screen.queryByText(/\/ 100/)).not.toBeInTheDocument();
  });

  it('says no score exists yet when there is no snapshot, and shows an error with a retry', async () => {
    mockApi({
      'GET /v1/auth/session': { json: makeSession('lead') },
      'GET /v1/orgs/:id/health': { json: { snapshot: null } },
    });
    const { unmount } = renderConsole(<OrgHealthCard orgId={ORG} />);
    expect(
      await screen.findByText('No score has been computed for this organization yet.'),
    ).toBeVisible();
    unmount();

    mockApi({
      'GET /v1/auth/session': { json: makeSession('lead') },
      'GET /v1/orgs/:id/health': apiError(500, 'internal_error'),
    });
    renderConsole(<OrgHealthCard orgId={ORG} />);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeVisible();
  });
});
