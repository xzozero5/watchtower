import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RealtimeEvent } from '@watchtower/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetPreferencesCache } from '@/lib/preferences';
import { renderWorkspace } from '@/test-utils';
import { makeTicket, uuid } from '@/test/fixtures';
import { ticketCreatedEvent } from '@/test/fake-socket';
import { apiError } from '@/test/mock-api';
import { workspaceApi } from '@/test/scenarios';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function openQueue(options: Parameters<typeof renderWorkspace>[0] = {}) {
  const view = renderWorkspace(options);
  const queue = await screen.findByRole('region', { name: 'Queue' });
  return { ...view, queue };
}

const rowKeys = () =>
  screen
    .getAllByRole('option', { name: /OPS-\d+/ })
    .map((row) => row.getAttribute('data-ticket-key'));

describe('queue rows', () => {
  it('shows priority as icon + code and keeps quiet about an ordinary open ticket', async () => {
    workspaceApi();
    const { queue } = await openQueue();
    const first = (await within(queue).findByText('Cannot log in')).closest<HTMLElement>(
      '[role="option"]',
    );
    if (!first) throw new Error('row not found');

    expect(within(first).getByText('P1')).toBeVisible();
    expect(first.querySelector('[data-severity="p1"] svg')).not.toBeNull();
    // "Open" and "Unassigned" are the normal case: no words for them on the row.
    expect(within(first).queryByText('Open')).toBeNull();
    expect(within(first).queryByText('Unassigned')).toBeNull();
    // Who wrote in is for screen readers; the sighted row shows an initials avatar for the organisation.
    expect(first).toHaveTextContent('OPS-1, Riley Requester, Example Org');
    expect(first.querySelector('[data-hue]')).toHaveTextContent('EO');
    expect(first.querySelector('img')).toBeNull();
  });

  it('spells out a status only when it is not "open"', async () => {
    workspaceApi({ tickets: [makeTicket(1, { subject: 'Needs dev', status: 'waiting_on_dev' })] });
    const { queue } = await openQueue();
    const row = (await within(queue).findByText('Needs dev')).closest<HTMLElement>(
      '[role="option"]',
    );
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('Waiting on developers')).toBeVisible();
  });

  it('is a soft rounded pill with a tinted selection, a new-ticket dot and the channel', async () => {
    const user = userEvent.setup();
    workspaceApi({
      tickets: [
        makeTicket(1, { subject: 'Fresh one', status: 'new', channel: 'gmail' }),
        makeTicket(2, { subject: 'Old one', status: 'open', channel: 'line' }),
      ],
    });
    const { queue } = await openQueue();
    const fresh = (await within(queue).findByText('Fresh one')).closest<HTMLElement>(
      '[role="option"]',
    );
    const old = within(queue).getByText('Old one').closest<HTMLElement>('[role="option"]');
    if (!fresh || !old) throw new Error('rows missing');
    // A row is a soft rounded pill with no border; the selected one is tinted (no hard bar).
    expect(fresh.className).toContain('rounded-xl');
    expect(fresh.className).not.toContain('border-b');
    // New: bold subject and a dot; an older ticket has neither.
    expect(within(fresh).getByText('Fresh one')).toHaveClass('font-semibold');
    expect(fresh.querySelector('span[aria-hidden="true"].bg-primary')).not.toBeNull();
    expect(within(old).getByText('Old one')).not.toHaveClass('font-semibold');
    expect(old.querySelector('span[aria-hidden="true"].bg-primary')).toBeNull();
    // The channel is an icon with its name for screen readers and as a tooltip.
    expect(within(fresh).getByText('Email')).toHaveClass('sr-only');
    expect(fresh.querySelector('[data-channel="gmail"]')).toHaveAttribute('title', 'Email');
    expect(old.querySelector('[data-channel="line"]')).toBeInTheDocument();

    // Selecting a row tints the whole pill; there is no left bar.
    expect(old.className).not.toContain('bg-primary-subtle');
    await user.click(old);
    expect(old).toHaveAttribute('aria-selected', 'true');
    expect(old.className).toContain('bg-primary-subtle');
    expect(old.className).not.toContain('before:bg-primary');
  });

  it('shows the AI summary as the title and the subject only when the AI said nothing', async () => {
    workspaceApi({
      tickets: [
        makeTicket(1, {
          subject: 'Re: Re: login',
          ai: { state: 'draft_ready', summary: 'Locked out after a reset' },
        }),
        makeTicket(2, { subject: 'Plain subject' }),
      ],
    });
    const { queue } = await openQueue();
    const withAi = (
      await within(queue).findByText('Locked out after a reset')
    ).closest<HTMLElement>('[role="option"]');
    if (!withAi) throw new Error('row missing');
    expect(within(withAi).queryByText('Re: Re: login')).toBeNull();
    expect(within(withAi).getByText('Draft ready')).toBeVisible();
    expect(withAi).toHaveAttribute('data-ai-state', 'draft_ready');
    // Without an AI summary the subject stands in, muted.
    expect(within(queue).getByText('Plain subject')).toHaveClass('text-muted-foreground');
  });

  it('counts the tickets next to the view name', async () => {
    workspaceApi();
    const { queue } = await openQueue();
    await within(queue).findByText('Cannot log in');
    expect(within(queue).getByText('3 tickets')).toBeVisible();
    expect(within(queue).getByRole('button', { name: 'View: All open' })).toBeVisible();
  });

  it('marks an overdue ticket with words and an icon, not only colour', async () => {
    workspaceApi({
      tickets: [makeTicket(1, { firstResponseDueAt: '2026-01-01T00:00:00.000Z' })],
    });
    const { queue } = await openQueue();
    const row = (await within(queue).findByText('Subject of ticket 1')).closest<HTMLElement>(
      '[role="option"]',
    );
    expect(row).not.toBeNull();
    const badge = within(row as HTMLElement).getByRole('img', {
      name: /^Overdue .*First response due/,
    });
    expect(badge).toHaveAttribute('data-sla', 'breached');
    expect(badge.querySelector('svg')).not.toBeNull();
  });

  it('shows a loading state, then the empty state when there are no tickets', async () => {
    workspaceApi({ tickets: [] });
    await openQueue();
    expect(await screen.findByText('All caught up.')).toBeVisible();
  });

  it('says so, with a retry, when the queue cannot be loaded', async () => {
    const user = userEvent.setup();
    let fail = true;
    const api = workspaceApi({
      overrides: {
        'GET /v1/tickets': () =>
          fail
            ? apiError(500, 'unknown')
            : { json: { items: [makeTicket(1, { subject: 'Back again' })], nextCursor: null } },
      },
    });
    await openQueue();
    expect(await screen.findByText('The queue could not be loaded')).toBeVisible();

    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Back again')).toBeVisible();
    expect(api.callsTo('/v1/tickets')).toHaveLength(2);
  });

  it('loads the next page on request', async () => {
    const user = userEvent.setup();
    const api = workspaceApi({
      overrides: {
        'GET /v1/tickets': ({ url }) =>
          url.searchParams.get('cursor') === 'page-2'
            ? { json: { items: [makeTicket(2, { subject: 'Second page' })], nextCursor: null } }
            : { json: { items: [makeTicket(1, { subject: 'First page' })], nextCursor: 'page-2' } },
      },
    });
    await openQueue();
    await screen.findByText('First page');

    await user.click(screen.getByRole('button', { name: 'Load more tickets' }));
    expect(await screen.findByText('Second page')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Load more tickets' })).not.toBeInTheDocument();
    expect(api.callsTo('/v1/tickets')[1]?.search).toContain('cursor=page-2');
  });
});

