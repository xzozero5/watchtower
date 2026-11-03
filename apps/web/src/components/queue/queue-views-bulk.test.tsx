import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SavedView } from '@watchtower/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetPreferencesCache } from '@/lib/preferences';
import { renderWorkspace } from '@/test-utils';
import { uuid } from '@/test/fixtures';
import { apiError } from '@/test/mock-api';
import { viewList, workspaceApi } from '@/test/scenarios';

// T-119d: the queue's server-side views (built-in with counts, shared, personal) and the bulk bar.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

beforeEach(() => {
  localStorage.clear();
  resetPreferencesCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function openQueue(options: Parameters<typeof renderWorkspace>[0] = {}) {
  const view = renderWorkspace(options);
  const queue = await screen.findByRole('region', { name: 'Queue' });
  return { ...view, queue };
}

/** Opens the view switcher and picks a view with the keyboard (Radix menus ignore jsdom clicks). */
async function chooseView(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: /^View:/ }));
  const item = await screen.findByRole('menuitemradio', { name: new RegExp(`^${name}`) });
  item.focus();
  await user.keyboard('{Enter}');
}

const rowOf = (key: string) => document.getElementById(`queue-row-${key}`);

function savedView(
  id: string,
  name: string,
  kind: 'shared' | 'personal',
  ownerName: string,
): SavedView {
  return {
    id,
    kind,
    key: null,
    name,
    filters: { priority: ['P1'] },
    sort: 'created_desc',
    ownerId: uuid(900),
    ownerName,
    count: 1,
    editable: true,
    createdAt: '2026-11-02T03:00:00.000Z',
    updatedAt: '2026-11-02T03:00:00.000Z',
  };
}

