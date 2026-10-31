import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWorkspace } from '@/test-utils';
import { makeClientTicket, makeTicket, uuid } from '@/test/fixtures';
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

async function openDetails(options: Parameters<typeof renderWorkspace>[0] = {}) {
  window.history.replaceState(null, '', '/?ticket=OPS-1');
  const view = renderWorkspace(options);
  const section = await screen.findByRole('region', { name: 'Ticket details' });
  return { ...view, section };
}

/** The api echoes the ticket with the change applied, as the real endpoints do. */
function editable(initial = makeTicket(1, { tags: ['vip'] })) {
  let current = initial;
  const respond = (patch: Partial<typeof initial>) => {
    current = { ...current, ...patch };
    return { json: current };
  };
  return {
    get current() {
      return current;
    },
    api: workspaceApi({
      tickets: [initial],
      overrides: {
        'GET /v1/tickets/:id': () => ({ json: current }),
        'POST /v1/tickets/:id/status': ({ body }) =>
          respond({ status: (body as { status: typeof initial.status }).status }),
        'POST /v1/tickets/:id/assign': ({ body }) => {
          const id = (body as { assigneeId: string | null }).assigneeId;
          return respond({
            assignee: id ? { id, name: id === uuid(901) ? 'Sam Support' : 'Alex Agent' } : null,
          });
        },
        'PATCH /v1/tickets/:id': ({ body }) => respond(body as Partial<typeof initial>),
      },
    }),
  };
}

type User = ReturnType<typeof userEvent.setup>;

/** Opens an inline field (a button named "Status: Open") and picks an option from its list. */
async function openField(user: User, field: string) {
  await user.click(screen.getByRole('button', { name: new RegExp(`^${field}:`) }));
  return screen.findByRole('listbox', { name: field });
}

async function pick(user: User, field: string, option: string | RegExp) {
  const list = await openField(user, field);
  await user.click(await within(list).findByRole('option', { name: option }));
}

describe('ticket details: editing', () => {
  it('changes the status through the workflow, shows it at once and offers Undo', async () => {
    const user = userEvent.setup();
    const { api } = editable();
    const { section } = await openDetails();

    const list = await openField(user, 'Status');
    // The allowed moves arrive from the workflow endpoint; Merged is never one of them.
    expect(await within(list).findByRole('option', { name: /^Resolved/ })).toBeInTheDocument();
    expect(within(list).queryByRole('option', { name: /^Merged/ })).not.toBeInTheDocument();
    await user.click(within(list).getByRole('option', { name: /^Resolved/ }));

    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/status', 'POST')[0]?.body).toEqual({
        status: 'resolved',
      });
    });
    expect(await within(section).findByText('Saved.')).toBeVisible();
    expect(within(section).getByRole('button', { name: /^Status:\s*Resolved/ })).toBeVisible();
    // The header, queue row and timeline pick the change up too.
    expect(
      within(screen.getByRole('region', { name: 'Queue' })).getByText('Resolved'),
    ).toBeVisible();

    // The toast says what happened and Undo sends the old status back.
    expect(await screen.findByText('Status set to Resolved')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/status', 'POST')[1]?.body).toEqual({ status: 'open' });
    });
    expect(await within(section).findByRole('button', { name: /^Status:\s*Open/ })).toBeVisible();
  });

  it('shows the new value before the api has answered', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const initial = makeTicket(1);
    workspaceApi({
      tickets: [initial],
      overrides: {
        'PATCH /v1/tickets/:id': async () => {
          await gate;
          return { json: { ...initial, priority: 'P1' } };
        },
      },
    });
    const { section } = await openDetails();
    await pick(user, 'Priority', /^P1 Critical/);
    // The request is still pending, yet the value already changed.
    expect(
      within(section).getByRole('button', { name: /^Priority:\s*P1\s*Critical/ }),
    ).toBeVisible();
    release();
  });

  it('changes the priority', async () => {
    const user = userEvent.setup();
    const { api } = editable();
    await openDetails();
    await pick(user, 'Priority', /^P1 Critical/);
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1', 'PATCH')[0]?.body).toEqual({ priority: 'P1' });
    });
  });

  it('assigns to a queue member or to me, and unassigns', async () => {
    const user = userEvent.setup();
    const { api } = editable();
    const { section } = await openDetails();

    const list = await openField(user, 'Assignee');
    expect(await within(list).findByRole('option', { name: /^Sam Support/ })).toBeInTheDocument();
    // The signed-in user is always in the list and is marked.
    expect(within(list).getByRole('option', { name: /^Alex Agent \(me\)/ })).toBeInTheDocument();
    await user.click(within(list).getByRole('option', { name: /^Sam Support/ }));
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/assign', 'POST')[0]?.body).toEqual({
        assigneeId: uuid(901),
      });
    });
    expect(
      await within(section).findByRole('button', { name: /^Assignee:\s*Sam Support/ }),
    ).toBeVisible();

    await pick(user, 'Assignee', /^Unassigned/);
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/assign', 'POST')[1]?.body).toEqual({
        assigneeId: null,
      });
    });
  });

  it('finds an option by typing', async () => {
    const user = userEvent.setup();
    editable();
    await openDetails();
    const list = await openField(user, 'Assignee');
    await within(list).findByRole('option', { name: /^Sam Support/ });
    await user.keyboard('sam');
    expect(within(list).getByRole('option', { name: /^Sam Support/ })).toBeVisible();
    expect(within(list).queryByRole('option', { name: /^Alex Agent/ })).not.toBeInTheDocument();
    await user.clear(screen.getByRole('combobox', { name: 'Search' }));
    await user.keyboard('zzz');
    expect(within(list).getByText('No matches')).toBeVisible();
  });

  it('changes or clears the intent', async () => {
    const user = userEvent.setup();
    const { api } = editable();
    await openDetails();
    const list = await openField(user, 'Intent');
    expect(await within(list).findByRole('option', { name: /^Billing question/ })).toBeVisible();
    await user.click(within(list).getByRole('option', { name: /^Billing question/ }));
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1', 'PATCH')[0]?.body).toEqual({ intentId: uuid(701) });
    });
  });

  it('adds and removes tags', async () => {
    const user = userEvent.setup();
    const { api } = editable();
    const { section } = await openDetails();
    expect(within(section).getByText('vip')).toBeVisible();

    const list = await openField(user, 'Tags');
    await user.keyboard('billing');
    await user.click(await within(list).findByRole('option', { name: 'Create tag “billing”' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1', 'PATCH')[0]?.body).toEqual({
        tags: ['vip', 'billing'],
      });
    });
    expect(await within(section).findByText('billing')).toBeVisible();

    // The list stays open for more changes; choosing a tag that is set removes it.
    await user.click(await within(list).findByRole('option', { name: /^vip/ }));
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1', 'PATCH')[1]?.body).toEqual({ tags: ['billing'] });
    });
  });

  it('explains a refused change and puts the value back', async () => {
    const user = userEvent.setup();
    workspaceApi({
      tickets: [makeTicket(1)],
      overrides: { 'POST /v1/tickets/:id/status': apiError(409, 'invalid_transition') },
    });
    const { section } = await openDetails();
    await pick(user, 'Status', /^Resolved/);

    const alert = await within(section).findByRole('alert');
    expect(alert).toHaveTextContent('The change was not saved');
    expect(alert).toHaveTextContent('The ticket cannot move to that status from where it is now.');
    await waitFor(() => {
      expect(within(section).getByRole('button', { name: /^Status:\s*Open/ })).toBeVisible();
    });
  });

  it('S shows the Details tab and focuses the status', async () => {
    const user = userEvent.setup();
    editable();
    await openDetails();
    await user.click(screen.getByRole('tab', { name: 'AI' }));
    expect(screen.queryByRole('button', { name: /^Status:/ })).not.toBeInTheDocument();

    await user.keyboard('s');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Status:/ })).toHaveFocus();
    });
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
  });

  it('has Details, AI and Customer tabs, and the Customer tab shows who wrote in', async () => {
    const user = userEvent.setup();
    editable();
    await openDetails();
    const tabs = screen.getAllByRole('tab', { name: /^(Details|AI|Customer)$/ });
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Details', 'AI', 'Customer']);
    await user.click(screen.getByRole('tab', { name: 'Customer' }));
    const panel = screen.getByRole('tabpanel', { name: 'Customer' });
    expect(within(panel).getAllByText('Riley Requester').length).toBeGreaterThan(0);
    expect(within(panel).getByText('riley@example.com')).toBeVisible();
  });
});

