import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetClaimedTokens } from '@/lib/portal/tracking-token';
import { renderApp } from '@/test-utils';
import { uuid } from '@/test/fixtures';
import { apiError, mockApi, type MockHandler } from '@/test/mock-api';
import { makeView } from '@/test/portal-fixtures';

import { TrackingPage } from './tracking-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

// A made-up value in the shape of a real one. Not a credential.
const SAMPLE = 'c2FtcGxlLXZhbHVlLWZvci10ZXN0cw';

beforeEach(() => {
  sessionStorage.clear();
  resetClaimedTokens();
  window.history.replaceState(null, '', `/portal/tickets/OPS-12#token=${SAMPLE}`);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function openTracking(routes: Record<string, MockHandler> = {}, locale?: 'th') {
  const api = mockApi({
    'GET /v1/portal/tickets/:key': () => ({ json: makeView() }),
    ...routes,
  });
  renderApp(<TrackingPage ticketKey="OPS-12" />, locale ? { locale } : {});
  return api;
}

describe('portal tracking page', () => {
  it('takes the value from the fragment, removes it from the address bar and sends it as a header', async () => {
    const api = openTracking();
    expect(await screen.findByRole('heading', { name: 'OPS-12' })).toBeInTheDocument();

    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(SAMPLE);
    const [call] = api.callsTo('/v1/portal/tickets/OPS-12', 'GET');
    expect(call?.headers.get('x-portal-token')).toBe(SAMPLE);
    expect(call?.search).toBe('');
    // Public pages never call the staff api.
    expect(api.calls.every((c) => c.path.startsWith('/v1/portal/'))).toBe(true);
  });

  it('shows the status in customer words, the subject and the public timeline', async () => {
    openTracking();
    await screen.findByRole('heading', { name: 'OPS-12' });
    expect(screen.getByText('Cannot log in')).toBeInTheDocument();
    expect(
      screen.getByText('In progress', { selector: '[data-customer-status] span' }),
    ).toBeInTheDocument();

    const timeline = screen.getByRole('list');
    const items = within(timeline).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAttribute('data-from', 'customer');
    expect(within(items[0] as HTMLElement).getByText('You')).toBeInTheDocument();
    expect(items[0]).toHaveTextContent('Error 500.');
    expect(items[1]).toHaveTextContent('Status changed to In progress');
    // First name only, as the api sends it.
    expect(within(items[2] as HTMLElement).getByText('Somchai')).toBeInTheDocument();
    expect(items[2]).toHaveTextContent('We are looking into it.');
  });

  it('renders message text as plain text, never as markup', async () => {
    openTracking({
      'GET /v1/portal/tickets/:key': () => ({
        json: makeView({
          timeline: [
            {
              kind: 'message',
              id: uuid(5),
              from: 'support',
              authorName: null,
              body: '<img src=x onerror=alert(1)> **bold**',
              createdAt: '2026-11-05T04:30:00.000Z',
            },
          ],
        }),
      }),
    });
    await screen.findByRole('heading', { name: 'OPS-12' });
    expect(screen.getByText('<img src=x onerror=alert(1)> **bold**')).toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    // A reply without an agent name reads "Support team", not a blank.
    expect(screen.getByText('Support team')).toBeInTheDocument();
  });

  it('sends a reply with the header, adds it to the timeline and clears the box', async () => {
    const user = userEvent.setup();
    const reply = {
      kind: 'message' as const,
      id: uuid(9),
      from: 'customer' as const,
      authorName: null,
      body: 'Still failing, now on Safari.',
      createdAt: '2026-11-05T05:00:00.000Z',
    };
    let replied = false;
    const api = openTracking({
      // After the reply the api returns it as part of the timeline, as the real one does.
      'GET /v1/portal/tickets/:key': () => ({
        json: makeView({
          timeline: [...makeView().timeline, ...(replied ? [reply] : [])],
        }),
      }),
      'POST /v1/portal/tickets/:key/replies': () => {
        replied = true;
        return {
          status: 201,
          json: {
            message: {
              id: reply.id,
              from: 'customer',
              authorName: null,
              body: reply.body,
              createdAt: reply.createdAt,
            },
            status: 'in_progress',
            statusLabel: 'In progress',
          },
        };
      },
    });
    await screen.findByRole('heading', { name: 'OPS-12' });
    await user.type(screen.getByLabelText('Your message'), 'Still failing, now on Safari.');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    expect(await screen.findByText('Your reply was sent.')).toBeInTheDocument();
    const [post] = api.callsTo('/v1/portal/tickets/OPS-12/replies', 'POST');
    expect(post?.body).toEqual({ body: 'Still failing, now on Safari.' });
    expect(post?.headers.get('x-portal-token')).toBe(SAMPLE);
    expect(screen.getByLabelText('Your message')).toHaveValue('');
    expect(screen.getAllByText('Still failing, now on Safari.')).not.toHaveLength(0);
  });

  it('will not send an empty reply', async () => {
    const user = userEvent.setup();
    const api = openTracking();
    await screen.findByRole('heading', { name: 'OPS-12' });
    await user.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(screen.getByText('Write a message before you send.')).toBeInTheDocument();
    expect(screen.getByLabelText('Your message')).toHaveFocus();
    expect(api.callsTo('/v1/portal/tickets/OPS-12/replies', 'POST')).toHaveLength(0);
  });

  it('says a closed ticket cannot take replies and offers a new request', async () => {
    openTracking({
      'GET /v1/portal/tickets/:key': () => ({
        json: makeView({ status: 'closed', statusLabel: 'Closed', canReply: false }),
      }),
    });
    await screen.findByRole('heading', { name: 'OPS-12' });
    expect(screen.queryByLabelText('Your message')).not.toBeInTheDocument();
    expect(
      screen.getByText('This request is closed, so it cannot take new replies.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Submit a new request' })).toHaveAttribute(
      'href',
      '/portal',
    );
  });

  it('on 409 ticket_not_open explains it and refreshes the page state', async () => {
    const user = userEvent.setup();
    let reads = 0;
    const api = openTracking({
      'GET /v1/portal/tickets/:key': () => {
        reads += 1;
        return {
          json:
            reads === 1
              ? makeView()
              : makeView({ status: 'closed', statusLabel: 'Closed', canReply: false }),
        };
      },
      'POST /v1/portal/tickets/:key/replies': apiError(409, 'ticket_not_open'),
    });
    await screen.findByRole('heading', { name: 'OPS-12' });
    await user.type(screen.getByLabelText('Your message'), 'Hello?');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/portal/tickets/OPS-12', 'GET').length).toBeGreaterThan(1);
    });
    await waitFor(() => {
      expect(
        screen.getByText('This request is closed, so it cannot take new replies.'),
      ).toBeInTheDocument();
    });
  });

  it('shows "Merged into OPS-30" with a link to the primary ticket', async () => {
    openTracking({
      'GET /v1/portal/tickets/:key': () => ({
        json: makeView({
          status: 'merged',
          statusLabel: 'Merged',
          mergedIntoKey: 'OPS-30',
          canReply: false,
        }),
      }),
    });
    await screen.findByRole('heading', { name: 'OPS-12' });
    const merged = screen.getAllByText('Merged into OPS-30');
    expect(merged.length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Open OPS-30' })).toHaveAttribute(
      'href',
      '/portal/tickets/OPS-30',
    );
  });

  it('shows the expected first response while nothing has been answered yet', async () => {
    openTracking({
      'GET /v1/portal/tickets/:key': () => ({
        json: makeView({
          status: 'received',
          statusLabel: 'Received',
          expectedFirstResponseAt: '2026-11-05T08:00:00.000Z',
        }),
      }),
    });
    await screen.findByRole('heading', { name: 'OPS-12' });
    expect(screen.getByText(/We aim to reply by .*3:00\s?PM/)).toBeInTheDocument();
  });

  it('shows what happens next on the ticket page, with a plain sentence when no time is known', async () => {
    openTracking({
      'GET /v1/portal/tickets/:key': () => ({
        json: makeView({
          status: 'received',
          statusLabel: 'Received',
          expectedFirstResponseAt: null,
        }),
      }),
    });
    await screen.findByRole('heading', { name: 'OPS-12' });
    expect(screen.getByRole('heading', { name: 'What happens next' })).toBeInTheDocument();
    expect(screen.getByText('A person reviews it.')).toBeInTheDocument();
    expect(screen.getByText('We usually reply within business hours.')).toBeInTheDocument();
  });

  it('keeps working after a reload: no fragment, the tab still has the value', async () => {
    openTracking();
    await screen.findByRole('heading', { name: 'OPS-12' });
    expect(sessionStorage.getItem('wt-portal-token:OPS-12')).toBe(SAMPLE);
  });

  it('is available in Thai', async () => {
    openTracking({}, 'th');
    expect(await screen.findByRole('heading', { name: 'OPS-12' })).toBeInTheDocument();
    expect(screen.getByText('กำลังดำเนินการ')).toBeInTheDocument();
    expect(screen.getByText('ข้อความของคุณ')).toBeInTheDocument();
    expect(screen.getByText('คุณ')).toBeInTheDocument();
  });
});

