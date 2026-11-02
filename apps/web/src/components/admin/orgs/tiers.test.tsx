import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { consoleApi } from '@/test/console-api';
import { ORG } from '@/test/console-fixtures';
import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { OrgDetailPage } from './org-detail-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/orgs',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openTiers(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText('Pilot customer.');
  await user.click(screen.getByRole('button', { name: 'Manage tiers' }));
  return screen.findByRole('dialog', { name: 'Tiers' });
}

describe('Tiers on the organization screen', () => {
  it('shows the tier by name and opens the tier list for someone who may manage SLA', async () => {
    const user = userEvent.setup();
    consoleApi();
    renderConsole(<OrgDetailPage orgId={ORG.id} />);
    const sheet = await openTiers(user);
    const list = await within(sheet).findByRole('list', { name: 'Tiers' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    // The default tier cannot be deleted.
    const standard = within(list).getByText('Standard').closest('li') as HTMLElement;
    expect(within(standard).getByText('Default')).toBeVisible();
    expect(within(standard).queryByRole('button', { name: 'Delete Standard' })).toBeNull();
  });

  it('adds a tier, and refuses a slug that is not one before asking the api', async () => {
    const user = userEvent.setup();
    const api = consoleApi({
      overrides: {
        'POST /v1/org-tiers': {
          status: 201,
          json: { slug: 'platinum', name: 'Platinum', sortOrder: 50 },
        },
      },
    });
    renderConsole(<OrgDetailPage orgId={ORG.id} />);
    const sheet = await openTiers(user);
    await within(sheet).findByRole('list', { name: 'Tiers' });
    const name = within(sheet).getByPlaceholderText('Name');
    const slug = within(sheet).getByPlaceholderText('Slug');
    await user.type(name, 'Platinum');
    await user.type(slug, 'Not A Slug');
    await user.click(within(sheet).getByRole('button', { name: 'Add tier' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      'Enter a slug such as "gold".',
    );
    expect(api.callsTo('/v1/org-tiers', 'POST')).toHaveLength(0);
    await user.clear(slug);
    await user.type(slug, 'platinum');
    await user.click(within(sheet).getByRole('button', { name: 'Add tier' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/org-tiers', 'POST')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/org-tiers', 'POST')[0]?.body).toMatchObject({
      slug: 'platinum',
      name: 'Platinum',
    });
  });

  it('renames a tier and sends only what changed', async () => {
    const user = userEvent.setup();
    const api = consoleApi({
      overrides: {
        'PATCH /v1/org-tiers/:slug': { json: { slug: 'gold', name: 'Gold plus', sortOrder: 1 } },
      },
    });
    renderConsole(<OrgDetailPage orgId={ORG.id} />);
    const sheet = await openTiers(user);
    await user.click(await within(sheet).findByRole('button', { name: 'Edit Gold' }));
    const name = within(sheet).getAllByLabelText('Name')[0] as HTMLElement;
    await user.clear(name);
    await user.type(name, 'Gold plus');
    await user.click(within(sheet).getByRole('button', { name: 'Save Gold' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/org-tiers/gold', 'PATCH')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/org-tiers/gold', 'PATCH')[0]?.body).toEqual({
      name: 'Gold plus',
      sortOrder: 1,
    });
  });

  it('shows the api sentence when a tier in use cannot be deleted', async () => {
    const user = userEvent.setup();
    consoleApi({
      overrides: {
        'DELETE /v1/org-tiers/:slug': apiError(
          409,
          'conflict',
          'The tier is still named by 2 organizations',
        ),
      },
    });
    renderConsole(<OrgDetailPage orgId={ORG.id} />);
    const sheet = await openTiers(user);
    await user.click(await within(sheet).findByRole('button', { name: 'Delete Silver' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete the tier Silver?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(
      'The tier is still named by 2 organizations',
    );
  });

  it('is not offered to a lead, who may manage organizations but not tiers', async () => {
    consoleApi({ role: 'lead' });
    renderConsole(<OrgDetailPage orgId={ORG.id} />);
    await screen.findByText('Pilot customer.');
    expect(screen.queryByRole('button', { name: 'Manage tiers' })).toBeNull();
  });
});
