import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RealtimeEvent } from '@watchtower/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SAVED_VIEWS_KEY_PREFIX } from '@/lib/tickets/saved-views';
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
    .getAllByRole('button', { name: /OPS-\d+/ })
    .map((row) => row.getAttribute('data-ticket-key'));

describe('queue rows', () => {
  it('shows priority as icon + code, status as words and the assignee state', async () => {
    workspaceApi();
    const { queue } = await openQueue();
    const first = (await within(queue).findByText('Cannot log in')).closest('button');
    if (!first) throw new Error('row not found');

    expect(within(first).getByText('P1')).toBeVisible();
    expect(first.querySelector('[data-severity="p1"] svg')).not.toBeNull();
    expect(within(first).getByText('Open')).toBeVisible();
    expect(within(first).getByText('Unassigned')).toBeVisible();
    expect(within(first).getByText('Example Org')).toBeVisible();
  });

  it('marks an overdue ticket with words and an icon, not only colour', async () => {
    workspaceApi({
      tickets: [makeTicket(1, { firstResponseDueAt: '2026-01-01T00:00:00.000Z' })],
    });
    const { queue } = await openQueue();
    const row = (await within(queue).findByText('Subject of ticket 1')).closest('button');
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
    expect(await screen.findByText('No tickets yet')).toBeVisible();
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
    expect(screen.getByRole('button', { name: /OPS-1/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /OPS-1/ })).toHaveFocus();
    expect(await screen.findByRole('heading', { name: 'Cannot log in', level: 3 })).toBeVisible();

    await user.keyboard('j');
    expect(screen.getByRole('button', { name: /OPS-2/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /OPS-1/ })).not.toHaveAttribute('aria-current');
    expect(await screen.findByRole('heading', { name: 'Export is slow', level: 3 })).toBeVisible();
    expect(window.location.search).toBe('?ticket=OPS-2');

    await user.keyboard('k');
    expect(screen.getByRole('button', { name: /OPS-1/ })).toHaveAttribute('aria-current', 'true');
  });

  it('stops at the first and last ticket instead of wrapping', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openQueue();
    await screen.findByText('Cannot log in');

    await user.keyboard('kk');
    expect(screen.getByRole('button', { name: /OPS-1/ })).toHaveAttribute('aria-current', 'true');
    await user.keyboard('jjjjj');
    expect(screen.getByRole('button', { name: /OPS-3/ })).toHaveAttribute('aria-current', 'true');
  });

  it('does nothing while typing in the search box, or with a modifier key', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openQueue();
    await screen.findByText('Cannot log in');

    await user.type(screen.getByRole('searchbox', { name: 'Search tickets' }), 'jjk');
    await user.keyboard('{Control>}j{/Control}');
    expect(document.querySelector('[aria-current="true"]')).toBeNull();
  });

  it('opens the ticket named in the address', async () => {
    window.history.replaceState(null, '', '/?ticket=OPS-2');
    workspaceApi();
    await openQueue();
    expect(await screen.findByRole('heading', { name: 'Export is slow', level: 3 })).toBeVisible();
    expect(await screen.findByRole('button', { name: /OPS-2/ })).toHaveAttribute(
      'aria-current',
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
    const pill = await within(queue).findByRole('button', { name: '1 new — press .' });
    expect(pill.parentElement).toHaveAttribute('aria-live', 'polite');
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

describe('filters and saved views', () => {
  it('asks the api for what the view says', async () => {
    const user = userEvent.setup();
    const api = workspaceApi();
    await openQueue();
    await screen.findByText('Cannot log in');

    await user.selectOptions(screen.getByRole('combobox', { name: 'View' }), 'My queue');
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets').at(-1)?.search).toContain('assignee=me');
    });

    await user.selectOptions(screen.getByRole('combobox', { name: 'View' }), 'Overdue');
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

  it('saves a view in this browser, finds it again after a reload, and deletes it', async () => {
    const user = userEvent.setup();
    workspaceApi();
    const first = await openQueue();
    await screen.findByText('Cannot log in');

    await user.click(screen.getByRole('button', { name: /Filters/ }));
    await user.click(screen.getByRole('checkbox', { name: 'P1 Critical' }));
    await user.type(screen.getByRole('textbox', { name: 'Name for this view' }), 'Critical only');
    await user.click(screen.getByRole('button', { name: 'Save view' }));

    const view = screen.getByRole('combobox', { name: 'View' });
    expect(within(view).getByRole('option', { name: 'Critical only' })).toBeInTheDocument();
    expect((view as HTMLSelectElement).value).toMatch(/^s:/);
    const stored = Object.keys(localStorage).filter((key) =>
      key.startsWith(SAVED_VIEWS_KEY_PREFIX),
    );
    expect(stored).toEqual([`${SAVED_VIEWS_KEY_PREFIX}${uuid(900)}`]);

    // A fresh page load.
    first.unmount();
    workspaceApi();
    await openQueue();
    await screen.findByText('Cannot log in');
    expect(
      within(screen.getByRole('combobox', { name: 'View' })).getByRole('option', {
        name: 'Critical only',
      }),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'View' }), 'Critical only');
    await user.click(screen.getByRole('button', { name: /Filters/ }));
    await user.click(screen.getByRole('button', { name: 'Delete "Critical only"' }));
    expect(screen.queryByRole('option', { name: 'Critical only' })).not.toBeInTheDocument();
  });
});
