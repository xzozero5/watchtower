import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { consoleApi } from '@/test/console-api';
import { CONTACT, ORG } from '@/test/console-fixtures';
import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { OrgDetailPage } from './org-detail-page';
import { OrgsPage } from './orgs-page';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/orgs',
}));

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

describe('Organizations', () => {
  it('lists organizations with tier, status, first domain and SLA policy', async () => {
    consoleApi();
    renderConsole(<OrgsPage />);
    const table = await screen.findByRole('table', { name: 'Organizations' });
    const row = within(table).getAllByRole('row')[1] as HTMLElement;
    expect(within(row).getByRole('link', { name: 'Acme Logistics' })).toHaveAttribute(
      'href',
      `/admin/orgs/${ORG.id}`,
    );
    expect(within(row).getByText('gold')).toBeVisible();
    expect(within(row).getByText('Active')).toBeVisible();
    expect(within(row).getByText('acme.example.com')).toBeVisible();
    expect(within(row).getByText('+1')).toBeVisible();
    expect(within(row).getByText('Gold')).toBeVisible();
  });

  it('shows how many contacts each organization has', async () => {
    consoleApi();
    renderConsole(<OrgsPage />);
    const table = await screen.findByRole('table', { name: 'Organizations' });
    expect(
      within(within(table).getAllByRole('row')[1] as HTMLElement).getByText('1'),
    ).toBeVisible();
  });

  it('offers the tiers the server lists, by name', async () => {
    const user = userEvent.setup();
    consoleApi();
    renderConsole(<OrgsPage />);
    await screen.findByRole('table', { name: 'Organizations' });
    await user.click(screen.getByRole('button', { name: 'New organization' }));
    const sheet = await screen.findByRole('dialog', { name: 'New organization' });
    await waitFor(() => {
      expect(within(within(sheet).getByLabelText('Tier')).getAllByRole('option')).toHaveLength(3);
    });
    expect(
      within(within(sheet).getByLabelText('Tier')).getByRole('option', { name: 'Gold' }),
    ).toBeInTheDocument();
  });

  it('searches on the server', async () => {
    const user = userEvent.setup();
    const api = consoleApi();
    renderConsole(<OrgsPage />);
    await screen.findByRole('table', { name: 'Organizations' });
    await user.type(screen.getByRole('searchbox', { name: 'Filter' }), 'acme');
    await waitFor(() => {
      expect(api.callsTo('/v1/orgs', 'GET').at(-1)?.search).toContain('q=acme');
    });
  });

  it('creates an organization with a domain, and refuses a public mailbox provider on the spot', async () => {
    const user = userEvent.setup();
    const api = consoleApi({ overrides: { 'POST /v1/orgs': { status: 201, json: ORG } } });
    renderConsole(<OrgsPage />);
    await screen.findByRole('table', { name: 'Organizations' });
    await user.click(screen.getByRole('button', { name: 'New organization' }));
    const sheet = await screen.findByRole('dialog', { name: 'New organization' });
    await user.type(within(sheet).getByLabelText('Domains'), 'gmail.com');
    await user.click(within(sheet).getByRole('button', { name: 'Add' }));
    expect(
      within(sheet).getByText('a public mailbox provider cannot be an organization domain'),
    ).toBeVisible();
    await user.clear(within(sheet).getByLabelText('Domains'));
    await user.type(within(sheet).getByLabelText('Domains'), 'northwind.example.com');
    await user.click(within(sheet).getByRole('button', { name: 'Add' }));
    expect(within(sheet).getByText('northwind.example.com')).toBeVisible();
    // The name is required.
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(within(sheet).getByText('Required.')).toBeVisible();
    await user.type(within(sheet).getByLabelText('Name'), 'Northwind Trading');
    await user.selectOptions(within(sheet).getByLabelText('Tier'), 'silver');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/orgs', 'POST')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/orgs', 'POST')[0]?.body).toMatchObject({
      name: 'Northwind Trading',
      tier: 'silver',
      domains: ['northwind.example.com'],
    });
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(`/admin/orgs/${ORG.id}`);
    });
  });

  it('says so when there are none, with the action next to it', async () => {
    consoleApi({ overrides: { 'GET /v1/orgs': { json: { items: [], nextCursor: null } } } });
    renderConsole(<OrgsPage />);
    expect(await screen.findByText('No organizations yet.')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'New organization' }).length).toBeGreaterThan(0);
  });

  it('is open to a lead and closed to an agent', async () => {
    consoleApi({ role: 'lead' });
    const { unmount } = renderConsole(<OrgsPage />);
    expect(await screen.findByRole('table', { name: 'Organizations' })).toBeVisible();
    unmount();
    consoleApi({ role: 'agent' });
    renderConsole(<OrgsPage />);
    expect(await screen.findByText('You don’t have access to this page.')).toBeVisible();
  });
});

describe('Organization', () => {
  it('shows details, contacts and a way to the queue', async () => {
    const user = userEvent.setup();
    consoleApi();
    renderConsole(<OrgDetailPage orgId={ORG.id} />);
    expect(await screen.findByText('Pilot customer.')).toBeVisible();
    expect(screen.getByText('acme.example.com, acme-logistics.example.com')).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Contacts' }));
    const row = await screen.findByRole('row', { name: 'Riley Requester' });
    expect(within(row).getByText('riley@acme.example.com')).toBeVisible();
    expect(within(row).getByText('Linked')).toBeVisible();
    expect(within(row).getByText('Verified')).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Tickets' }));
    expect(screen.getByRole('link', { name: 'Open the queue' })).toBeVisible();
  });

  it('adds a contact with one to ten valid addresses', async () => {
    const user = userEvent.setup();
    const api = consoleApi({ overrides: { 'POST /v1/contacts': { status: 201, json: CONTACT } } });
    renderConsole(<OrgDetailPage orgId={ORG.id} />);
    await user.click(await screen.findByRole('tab', { name: 'Contacts' }));
    await user.click(screen.getByRole('button', { name: 'New contact' }));
    const sheet = await screen.findByRole('dialog', { name: 'New contact' });
    await user.type(within(sheet).getByLabelText('Name'), 'Sam Support');
    await user.type(
      within(sheet).getByLabelText('Email addresses (one per line)'),
      'not-an-address',
    );
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(within(sheet).getByText('Enter 1 to 10 valid email addresses.')).toBeVisible();
    await user.clear(within(sheet).getByLabelText('Email addresses (one per line)'));
    await user.type(
      within(sheet).getByLabelText('Email addresses (one per line)'),
      'sam@acme.example.com',
    );
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/contacts', 'POST')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/contacts', 'POST')[0]?.body).toEqual({
      orgId: ORG.id,
      name: 'Sam Support',
      emails: ['sam@acme.example.com'],
    });
  });

  it('shows the api’s refusal to delete an organization that still has tickets', async () => {
    const user = userEvent.setup();
    consoleApi({
      overrides: {
        [`DELETE /v1/orgs/${ORG.id}`]: apiError(
          409,
          'conflict',
          'The organization still has tickets',
        ),
      },
    });
    renderConsole(<OrgDetailPage orgId={ORG.id} />);
    await screen.findByText('Pilot customer.');
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Acme Logistics?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete…' }));
    expect(await within(dialog).findByText('The organization still has tickets')).toBeVisible();
  });

  it('says an unknown organization is not found', async () => {
    consoleApi({ overrides: { 'GET /v1/orgs/:id': apiError(404, 'not_found') } });
    renderConsole(<OrgDetailPage orgId={ORG.id} />);
    expect(await screen.findByText('Organization not found.')).toBeVisible();
  });
});
