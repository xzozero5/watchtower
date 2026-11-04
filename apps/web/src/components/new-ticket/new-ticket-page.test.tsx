import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MANUAL_CHANNELS } from '@watchtower/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeSession, makeTicket, uuid } from '@/test/fixtures';
import { type MockHandler, mockApi } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { NewTicketPage } from './new-ticket-page';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/tickets/new',
}));

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

const ORG = uuid(10);
const CONTACT = uuid(20);
const NOW = '2026-11-02T03:00:00.000Z';

function api(
  overrides: Record<string, MockHandler> = {},
  role: 'agent' | 'lead' | 'dev' = 'agent',
) {
  return mockApi({
    'GET /health': { json: { status: 'ok' } },
    'GET /v1/auth/session': { json: makeSession(role) },
    'GET /v1/orgs': {
      json: {
        items: [
          {
            id: ORG,
            name: 'Acme Demo',
            tier: 'standard',
            status: 'active',
            domains: [],
            lineGroupIds: [],
            slaPolicyId: null,
            healthScore: null,
            primaryContactId: null,
            contactCount: 1,
            notes: '',
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        nextCursor: null,
      },
    },
    'GET /v1/contacts': {
      json: {
        items: [
          {
            id: CONTACT,
            orgId: ORG,
            name: 'Casey Caller',
            emails: ['casey@customer.example'],
            lineUserId: null,
            lineLinkedVia: null,
            lineVerified: false,
            phone: null,
            verifiedAt: null,
            roleInOrg: null,
            notificationPrefs: {},
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        nextCursor: null,
      },
    },
    'GET /v1/tickets/similar': { json: { items: [] } },
    ...overrides,
  });
}

async function pickOrg(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('option', { name: 'Acme Demo' });
  await user.selectOptions(screen.getByLabelText('Organization'), ORG);
}

const created = (status: string) => ({
  json: {
    ticket: makeTicket(7, { channel: 'phone' }),
    contact: { id: CONTACT, created: false },
    confirmation: { status },
  },
  status: 201,
});

describe('the New ticket page', () => {
  it('says who can use it: not a developer', async () => {
    api({}, 'dev');
    renderConsole(<NewTicketPage />);
    expect(await screen.findByText(/needs the Agent role/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create ticket' })).not.toBeInTheDocument();
  });

  it('names a field that is missing, focuses the first one, and sends nothing', async () => {
    const user = userEvent.setup();
    const server = api();
    renderConsole(<NewTicketPage />);
    await user.click(await screen.findByRole('button', { name: 'Create ticket' }));
    expect(await screen.findAllByText('Required')).not.toHaveLength(0);
    expect(screen.getByLabelText('Organization')).toHaveFocus();
    expect(screen.getByLabelText('Organization')).toHaveAttribute('aria-invalid', 'true');
    expect(server.callsTo('/v1/tickets/manual', 'POST')).toHaveLength(0);
  });

  it('offers the four manual channels', async () => {
    api();
    renderConsole(<NewTicketPage />);
    const channel = await screen.findByLabelText('How it came in');
    const options = Array.from(channel.querySelectorAll('option')).map((o) =>
      o.getAttribute('value'),
    );
    expect(options).toEqual([...MANUAL_CHANNELS]);
  });

  it('files the ticket for an existing contact, confirmation on, and opens it', async () => {
    const user = userEvent.setup();
    const server = api({ 'POST /v1/tickets/manual': created('queued') });
    renderConsole(<NewTicketPage />);
    await pickOrg(user);
    await screen.findByRole('option', { name: /Casey Caller/ });
    await user.selectOptions(screen.getByLabelText('Choose a contact'), CONTACT);
    await user.type(screen.getByLabelText('Subject'), 'Cannot log in');
    await user.type(screen.getByLabelText('What the customer said'), 'Rejects the password');
    expect(screen.getByRole('checkbox', { name: /confirmation email/ })).toBeChecked();
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => {
      expect(server.callsTo('/v1/tickets/manual', 'POST')).toHaveLength(1);
    });
    expect(server.callsTo('/v1/tickets/manual', 'POST')[0]?.body).toEqual({
      orgId: ORG,
      channel: 'phone',
      subject: 'Cannot log in',
      body: 'Rejects the password',
      requesterContactId: CONTACT,
      sendConfirmation: true,
    });
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(expect.stringContaining('ticket=OPS-7'));
    });
  });

  it('leaves the confirmation off for a new address until the person ticks it', async () => {
    const user = userEvent.setup();
    const server = api({ 'POST /v1/tickets/manual': created('not_requested') });
    renderConsole(<NewTicketPage />);
    await pickOrg(user);
    await user.click(screen.getByRole('radio', { name: 'New contact' }));
    await user.type(screen.getByLabelText('Email'), 'not-an-address');
    await user.type(screen.getByLabelText('Name'), 'New Person');
    await user.type(screen.getByLabelText('Subject'), 'Walk-in question');
    await user.type(screen.getByLabelText('What the customer said'), 'Asked at the desk');
    const box = screen.getByRole('checkbox', { name: /confirmation email to this address/ });
    expect(box).not.toBeChecked();
    expect(screen.getByText('A new contact is not verified.')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Create ticket' }));
    expect(await screen.findByText('Enter a valid email address')).toBeVisible();
    expect(server.callsTo('/v1/tickets/manual', 'POST')).toHaveLength(0);

    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'new@customer.example');
    await user.click(box);
    await user.click(screen.getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => {
      expect(server.callsTo('/v1/tickets/manual', 'POST')).toHaveLength(1);
    });
    expect(server.callsTo('/v1/tickets/manual', 'POST')[0]?.body).toMatchObject({
      requester: { email: 'new@customer.example', name: 'New Person' },
      sendConfirmation: true,
    });
    expect(server.callsTo('/v1/tickets/manual', 'POST')[0]?.body).not.toHaveProperty(
      'requesterContactId',
    );
  });

  it('sends the priority only when the person chooses one', async () => {
    const user = userEvent.setup();
    const server = api({ 'POST /v1/tickets/manual': created('queued') });
    renderConsole(<NewTicketPage />);
    await pickOrg(user);
    await screen.findByRole('option', { name: /Casey Caller/ });
    await user.selectOptions(screen.getByLabelText('Choose a contact'), CONTACT);
    await user.type(screen.getByLabelText('Subject'), 'Site is down');
    await user.type(screen.getByLabelText('What the customer said'), 'Nothing loads');
    const priority = screen.getByLabelText('Priority');
    expect(priority).toHaveValue('');
    await user.selectOptions(priority, 'P1');
    await user.click(screen.getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => {
      expect(server.callsTo('/v1/tickets/manual', 'POST')).toHaveLength(1);
    });
    expect(server.callsTo('/v1/tickets/manual', 'POST')[0]?.body).toMatchObject({ priority: 'P1' });
  });

  it('tells an agent to ask a lead when the organization is missing, and offers no way to add one', async () => {
    api();
    renderConsole(<NewTicketPage />);
    expect(
      await screen.findByText('Not in the list? Ask a lead or head to add the organization first.'),
    ).toBeVisible();
    expect(screen.queryByRole('radio', { name: 'New organization' })).not.toBeInTheDocument();
  });

  it('lets a lead create the organization with the ticket, and keeps it if the ticket fails', async () => {
    const user = userEvent.setup();
    const NEW_ORG = uuid(11);
    let attempts = 0;
    const server = api(
      {
        'POST /v1/orgs': {
          status: 201,
          json: {
            id: NEW_ORG,
            name: 'Fresh Co',
            tier: 'standard',
            status: 'active',
            domains: [],
            lineGroupIds: [],
            slaPolicyId: null,
            healthScore: null,
            primaryContactId: null,
            contactCount: 0,
            notes: '',
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
        'POST /v1/tickets/manual': () => {
          attempts += 1;
          return attempts === 1
            ? {
                status: 500,
                json: { statusCode: 500, error: 'Error', code: 'internal', message: 'x' },
              }
            : created('not_requested');
        },
      },
      'lead',
    );
    renderConsole(<NewTicketPage />);
    await user.click(await screen.findByRole('radio', { name: 'New organization' }));
    // No contacts yet: only the new-contact fields.
    expect(screen.queryByRole('radio', { name: 'Existing contact' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create ticket' }));
    expect(await screen.findAllByText('Required')).not.toHaveLength(0);
    expect(screen.getByLabelText('Organization name')).toHaveFocus();
    expect(server.callsTo('/v1/orgs', 'POST')).toHaveLength(0);

    await user.type(screen.getByLabelText('Organization name'), 'Fresh Co');
    await user.type(screen.getByLabelText('Email'), 'who@fresh.example');
    await user.type(screen.getByLabelText('Name'), 'Fran Fresh');
    await user.type(screen.getByLabelText('Subject'), 'Onboarding call');
    await user.type(screen.getByLabelText('What the customer said'), 'Wants a demo');
    await user.click(screen.getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => {
      expect(server.callsTo('/v1/tickets/manual', 'POST')).toHaveLength(1);
    });
    expect(server.callsTo('/v1/orgs', 'POST')[0]?.body).toEqual({ name: 'Fresh Co' });
    expect(server.callsTo('/v1/tickets/manual', 'POST')[0]?.body).toMatchObject({ orgId: NEW_ORG });

    // The first try failed after the organization was made: a second try reuses it.
    await user.click(await screen.findByRole('button', { name: 'Create ticket' }));
    await waitFor(() => {
      expect(server.callsTo('/v1/tickets/manual', 'POST')).toHaveLength(2);
    });
    expect(server.callsTo('/v1/orgs', 'POST')).toHaveLength(1);
    expect(server.callsTo('/v1/tickets/manual', 'POST')[1]?.body).toMatchObject({ orgId: NEW_ORG });
  });

  it('suggests similar open tickets while the subject is typed', async () => {
    const user = userEvent.setup();
    api({
      'GET /v1/tickets/similar': {
        json: {
          items: [
            {
              id: uuid(31),
              key: 'OPS-31',
              subject: 'Cannot log in to the dashboard',
              status: 'open',
              priority: 'P3',
              createdAt: NOW,
              sameRequester: true,
              similarity: 0.8,
            },
          ],
        },
      },
    });
    renderConsole(<NewTicketPage />);
    await pickOrg(user);
    await user.type(screen.getByLabelText('Subject'), 'Cannot log in');
    const link = await screen.findByRole('link', { name: 'Open OPS-31' });
    expect(link).toHaveAttribute('href', '/?ticket=OPS-31');
    expect(screen.getByText('same requester')).toBeVisible();
  });

  it('shows why the ticket was not created', async () => {
    const user = userEvent.setup();
    api({
      'POST /v1/tickets/manual': {
        status: 409,
        json: { statusCode: 409, error: 'Conflict', code: 'conflict', message: 'conflict' },
      },
    });
    renderConsole(<NewTicketPage />);
    await pickOrg(user);
    await screen.findByRole('option', { name: /Casey Caller/ });
    await user.selectOptions(screen.getByLabelText('Choose a contact'), CONTACT);
    await user.type(screen.getByLabelText('Subject'), 'Subject');
    await user.type(screen.getByLabelText('What the customer said'), 'Text');
    await user.click(screen.getByRole('button', { name: 'Create ticket' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The ticket was not created');
    expect(push).not.toHaveBeenCalled();
  });
});
