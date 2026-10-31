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

describe('ticket details: editing', () => {
  it('changes the status through the workflow and shows it saved', async () => {
    const user = userEvent.setup();
    const { api } = editable();
    const { section } = await openDetails();
    const status = within(section).getByRole('combobox', { name: 'Status' });
    await waitFor(() => {
      // The allowed moves arrive from the workflow endpoint.
      expect(within(status).queryByRole('option', { name: 'Resolved' })).toBeInTheDocument();
    });
    expect(within(status).queryByRole('option', { name: 'Merged' })).not.toBeInTheDocument();

    await user.selectOptions(status, 'Resolved');

    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/status', 'POST')[0]?.body).toEqual({
        status: 'resolved',
      });
    });
    expect(await within(section).findByText('Saved.')).toBeVisible();
    expect(within(section).getByRole('combobox', { name: 'Status' })).toHaveValue('resolved');
    // The header, queue row and timeline pick the change up too.
    expect(
      within(screen.getByRole('region', { name: 'Queue' })).getByText('Resolved'),
    ).toBeVisible();
  });

  it('changes the priority', async () => {
    const user = userEvent.setup();
    const { api } = editable();
    const { section } = await openDetails();
    await user.selectOptions(
      within(section).getByRole('combobox', { name: 'Priority' }),
      'P1 Critical',
    );
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1', 'PATCH')[0]?.body).toEqual({ priority: 'P1' });
    });
  });

  it('assigns to a queue member or to me, and unassigns', async () => {
    const user = userEvent.setup();
    const { api } = editable();
    const { section } = await openDetails();
    const assignee = within(section).getByRole('combobox', { name: 'Assignee' });
    await waitFor(() => {
      expect(within(assignee).queryByRole('option', { name: 'Sam Support' })).toBeInTheDocument();
    });
    // The signed-in user is always in the list and is marked.
    expect(within(assignee).getByRole('option', { name: 'Alex Agent (me)' })).toBeInTheDocument();

    await user.selectOptions(assignee, 'Sam Support');
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/assign', 'POST')[0]?.body).toEqual({
        assigneeId: uuid(901),
      });
    });
    await waitFor(() => {
      expect(within(section).getByRole('combobox', { name: 'Assignee' })).toHaveValue(uuid(901));
    });

    await user.selectOptions(
      within(section).getByRole('combobox', { name: 'Assignee' }),
      'Unassigned',
    );
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/assign', 'POST')[1]?.body).toEqual({
        assigneeId: null,
      });
    });
  });

  it('changes or clears the intent', async () => {
    const user = userEvent.setup();
    const { api } = editable();
    const { section } = await openDetails();
    const intent = within(section).getByRole('combobox', { name: 'Intent' });
    await waitFor(() => {
      expect(
        within(intent).queryByRole('option', { name: 'Billing question' }),
      ).toBeInTheDocument();
    });
    await user.selectOptions(intent, 'Billing question');
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1', 'PATCH')[0]?.body).toEqual({ intentId: uuid(701) });
    });
  });

  it('adds and removes tags', async () => {
    const user = userEvent.setup();
    const { api } = editable();
    const { section } = await openDetails();
    expect(within(section).getByText('vip')).toBeVisible();

    await user.type(within(section).getByRole('textbox', { name: 'Add a tag' }), 'billing');
    await user.click(within(section).getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1', 'PATCH')[0]?.body).toEqual({
        tags: ['vip', 'billing'],
      });
    });
    expect(await within(section).findByText('billing')).toBeVisible();

    await user.click(within(section).getByRole('button', { name: 'Remove tag vip' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1', 'PATCH')[1]?.body).toEqual({ tags: ['billing'] });
    });
  });

  it('explains a refused change and leaves the value as it was', async () => {
    const user = userEvent.setup();
    workspaceApi({
      tickets: [makeTicket(1)],
      overrides: { 'POST /v1/tickets/:id/status': apiError(409, 'invalid_transition') },
    });
    const { section } = await openDetails();
    const status = within(section).getByRole('combobox', { name: 'Status' });
    await waitFor(() => {
      expect(within(status).queryByRole('option', { name: 'Resolved' })).toBeInTheDocument();
    });
    await user.selectOptions(status, 'Resolved');

    const alert = await within(section).findByRole('alert');
    expect(alert).toHaveTextContent('The change was not saved');
    expect(alert).toHaveTextContent('The ticket cannot move to that status from where it is now.');
    expect(within(section).getByRole('combobox', { name: 'Status' })).toHaveValue('open');
  });

  it('S opens the details and focuses the status', async () => {
    const user = userEvent.setup();
    editable();
    const { section } = await openDetails();
    await user.click(within(section).getByRole('button', { name: 'Ticket details' }));
    expect(within(section).queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument();

    await user.keyboard('s');
    await waitFor(() => {
      expect(within(section).getByRole('combobox', { name: 'Status' })).toHaveFocus();
    });
  });

  it('collapses and expands, announcing the state', async () => {
    const user = userEvent.setup();
    editable();
    const { section } = await openDetails();
    const toggle = within(section).getByRole('button', { name: 'Ticket details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
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
    // A customer sees the portal's words, not the internal status (review finding P2-4).
    expect(within(section).getByText('Waiting for your reply')).toBeVisible();
    expect(within(section).queryByText('Waiting on customer')).not.toBeInTheDocument();
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