describe('server views in the view switcher', () => {
  it("lists the built-in views with how many tickets each holds, then the team's and my own", async () => {
    const user = userEvent.setup();
    workspaceApi({
      overrides: {
        'GET /v1/views': {
          json: viewList({ sla_at_risk: 4, triage: 2, waiting_on_customer: 7, my_queue: 3 }, [
            savedView('team-1', 'Billing watch', 'shared', 'Lead Lena'),
            savedView('mine-1', 'My P1s', 'personal', 'Alex Agent'),
          ]),
        },
      },
    });
    await openQueue();
    await screen.findByText('Cannot log in');

    await user.click(screen.getByRole('button', { name: /^View:/ }));
    expect(await screen.findByRole('menuitemradio', { name: /SLA at risk/ })).toHaveTextContent(
      '4',
    );
    expect(screen.getByRole('menuitemradio', { name: /Needs triage/ })).toHaveTextContent('2');
    expect(screen.getByRole('menuitemradio', { name: /Waiting on customer/ })).toHaveTextContent(
      '7',
    );
    expect(screen.getByRole('menuitemradio', { name: /My queue/ })).toHaveTextContent('3');
    expect(screen.getByText('Shared with the team')).toBeVisible();
    expect(screen.getByRole('menuitemradio', { name: /Billing watch/ })).toBeVisible();
    expect(screen.getByText('My saved views')).toBeVisible();
    expect(screen.getByRole('menuitemradio', { name: /My P1s/ })).toBeVisible();
  });

  it('asks for SLA at risk most urgent first, and for triage and waiting by status', async () => {
    const user = userEvent.setup();
    const api = workspaceApi();
    await openQueue();
    await screen.findByText('Cannot log in');
    const lastSearch = () => decodeURIComponent(api.callsTo('/v1/tickets').at(-1)?.search ?? '');

    await chooseView(user, 'SLA at risk');
    await waitFor(() => {
      expect(lastSearch()).toContain('slaState=at_risk,breached');
      expect(lastSearch()).toContain('sort=sla_due_asc');
    });
    await chooseView(user, 'Needs triage');
    await waitFor(() => {
      expect(lastSearch()).toContain('status=triage');
      expect(lastSearch()).not.toContain('slaState');
    });
    await chooseView(user, 'Waiting on customer');
    await waitFor(() => {
      expect(lastSearch()).toContain('status=waiting_on_customer');
    });
  });

  it('saves the filters as a view on the server, shows it, and deletes it there', async () => {
    const user = userEvent.setup();
    const saved: SavedView[] = [];
    const api = workspaceApi({
      overrides: {
        'GET /v1/views': () => ({ json: viewList({}, saved) }),
        'POST /v1/views': ({ body }) => {
          const input = body as { name: string; shared: boolean };
          const created = savedView(
            'new-1',
            input.name,
            input.shared ? 'shared' : 'personal',
            'Alex Agent',
          );
          saved.push(created);
          return { status: 201, json: created };
        },
        'DELETE /v1/views/:id': ({ params }) => {
          saved.splice(0, saved.length, ...saved.filter((view) => view.id !== params.id));
          return { status: 204 };
        },
      },
    });
    await openQueue();
    await screen.findByText('Cannot log in');

    await user.click(screen.getByRole('button', { name: /Filters/ }));
    await user.click(screen.getByRole('checkbox', { name: 'P1 Critical' }));
    await user.type(screen.getByRole('textbox', { name: 'Name for this view' }), 'Critical only');
    await user.click(screen.getByRole('button', { name: 'Save view' }));

    await waitFor(() => {
      expect(api.callsTo('/v1/views', 'POST')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/views', 'POST')[0]?.body).toEqual({
      name: 'Critical only',
      filters: {
        status: ['new', 'triage', 'open', 'waiting_on_customer', 'waiting_on_dev'],
        priority: ['P1'],
      },
      sort: 'sla_due_asc',
      shared: false,
    });
    // The saved view's filters (priority P1 only, as the mock stores them) are not the current ones,
    // but it is listed in the switcher.
    await user.click(await screen.findByRole('button', { name: /^View:/ }));
    expect(await screen.findByRole('menuitemradio', { name: /Critical only/ })).toBeVisible();
    await user.keyboard('{Escape}');

    // Pick it, then delete it from the filter panel (still open from saving).
    await chooseView(user, 'Critical only');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'View: Critical only' })).toBeVisible();
    });
    await user.click(screen.getByRole('button', { name: 'Delete "Critical only"' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/views/new-1', 'DELETE')).toHaveLength(1);
    });
    await user.click(screen.getByRole('button', { name: /^View:/ }));
    await waitFor(() => {
      expect(screen.queryByRole('menuitemradio', { name: /Critical only/ })).toBeNull();
    });
  });

  it('only offers to share a view to someone who may, and says when a name is taken', async () => {
    const user = userEvent.setup();
    const api = workspaceApi({
      overrides: {
        'POST /v1/views': apiError(409, 'conflict', 'A view with that name already exists'),
      },
    });
    await openQueue();
    await screen.findByText('Cannot log in');
    await user.click(screen.getByRole('button', { name: /Filters/ }));
    // An agent does not hold view.share.
    expect(screen.queryByRole('checkbox', { name: 'Share with the team' })).toBeNull();

    await user.type(screen.getByRole('textbox', { name: 'Name for this view' }), 'Mine');
    await user.click(screen.getByRole('button', { name: 'Save view' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A view with that name already exists.',
    );
    expect(api.callsTo('/v1/views', 'POST')).toHaveLength(1);
  });

  it('lets a lead share the view with the team', async () => {
    const user = userEvent.setup();
    const api = workspaceApi({
      role: 'lead',
      overrides: {
        'POST /v1/views': ({ body }) => ({
          status: 201,
          json: savedView('t-1', (body as { name: string }).name, 'shared', 'Alex Agent'),
        }),
      },
    });
    await openQueue();
    await screen.findByText('Cannot log in');
    await user.click(screen.getByRole('button', { name: /Filters/ }));
    await user.type(screen.getByRole('textbox', { name: 'Name for this view' }), 'Team view');
    await user.click(screen.getByRole('checkbox', { name: 'Share with the team' }));
    await user.click(screen.getByRole('button', { name: 'Save view' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/views', 'POST')[0]?.body).toMatchObject({
        name: 'Team view',
        shared: true,
      });
    });
  });

  it('gives a customer no saved views and no way to save one', async () => {
    const user = userEvent.setup();
    const api = workspaceApi({ role: 'client' });
    await openQueue();
    await screen.findByText(/Customer subject 1/);
    await user.click(screen.getByRole('button', { name: /Filters/ }));
    expect(screen.queryByRole('textbox', { name: 'Name for this view' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'On track' })).toBeNull();
    expect(api.callsTo('/v1/views')).toHaveLength(0);
  });

  it('shows the filter by SLA state to staff', async () => {
    const user = userEvent.setup();
    const api = workspaceApi();
    await openQueue();
    await screen.findByText('Cannot log in');
    await user.click(screen.getByRole('button', { name: /Filters/ }));
    await user.click(screen.getByRole('checkbox', { name: 'At risk' }));
    await waitFor(() => {
      expect(decodeURIComponent(api.callsTo('/v1/tickets').at(-1)?.search ?? '')).toContain(
        'slaState=at_risk',
      );
    });
  });
});

