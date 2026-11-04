import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PortalMyRequestsView } from '@watchtower/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetClaimedTokens } from '@/lib/portal/tracking-token';
import { renderApp } from '@/test-utils';
import { apiError, mockApi, type MockHandler } from '@/test/mock-api';
import { makeChallenge } from '@/test/portal-fixtures';

import { MyRequestsPage, resetMyRequestsOpening } from './my-requests-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

// Made-up values in the shape of real ones. Not credentials.
const LINK = 'wtl1.c2FtcGxlLWxpbmstZm9yLXRlc3RzLTAxMjM0NTY3ODkx';
const TICKET_VALUE = 'wtp1.c2FtcGxlLXRpY2tldC12YWx1ZQ';

function makeList(overrides: Partial<PortalMyRequestsView> = {}): PortalMyRequestsView {
  return {
    maskedEmail: 'a***@example.com',
    truncated: false,
    items: [
      {
        key: 'OPS-12',
        subject: 'Cannot log in',
        status: 'in_progress',
        statusLabel: 'In progress',
        createdAt: '2026-11-05T03:00:00.000Z',
        updatedAt: '2026-11-05T04:30:00.000Z',
        trackingToken: TICKET_VALUE,
      },
      {
        key: 'OPS-7',
        subject: 'Old invoice question',
        status: 'closed',
        statusLabel: 'Closed',
        createdAt: '2026-10-01T03:00:00.000Z',
        updatedAt: '2026-10-02T04:30:00.000Z',
        trackingToken: null,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  resetClaimedTokens();
  resetMyRequestsOpening();
  window.history.replaceState(null, '', '/portal/my-requests');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function openPage(routes: Record<string, MockHandler> = {}, locale?: 'th') {
  const api = mockApi({
    'GET /v1/portal/challenge': () => ({ json: makeChallenge() }),
    'POST /v1/portal/my-requests': { status: 202, json: { status: 'accepted' } },
    'POST /v1/portal/my-requests/open': () => ({ json: makeList() }),
    ...routes,
  });
  renderApp(<MyRequestsPage />, locale ? { locale } : {});
  return api;
}

describe('portal "my requests"', () => {
  it('asks for the address, runs the human check and says the same thing whatever the address', async () => {
    const user = userEvent.setup();
    const api = openPage();
    expect(await screen.findByRole('heading', { name: 'My requests' })).toBeVisible();
    await waitFor(() => {
      expect(screen.getByText('Verified. You can submit your request.')).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText('Email address'), 'Ada@Example.com');
    await user.click(screen.getByRole('button', { name: 'Email me the link' }));
    expect(
      await screen.findByText("If this matches our records, we've sent a link to your requests."),
    ).toBeVisible();
    const [call] = api.callsTo('/v1/portal/my-requests', 'POST');
    expect(call?.body).toMatchObject({
      email: 'ada@example.com',
      locale: 'en',
      verification: { provider: 'pow-sha256' },
    });
    // The honeypot stays empty and is not sent.
    expect(call?.body).not.toHaveProperty('website');
    expect(api.calls.every((c) => c.path.startsWith('/v1/portal/'))).toBe(true);
  });

  it('checks the address before it asks for anything', async () => {
    const user = userEvent.setup();
    const api = openPage();
    await user.click(await screen.findByRole('button', { name: 'Email me the link' }));
    expect(await screen.findByText('Enter your email address.')).toBeVisible();
    await user.type(screen.getByLabelText('Email address'), 'not-an-address');
    await user.click(screen.getByRole('button', { name: 'Email me the link' }));
    expect(await screen.findByText('Enter an email address like name@example.com.')).toBeVisible();
    expect(api.callsTo('/v1/portal/my-requests', 'POST')).toHaveLength(0);
  });

  it('tells a person who is rate limited how long to wait, and asks for a new challenge', async () => {
    const user = userEvent.setup();
    const api = openPage({
      'POST /v1/portal/my-requests': () => ({
        ...apiError(429, 'rate_limited'),
        headers: { 'retry-after': '120' },
      }),
    });
    await screen.findByText('Verified. You can submit your request.');
    await user.type(screen.getByLabelText('Email address'), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Email me the link' }));
    expect(await screen.findByText(/Too many requests\. Please wait about/)).toBeVisible();
    await waitFor(() => {
      expect(api.callsTo('/v1/portal/challenge', 'GET').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('opens the emailed link once: reads the fragment, removes it, sends it in a header and lists the requests', async () => {
    window.history.replaceState(null, '', `/portal/my-requests#token=${LINK}`);
    const api = openPage();
    expect(await screen.findByText('OPS-12')).toBeVisible();
    expect(screen.getByText('Old invoice question')).toBeVisible();
    expect(window.location.hash).toBe('');
    const calls = api.callsTo('/v1/portal/my-requests/open', 'POST');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get('x-portal-token')).toBe(LINK);
    expect(calls[0]?.search).toBe('');
    // Read-only and no credential on the page; the closed one says how to read it.
    expect(document.body.innerHTML).not.toContain(LINK);
    expect(document.body.innerHTML).not.toContain(TICKET_VALUE);
    expect(screen.getByText(/Closed\. Ask for a link on its page/)).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    // Each open ticket's token went where the tracking page looks for it, not into the list.
    expect(sessionStorage.getItem('wt-portal-token:OPS-12')).toBe(TICKET_VALUE);
    expect(sessionStorage.getItem('wt-portal-token:OPS-7')).toBeNull();
    expect(sessionStorage.getItem('wt-portal-my-requests')).not.toContain(TICKET_VALUE);
    expect(screen.getByRole('link', { name: 'Open OPS-12' })).toHaveAttribute(
      'href',
      '/portal/tickets/OPS-12',
    );
  });

  it('keeps the list for a reload of the same tab, without spending the link again', async () => {
    window.history.replaceState(null, '', `/portal/my-requests#token=${LINK}`);
    openPage();
    await screen.findByText('OPS-12');
    document.body.innerHTML = '';
    resetMyRequestsOpening();
    const second = openPage();
    expect(await screen.findByText('OPS-12')).toBeVisible();
    expect(second.callsTo('/v1/portal/my-requests/open', 'POST')).toHaveLength(0);
  });

  it('shows the expired-or-used screen with the request form for a refused link', async () => {
    window.history.replaceState(null, '', `/portal/my-requests#token=${LINK}`);
    openPage({
      'POST /v1/portal/my-requests/open': () => apiError(401, 'invalid_or_expired_link'),
    });
    expect(
      await screen.findByRole('heading', { name: 'This link has expired or was already used' }),
    ).toBeVisible();
    expect(screen.getByLabelText('Email address')).toBeVisible();
    expect(window.location.hash).toBe('');
  });

  it('leaving the list forgets it', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', `/portal/my-requests#token=${LINK}`);
    openPage();
    await screen.findByText('OPS-12');
    await user.click(screen.getByRole('button', { name: 'Close this list' }));
    expect(await screen.findByLabelText('Email address')).toBeVisible();
    expect(sessionStorage.getItem('wt-portal-my-requests')).toBeNull();
  });

  it('reads in Thai', async () => {
    openPage({}, 'th');
    expect(await screen.findByRole('heading', { name: 'คำขอของฉัน' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'ส่งลิงก์ทางอีเมล' })).toBeVisible();
  });
});