describe('J and K navigation', () => {
  it('moves down and up the queue, opens each ticket and keeps the focus on the row', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openQueue();
    await screen.findByText('Cannot log in');

    await user.keyboard('j');
    expect(screen.getByRole('option', { name: /OPS-1/ })).toHaveAttribute('aria-selected', 'true');
    // The listbox keeps the focus and names the current row.
    expect(screen.getByRole('listbox', { name: 'Needs you' })).toHaveFocus();
    expect(screen.getByRole('listbox', { name: 'Needs you' })).toHaveAttribute(
      'aria-activedescendant',
      'queue-row-OPS-1',
    );
    expect(await screen.findByRole('heading', { name: 'Cannot log in', level: 3 })).toBeVisible();

    await user.keyboard('j');
    expect(screen.getByRole('option', { name: /OPS-2/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: /OPS-1/ })).toHaveAttribute('aria-selected', 'false');
    expect(await screen.findByRole('heading', { name: 'Export is slow', level: 3 })).toBeVisible();
    expect(window.location.search).toBe('?ticket=OPS-2');

    await user.keyboard('k');
    expect(screen.getByRole('option', { name: /OPS-1/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('stops at the first and last ticket instead of wrapping', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openQueue();
    await screen.findByText('Cannot log in');

    await user.keyboard('kk');
    expect(screen.getByRole('option', { name: /OPS-1/ })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('jjjjj');
    expect(screen.getByRole('option', { name: /OPS-3/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('does nothing while typing in the search box, or with a modifier key', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openQueue();
    await screen.findByText('Cannot log in');

    await user.type(screen.getByRole('searchbox', { name: 'Search tickets' }), 'jjk');
    await user.keyboard('{Control>}j{/Control}');
    expect(document.querySelector('[role="option"][aria-selected="true"]')).toBeNull();
  });

  it('opens the ticket named in the address', async () => {
    window.history.replaceState(null, '', '/?ticket=OPS-2');
    workspaceApi();
    await openQueue();
    expect(await screen.findByRole('heading', { name: 'Export is slow', level: 3 })).toBeVisible();
    expect(await screen.findByRole('option', { name: /OPS-2/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('"/" moves the focus to the search box', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openQueue();
    await user.keyboard('/');
    expect(screen.getByRole('searchbox', { name: 'Search tickets' })).toHaveFocus();
  });
});

describe('the "N new" pill', () => {
  const emit = async (
    sockets: ReturnType<typeof renderWorkspace>['sockets'],
    event: RealtimeEvent,
  ) => {
    await act(async () => {
      sockets.last.event(event);
      await Promise.resolve();
    });
  };

  it('counts new tickets without changing the list, and shows them on request', async () => {
    const user = userEvent.setup();
    const tickets = [makeTicket(1, { subject: 'Cannot log in' })];
    const api = workspaceApi({
      overrides: { 'GET /v1/tickets': () => ({ json: { items: tickets, nextCursor: null } }) },
    });
    const { sockets } = await openQueue();
    await screen.findByText('Cannot log in');
    await waitFor(() => {
      expect(sockets.sockets).toHaveLength(1);
    });
    await act(async () => {
      sockets.last.ready();
      await Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: /new — press/ })).not.toBeInTheDocument();

    const fresh = makeTicket(5, { subject: 'Brand new' });
    await emit(sockets, ticketCreatedEvent(fresh));
    expect(await screen.findByRole('button', { name: '1 new — press .' })).toBeVisible();
    await emit(sockets, ticketCreatedEvent(makeTicket(6)));
    expect(await screen.findByRole('button', { name: '2 new — press .' })).toBeVisible();

    // The list did not move and was not refetched.
    expect(rowKeys()).toEqual(['OPS-1']);
    expect(api.callsTo('/v1/tickets')).toHaveLength(1);

    tickets.unshift(fresh);
    await user.click(screen.getByRole('button', { name: '2 new — press .' }));

    expect(await screen.findByText('Brand new')).toBeVisible();
    expect(rowKeys()).toEqual(['OPS-5', 'OPS-1']);
    expect(screen.queryByRole('button', { name: /new — press/ })).not.toBeInTheDocument();
    expect(api.callsTo('/v1/tickets')).toHaveLength(2);
  });

  it('counts a ticket once even if its event is delivered twice, and . shows them', async () => {
    const user = userEvent.setup();
    const api = workspaceApi();
    const { sockets } = await openQueue();
    await screen.findByText('Cannot log in');
    await waitFor(() => {
      expect(sockets.sockets).toHaveLength(1);
    });
    await act(async () => {
      sockets.last.ready();
      await Promise.resolve();
    });
    const event = ticketCreatedEvent(makeTicket(9));
    await emit(sockets, event);
    await emit(sockets, event);
    expect(await screen.findByRole('button', { name: '1 new — press .' })).toBeVisible();

    await user.keyboard('.');
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets')).toHaveLength(2);
    });
    expect(screen.queryByRole('button', { name: /new — press/ })).not.toBeInTheDocument();
  });

  it('is announced politely to screen readers', async () => {
    workspaceApi();
    const { sockets, queue } = await openQueue();
    await screen.findByText('Cannot log in');
    await waitFor(() => {
      expect(sockets.sockets).toHaveLength(1);
    });
    await act(async () => {
      sockets.last.ready();
      await Promise.resolve();
    });
    await emit(sockets, ticketCreatedEvent(makeTicket(9)));
    await within(queue).findByRole('button', { name: '1 new — press .' });
    // The announcement lives in its own polite region; the button is not a live region.
    const live = within(queue).getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    await waitFor(() => {
      expect(live).toHaveTextContent('1 new — press .');
    });
  });

  it('announces the count to screen readers at most once per 30 s, while the button stays current', async () => {
    const user = userEvent.setup();
    workspaceApi();
    const { sockets, queue } = await openQueue();
    await screen.findByText('Cannot log in');
    await waitFor(() => {
      expect(sockets.sockets).toHaveLength(1);
    });
    await act(async () => {
      sockets.last.ready();
      await Promise.resolve();
    });
    const live = within(queue).getByRole('status');
    expect(live).toHaveTextContent('');

    await emit(sockets, ticketCreatedEvent(makeTicket(9)));
    await waitFor(() => {
      expect(live).toHaveTextContent('1 new — press .');
    });

    // More arrive straight away: the visible pill follows, the announcement is held back.
    await emit(sockets, ticketCreatedEvent(makeTicket(10)));
    await emit(sockets, ticketCreatedEvent(makeTicket(11)));
    expect(await within(queue).findByRole('button', { name: '3 new — press .' })).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(live).toHaveTextContent('1 new — press .');
    expect(live).not.toHaveTextContent('3 new');

    // Loading them clears the announcement at once.
    await user.click(within(queue).getByRole('button', { name: '3 new — press .' }));
    await waitFor(() => {
      expect(live).toHaveTextContent('');
    });
  });

  it('tells the person to click, not press a key, when single-key shortcuts are off', async () => {
    localStorage.setItem('wt-single-key-shortcuts', 'off');
    resetPreferencesCache();
    workspaceApi();
    const { sockets, queue } = await openQueue();
    await screen.findByText('Cannot log in');
    await waitFor(() => {
      expect(sockets.sockets).toHaveLength(1);
    });
    await act(async () => {
      sockets.last.ready();
      await Promise.resolve();
    });
    await emit(sockets, ticketCreatedEvent(makeTicket(9)));
    const pill = await within(queue).findByRole('button', { name: '1 new — click to show' });
    expect(pill).not.toHaveAttribute('aria-keyshortcuts');
  });

  it('updates an existing row in place when its ticket changes', async () => {
    const tickets = [
      makeTicket(1, { subject: 'Cannot log in' }),
      makeTicket(2, { subject: 'Export is slow' }),
    ];
    workspaceApi({ tickets });
    const { sockets } = await openQueue();
    await screen.findByText('Cannot log in');
    await waitFor(() => {
      expect(sockets.sockets).toHaveLength(1);
    });
    await act(async () => {
      sockets.last.ready();
      await Promise.resolve();
    });
    tickets[0] = makeTicket(1, { subject: 'Cannot log in (renamed)' });

    await emit(sockets, {
      id: uuid(4000),
      type: 'ticket.updated',
      occurredAt: '2026-11-02T03:05:00.000Z',
      orgId: uuid(500),
      ticketId: uuid(1),
      ticketKey: 'OPS-1',
      data: { subject: 'x', status: 'open', priority: 'P3', changed: ['subject'] },
    });

    expect(await screen.findByText('Cannot log in (renamed)')).toBeVisible();
    expect(rowKeys()).toEqual(['OPS-1', 'OPS-2']);
  });
});

/** Opens the view switcher and picks a view with the keyboard (Radix menus ignore jsdom clicks). */
async function chooseView(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: /^View:/ }));
  const item = await screen.findByRole('menuitemradio', { name: new RegExp(`^${name}`) });
  item.focus();
  await user.keyboard('{Enter}');
}

describe('filters and saved views', () => {
  it('asks the api for what the view says', async () => {
    const user = userEvent.setup();
    const api = workspaceApi();
    await openQueue();
    await screen.findByText('Cannot log in');

    await chooseView(user, 'My queue');
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets').at(-1)?.search).toContain('assignee=me');
    });

    await chooseView(user, 'Overdue');
    await waitFor(() => {
      const search = api.callsTo('/v1/tickets').at(-1)?.search ?? '';
      expect(search).toContain('overdue=true');
      expect(search).toContain('sort=due_asc');
    });
  });

  it('filters by status and priority from the panel', async () => {
    const user = userEvent.setup();
    const api = workspaceApi();
    await openQueue();
    await screen.findByText('Cannot log in');

    await user.click(screen.getByRole('button', { name: /Filters/ }));
    await user.click(screen.getByRole('checkbox', { name: 'P1 Critical' }));
    await user.click(screen.getByRole('checkbox', { name: 'Resolved' }));

    await waitFor(() => {
      const search = decodeURIComponent(api.callsTo('/v1/tickets').at(-1)?.search ?? '');
      expect(search).toContain('priority=P1');
      expect(search).toContain('resolved');
    });
    // The button says how many filters differ from the default.
    expect(screen.getByRole('button', { name: /Filters/ })).toHaveTextContent('2');
  });

  it('searches after a short pause', async () => {
    const user = userEvent.setup();
    const api = workspaceApi();
    await openQueue();
    await screen.findByText('Cannot log in');

    await user.type(screen.getByRole('searchbox', { name: 'Search tickets' }), 'invoice');
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets').at(-1)?.search).toContain('q=invoice');
    });
    // Typing did not send a request per letter.
    expect(api.callsTo('/v1/tickets').length).toBeLessThanOrEqual(3);
  });

  it('shows a helpful empty state for filters that match nothing, and resets', async () => {
    const user = userEvent.setup();
    const api = workspaceApi({
      overrides: {
        'GET /v1/tickets': ({ url }) =>
          url.searchParams.has('q')
            ? { json: { items: [], nextCursor: null } }
            : { json: { items: [makeTicket(1, { subject: 'Cannot log in' })], nextCursor: null } },
      },
    });
    await openQueue();
    await screen.findByText('Cannot log in');

    await user.type(screen.getByRole('searchbox', { name: 'Search tickets' }), 'zzz');
    expect(await screen.findByText('No tickets match these filters.')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('Cannot log in')).toBeVisible();
    expect(api.callsTo('/v1/tickets').length).toBeGreaterThanOrEqual(2);
  });

  // Saved views live on the server since T-119a: queue-views-bulk.test.tsx covers them.
});