const bulkResult = (ids: string[], keys: string[]) => ({
  action: 'status',
  total: ids.length,
  succeeded: ids.length,
  failed: 0,
  items: ids.map((ticketId, index) => ({ ticketId, key: keys[index] ?? null, ok: true })),
});

describe('bulk actions', () => {
  const BAR = { name: 'Actions for the selected tickets' };

  async function selectTwo(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByText('Cannot log in');
    await user.click(screen.getByTitle('Select OPS-1'));
    await user.click(screen.getByTitle('Select OPS-2'));
    return screen.getByRole('region', BAR);
  }

  it('replaces the filter bar with a bar that counts the selection; X ticks the open ticket', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openQueue();
    await screen.findByText('Cannot log in');
    expect(screen.queryByRole('region', BAR)).toBeNull();

    // X ticks the ticket that is open (it is open after a click on its row).
    await user.click(screen.getByText('Cannot log in'));
    await user.keyboard('x');
    const bar = await screen.findByRole('region', BAR);
    expect(within(bar).getByText('1 selected')).toBeVisible();
    expect(screen.queryByRole('searchbox', { name: 'Search tickets' })).toBeNull();

    await user.click(screen.getByTitle('Select OPS-2'));
    expect(within(bar).getByText('2 selected')).toBeVisible();
    await user.keyboard('x');
    expect(within(bar).getByText('1 selected')).toBeVisible();

    await user.click(within(bar).getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('region', BAR)).toBeNull();
    expect(screen.getByRole('searchbox', { name: 'Search tickets' })).toBeVisible();
  });

  it('does not tick on X when single-key shortcuts are off, but the checkbox still works', async () => {
    const user = userEvent.setup();
    localStorage.setItem('wt-single-key-shortcuts', 'off');
    resetPreferencesCache();
    workspaceApi();
    await openQueue();
    await screen.findByText('Cannot log in');
    await user.click(screen.getByText('Cannot log in'));
    await user.keyboard('x');
    expect(screen.queryByRole('region', BAR)).toBeNull();
    await user.click(screen.getByTitle('Select OPS-1'));
    expect(await screen.findByRole('region', BAR)).toBeVisible();
  });

  it('asks before it acts, then changes the status of the selected tickets in one request', async () => {
    const user = userEvent.setup();
    const api = workspaceApi({
      overrides: {
        'POST /v1/tickets/bulk': ({ body }) => ({
          json: bulkResult((body as { ticketIds: string[] }).ticketIds, ['OPS-1', 'OPS-2']),
        }),
      },
    });
    await openQueue();
    const bar = await selectTwo(user);

    await user.selectOptions(within(bar).getByRole('combobox', { name: 'Status' }), 'resolved');
    // Nothing has been sent yet: the bar says what would happen.
    expect(api.callsTo('/v1/tickets/bulk')).toHaveLength(0);
    expect(within(bar).getByText(/Status: Resolved/)).toBeVisible();

    await user.click(within(bar).getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/bulk', 'POST')).toHaveLength(1);
    });
    const sent = api.callsTo('/v1/tickets/bulk', 'POST')[0]?.body as {
      ticketIds: string[];
      action: unknown;
    };
    expect([...sent.ticketIds].sort()).toEqual([uuid(1), uuid(2)].sort());
    expect(sent.action).toEqual({ type: 'status', status: 'resolved' });

    // Done: the selection is gone and the result stays on screen.
    expect(await screen.findByText('Done: 2 tickets updated.')).toBeVisible();
    expect(screen.queryByRole('region', BAR)).toBeNull();
    // Lists and counts are fetched again.
    await waitFor(() => {
      expect(api.callsTo('/v1/views').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('assigns, changes the priority and merges with the right request each time', async () => {
    const user = userEvent.setup();
    const api = workspaceApi({
      overrides: {
        'POST /v1/tickets/bulk': ({ body }) => ({
          json: bulkResult((body as { ticketIds: string[] }).ticketIds, []),
        }),
      },
    });
    await openQueue();
    const action = () =>
      (api.callsTo('/v1/tickets/bulk', 'POST').at(-1)?.body as { action: unknown } | undefined)
        ?.action;

    let bar = await selectTwo(user);
    await user.selectOptions(within(bar).getByRole('combobox', { name: 'Assign' }), uuid(901));
    await user.click(within(bar).getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(action()).toEqual({ type: 'assign', assigneeId: uuid(901) });
    });

    bar = await selectTwo(user);
    await user.selectOptions(within(bar).getByRole('combobox', { name: 'Priority' }), 'P1');
    await user.click(within(bar).getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(action()).toEqual({ type: 'priority', priority: 'P1' });
    });

    bar = await selectTwo(user);
    await user.selectOptions(within(bar).getByRole('combobox', { name: 'Assign' }), '__nobody__');
    await user.click(within(bar).getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(action()).toEqual({ type: 'assign', assigneeId: null });
    });

    bar = await selectTwo(user);
    await user.click(within(bar).getByRole('button', { name: 'Merge…' }));
    await user.type(within(bar).getByRole('textbox', { name: 'Ticket to keep' }), 'OPS-9');
    await user.click(within(bar).getByRole('button', { name: 'Merge 2 tickets' }));
    await waitFor(() => {
      expect(action()).toEqual({ type: 'merge', intoTicketId: 'OPS-9' });
    });
  });

  it('keeps the tickets that could not be changed selected and says why for each', async () => {
    const user = userEvent.setup();
    workspaceApi({
      overrides: {
        'POST /v1/tickets/bulk': {
          json: {
            action: 'status',
            total: 2,
            succeeded: 1,
            failed: 1,
            items: [
              { ticketId: uuid(1), key: 'OPS-1', ok: true },
              {
                ticketId: uuid(2),
                key: 'OPS-2',
                ok: false,
                error: { status: 409, code: 'invalid_transition', message: 'x' },
              },
            ],
          },
        },
      },
    });
    await openQueue();
    const bar = await selectTwo(user);
    await user.selectOptions(within(bar).getByRole('combobox', { name: 'Status' }), 'closed');
    await user.click(within(bar).getByRole('button', { name: 'Apply' }));

    expect(
      await screen.findByText('1 updated, 1 could not be changed. They stay selected.'),
    ).toBeVisible();
    expect(
      screen.getByText('OPS-2: The workflow does not allow that status from here.'),
    ).toBeVisible();
    // Only OPS-2 is still ticked.
    expect(within(screen.getByRole('region', BAR)).getByText('1 selected')).toBeVisible();
    expect(rowOf('OPS-2')).toHaveAttribute('data-checked', 'true');
    expect(rowOf('OPS-1')).toHaveAttribute('data-checked', 'false');
  });

  it('says so when the request itself fails, and keeps the selection', async () => {
    const user = userEvent.setup();
    workspaceApi({ overrides: { 'POST /v1/tickets/bulk': apiError(500, 'internal_error') } });
    await openQueue();
    const bar = await selectTwo(user);
    await user.selectOptions(within(bar).getByRole('combobox', { name: 'Priority' }), 'P2');
    await user.click(within(bar).getByRole('button', { name: 'Apply' }));
    expect(
      await screen.findByText('The change could not be sent. Check your connection and try again.'),
    ).toBeVisible();
    expect(within(screen.getByRole('region', BAR)).getByText('2 selected')).toBeVisible();
  });

  it('leaves the selection with Escape in the list', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openQueue();
    await selectTwo(user);
    document.getElementById('queue-listbox')?.focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', BAR)).toBeNull();
  });

  it('gives a customer no checkboxes and no bulk bar', async () => {
    const user = userEvent.setup();
    workspaceApi({ role: 'client' });
    await openQueue();
    await screen.findByText(/Customer subject 1/);
    expect(screen.queryByTitle(/^Select OPS/)).toBeNull();
    await user.click(screen.getByText(/Customer subject 1/));
    await user.keyboard('x');
    expect(screen.queryByRole('region', BAR)).toBeNull();
  });
});