describe('expired link', () => {
  it('shows "This link has expired" with a resend form when the api refuses the link', async () => {
    const user = userEvent.setup();
    const api = openTracking({
      'GET /v1/portal/tickets/:key': apiError(401, 'invalid_or_expired_link'),
      'POST /v1/portal/track/resend': { status: 202, json: { status: 'accepted' } },
    });
    expect(
      await screen.findByRole('heading', { name: 'This link has expired' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This link has expired. Enter your email and we'll send a new one."),
    ).toBeInTheDocument();
    // The refused value is forgotten.
    expect(sessionStorage.getItem('wt-portal-token:OPS-12')).toBeNull();
    expect(screen.getByLabelText('Request number')).toHaveValue('OPS-12');

    await user.type(screen.getByLabelText('Email address you used'), 'Ada@Example.com');
    await user.click(screen.getByRole('button', { name: 'Send a new link' }));
    expect(
      await screen.findByText("If this matches our records, we've sent a new link."),
    ).toBeInTheDocument();
    const [post] = api.callsTo('/v1/portal/track/resend', 'POST');
    expect(post?.body).toEqual({ ticketKey: 'OPS-12', email: 'ada@example.com' });
  });

  it('shows the same screen at once when the tab has no value, without calling the api', async () => {
    window.history.replaceState(null, '', '/portal/tickets/OPS-12');
    const api = openTracking();
    expect(
      await screen.findByRole('heading', { name: 'This link has expired' }),
    ).toBeInTheDocument();
    expect(api.callsTo('/v1/portal/tickets/OPS-12')).toHaveLength(0);
  });

  it('checks the form before sending', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/portal/tickets/OPS-12');
    const api = openTracking();
    await screen.findByRole('heading', { name: 'This link has expired' });
    await user.click(screen.getByRole('button', { name: 'Send a new link' }));
    expect(screen.getByText('Enter your email address.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email address you used')).toHaveFocus();
    expect(api.callsTo('/v1/portal/track/resend')).toHaveLength(0);
  });

  it('shows a wait when the resend is rate limited', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/portal/tickets/OPS-12');
    const api = openTracking({});
    api.fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ statusCode: 429, error: 'x', code: 'rate_limited', message: 'x' }),
          { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '120' } },
        ),
      ),
    );
    await screen.findByRole('heading', { name: 'This link has expired' });
    await user.type(screen.getByLabelText('Email address you used'), 'a@example.com');
    await user.click(screen.getByRole('button', { name: 'Send a new link' }));
    expect(
      await screen.findByText('Too many requests. Please wait about 2 minutes and try again.'),
    ).toBeInTheDocument();
  });
});

describe('errors', () => {
  it('offers Try again when the api fails, and recovers', async () => {
    const user = userEvent.setup();
    let calls = 0;
    openTracking({
      'GET /v1/portal/tickets/:key': () => {
        calls += 1;
        return calls === 1 ? { status: 500, json: undefined } : { json: makeView() };
      },
    });
    expect(await screen.findByText(/Something went wrong on our side/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'OPS-12' })).toBeInTheDocument();
  });
});