describe('ticket details: what each person may do', () => {
  it('shows the SLA and the people of the ticket to staff', async () => {
    workspaceApi({
      tickets: [
        makeTicket(1, {
          firstResponseDueAt: '2026-11-03T03:00:00.000Z',
          resolutionDueAt: '2026-11-04T03:00:00.000Z',
        }),
      ],
    });
    const { section } = await openDetails();
    expect(within(section).getByText('Example Org')).toBeVisible();
    expect(within(section).getByText('Riley Requester')).toBeVisible();
    expect(within(section).getByText('riley@example.com')).toBeVisible();
    expect(within(section).getByText('First response due')).toBeVisible();
    // Dates are shown in Asia/Bangkok: 03:00 UTC is 10:00 there.
    expect(within(section).getByText(/Nov 3, 2026.*10:00/)).toBeVisible();
    expect(within(section).getByText(/Nov 4, 2026.*10:00/)).toBeVisible();
  });

  it('is read-only for a customer: no fields to edit, no staff-only facts', async () => {
    const api = workspaceApi({
      role: 'client',
      tickets: [
        makeClientTicket(1, {
          status: 'waiting_on_customer',
          intent: { id: uuid(700), name: 'Login issue' },
        }),
      ],
    });
    const { section } = await openDetails();

    expect(within(section).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(section).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(section).getByText('Waiting on customer')).toBeVisible();
    expect(within(section).getByText('Login issue')).toBeVisible();
    expect(within(section).queryByText('Assignee')).not.toBeInTheDocument();
    expect(within(section).queryByText('Organization')).not.toBeInTheDocument();
    expect(within(section).queryByText('First response due')).not.toBeInTheDocument();
    expect(within(section).queryByText('Tags')).not.toBeInTheDocument();
    // And the editor's reference data is never requested for them.
    expect(api.callsTo('/v1/intents')).toHaveLength(0);
    expect(api.callsTo('/v1/queues')).toHaveLength(0);
  });

  it('is read-only for staff who may read but not handle tickets', async () => {
    workspaceApi({
      tickets: [makeTicket(1, { tags: ['vip'] })],
      overrides: {
        'GET /v1/auth/session': {
          json: {
            user: {
              id: uuid(900),
              email: 'r@example.com',
              name: 'Rae Reader',
              role: 'agent',
              orgId: null,
            },
            permissions: ['ticket.read', 'auth.session.self'],
            sessionId: uuid(901),
            authMethod: 'dev',
            csrfToken: 'csrf',
            accessExpiresAt: '2026-11-02T03:15:00.000Z',
          },
        },
      },
    });
    const { section } = await openDetails();
    expect(within(section).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: /Remove tag/ })).not.toBeInTheDocument();
    expect(within(section).getByText('vip')).toBeVisible();
    // No composer either: they can neither reply nor add a note.
    expect(screen.queryByRole('form', { name: 'Write a message' })).not.toBeInTheDocument();
  });
});
