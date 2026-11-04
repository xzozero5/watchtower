import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiError, mockApi } from '@/test/mock-api';
import { publicStatus } from '@/test/ops-fixtures';
import { makeChallenge } from '@/test/portal-fixtures';
import { renderApp } from '@/test-utils';

import { PublicStatusPage } from './public-status-page';
import { SubscriptionLinkPage } from './subscription-link-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/status',
}));

const TOKEN = 'abcdefghij-0123456789.signature';

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const HISTORY = { json: { days: 90, posts: [], maintenance: [] } };

describe('Public status page', () => {
  it('shows the overall state and every component with its status in words', async () => {
    mockApi({
      'GET /v1/status': {
        json: publicStatus({
          overall: 'outage',
          components: [
            { slug: 'web-app', name: 'Web app', description: null, status: 'major_outage' },
            { slug: 'api', name: 'API', description: null, status: 'operational' },
          ],
        }),
      },
      'GET /v1/status/history': HISTORY,
    });
    renderApp(<PublicStatusPage />);
    expect(await screen.findByText('Some systems are not working.')).toBeVisible();
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Web app');
    expect(items[0]).toHaveTextContent('Major outage');
    expect(items[1]).toHaveTextContent('Operational');
    expect(await screen.findByText('No issues or maintenance in the past 90 days.')).toBeVisible();
  });

  it('renders the not-found page when the api answers 404 (the page is switched off)', async () => {
    window.history.replaceState(null, '', '/status');
    const api = mockApi({
      'GET /v1/status': apiError(404, 'not_found'),
      'GET /v1/status/history': apiError(404, 'not_found'),
    });
    renderApp(<PublicStatusPage />);
    expect(await screen.findByText('Page not found')).toBeVisible();
    expect(screen.queryByText('Components')).not.toBeInTheDocument();
    // No staff session is asked for on the public page.
    expect(api.calls.some((c) => c.path === '/v1/auth/session')).toBe(false);
  });

  it('sends no cookies and no staff header to the public api', async () => {
    const api = mockApi({
      'GET /v1/status': { json: publicStatus() },
      'GET /v1/status/history': HISTORY,
    });
    renderApp(<PublicStatusPage />);
    await screen.findByText('All systems are working.');
    const init = api.fetchMock.mock.calls[0]?.[1];
    expect(init?.credentials).toBe('omit');
    expect(api.calls[0]?.headers.get('x-csrf-token')).toBeNull();
  });

  it('shows an error with a retry when the status cannot be loaded', async () => {
    mockApi({ 'GET /v1/status': apiError(500, 'internal_error') });
    renderApp(<PublicStatusPage />);
    expect(await screen.findByText(/Could not load the status/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('shows current issues and upcoming maintenance', async () => {
    mockApi({
      'GET /v1/status': {
        json: publicStatus({
          overall: 'degraded',
          activePosts: [
            {
              id: 'a0000000-0000-4000-8000-000000009001',
              title: 'We are investigating an issue',
              body: 'We are investigating an issue affecting API.',
              phase: 'investigating',
              impact: 'minor',
              publishedAt: '2026-11-02T03:00:00.000Z',
              updatedAt: '2026-11-02T03:00:00.000Z',
              components: [{ slug: 'api', name: 'API' }],
            },
          ],
          upcomingMaintenance: [
            {
              id: 'a0000000-0000-4000-8000-000000009002',
              title: 'Database upgrade',
              body: 'Planned.',
              startsAt: '2026-11-05T03:00:00.000Z',
              endsAt: '2026-11-05T04:00:00.000Z',
              components: [],
            },
          ],
        }),
      },
      'GET /v1/status/history': HISTORY,
    });
    renderApp(<PublicStatusPage />);
    expect(await screen.findByText('We are investigating an issue')).toBeVisible();
    expect(screen.getByText('Planned')).toBeVisible();
    expect(screen.getByText('Database upgrade')).toBeVisible();
  });

  it('subscribes with the same answer for any address (double opt-in)', async () => {
    const api = mockApi({
      'GET /v1/status': { json: publicStatus() },
      'GET /v1/status/history': HISTORY,
      'GET /v1/status/subscriptions/challenge': () => ({ json: makeChallenge() }),
      'POST /v1/status/subscriptions': { status: 202, json: { status: 'check_your_email' } },
    });
    renderApp(<PublicStatusPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email address'), 'Person@Example.com');
    await user.click(screen.getByRole('button', { name: 'Subscribe' }));
    expect(await screen.findByText('Check your email')).toBeVisible();
    // The request carries a solved proof of work (T-207a C-3) and no honeypot value.
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
      email: 'person@example.com',
      locale: 'en',
      verification: {
        provider: 'pow-sha256',
        challenge: makeChallenge().challenge,
        nonce: expect.stringMatching(/^\d+$/) as string,
      },
    });
  });

  it('refuses an address that is not an address before asking the api', async () => {
    const api = mockApi({
      'GET /v1/status': { json: publicStatus() },
      'GET /v1/status/history': HISTORY,
    });
    renderApp(<PublicStatusPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email address'), 'not-an-address');
    await user.click(screen.getByRole('button', { name: 'Subscribe' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeVisible();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('Subscription links', () => {
  it('takes the token out of the address bar and sends it only when the button is pressed', async () => {
    window.history.replaceState(null, '', `/status/confirm#token=${TOKEN}`);
    const api = mockApi({
      'POST /v1/status/subscriptions/confirm': { json: { status: 'confirmed' } },
    });
    renderApp(<SubscriptionLinkPage mode="confirm" />);
    const button = await screen.findByRole('button', { name: 'Confirm subscription' });
    expect(window.location.hash).toBe('');
    expect(api.calls).toHaveLength(0);
    const user = userEvent.setup();
    await user.click(button);
    expect(await screen.findByText('You are subscribed.')).toBeVisible();
    expect(api.calls[0]?.body).toEqual({ token: TOKEN });
    // The token is in the body, never in the URL.
    expect(api.calls[0]?.search).toBe('');
  });

  it('unsubscribes with the same shape', async () => {
    window.history.replaceState(null, '', `/status/unsubscribe#token=${TOKEN}`);
    const api = mockApi({
      'POST /v1/status/subscriptions/unsubscribe': { json: { status: 'unsubscribed' } },
    });
    renderApp(<SubscriptionLinkPage mode="unsubscribe" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Unsubscribe' }));
    expect(await screen.findByText('You are unsubscribed.')).toBeVisible();
    expect(api.calls[0]?.path).toBe('/v1/status/subscriptions/unsubscribe');
  });

  it('says one plain sentence for a link that is missing or expired', async () => {
    mockApi({});
    const { unmount } = renderApp(<SubscriptionLinkPage mode="confirm" />);
    expect(await screen.findByText('This link is not valid or has expired.')).toBeVisible();
    unmount();

    window.history.replaceState(null, '', `/status/confirm#token=${TOKEN}`);
    mockApi({
      'POST /v1/status/subscriptions/confirm': apiError(400, 'invalid_or_expired_link'),
    });
    renderApp(<SubscriptionLinkPage mode="confirm" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Confirm subscription' }));
    expect(await screen.findByText('This link is not valid or has expired.')).toBeVisible();
  });

  it('renders not-found when the status page is switched off', async () => {
    window.history.replaceState(null, '', `/status/unsubscribe#token=${TOKEN}`);
    mockApi({ 'POST /v1/status/subscriptions/unsubscribe': apiError(404, 'not_found') });
    renderApp(<SubscriptionLinkPage mode="unsubscribe" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Unsubscribe' }));
    await waitFor(() => {
      expect(screen.getByText('Page not found')).toBeVisible();
    });
  });
});
