import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OtherMailDetail, OtherMailItem } from '@watchtower/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { uuid } from '@/test/fixtures';
import { apiError, mockApi, type MockHandler } from '@/test/mock-api';
import { makeSession } from '@/test/fixtures';
import { renderConsole } from '@/test/render-console';

import { OtherMailPage } from './other-mail-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/other-mail',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const item = (n: number, overrides: Partial<OtherMailItem> = {}): OtherMailItem => ({
  id: uuid(300 + n),
  channelAccountId: uuid(400),
  channel: 'gmail',
  disposition: 'noise',
  classification: null,
  automatedSubtype: null,
  fromAddress: `sender${String(n)}@example.com`,
  fromName: `Sender ${String(n)}`,
  subject: `Subject ${String(n)}`,
  snippet: `Snippet ${String(n)}`,
  attachmentCount: 0,
  receivedAt: '2026-11-02T02:00:00.000Z',
  ...overrides,
});

const detailOf = (base: OtherMailItem, bodyText = 'The whole text.'): OtherMailDetail => ({
  ...base,
  bodyText,
});

function otherMailApi(
  items: OtherMailItem[],
  options: { role?: 'agent' | 'lead' | 'client'; overrides?: Record<string, MockHandler> } = {},
) {
  const role = options.role ?? 'agent';
  return mockApi({
    'GET /v1/auth/session': { json: makeSession(role) },
    'GET /v1/inbound/other-mail': ({ url }) => {
      const wanted = url.searchParams.get('disposition');
      return {
        json: {
          items: wanted
            ? items.filter((entry) => wanted.split(',').includes(entry.disposition))
            : items,
          nextCursor: null,
        },
      };
    },
    'GET /v1/inbound/other-mail/:id': ({ params }) => {
      const found = items.find((entry) => entry.id === params.id);
      return found ? { json: detailOf(found) } : apiError(404, 'not_found');
    },
    ...options.overrides,
  });
}

describe('Other mail', () => {
  it('lists what did not become a ticket, with sender, subject and kind', async () => {
    otherMailApi([
      item(1, { disposition: 'auto_reply', subject: 'Out of office' }),
      item(2, { disposition: 'internal', subject: 'Cron report', fromName: null }),
    ]);
    renderConsole(<OtherMailPage />);
    expect(await screen.findByRole('heading', { name: 'Other mail', level: 1 })).toBeVisible();
    const first = await screen.findByRole('button', { name: /Out of office/ });
    expect(first).toHaveTextContent('Automatic reply');
    expect(first).toHaveTextContent('Sender 1 <sender1@example.com>');
    const second = screen.getByRole('button', { name: /Cron report/ });
    expect(second).toHaveTextContent('Internal or machine');
    expect(second).toHaveTextContent('sender2@example.com');
  });

  it('filters by kind and searches, asking the api for both', async () => {
    const user = userEvent.setup();
    const api = otherMailApi([
      item(1, { disposition: 'noise', subject: 'Newsletter' }),
      item(2, { disposition: 'auto_reply', subject: 'Out of office' }),
    ]);
    renderConsole(<OtherMailPage />);
    await screen.findByRole('button', { name: /Newsletter/ });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'auto_reply');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Newsletter/ })).toBeNull();
    });
    expect(api.callsTo('/v1/inbound/other-mail').at(-1)?.search).toContain(
      'disposition=auto_reply',
    );

    await user.type(screen.getByRole('searchbox', { name: 'Search other mail' }), 'office');
    await waitFor(() => {
      expect(api.callsTo('/v1/inbound/other-mail').at(-1)?.search).toContain('q=office');
    });
  });

  it('shows the whole text and why the message is here', async () => {
    const user = userEvent.setup();
    const mail = item(1, {
      disposition: 'auto_reply',
      subject: 'Out of office',
      automatedSubtype: 'out_of_office',
      classification: { type: 'noise', confidence: 0.87, source: 'ai' },
      attachmentCount: 2,
    });
    otherMailApi([mail]);
    renderConsole(<OtherMailPage />);
    await user.click(await screen.findByRole('button', { name: /Out of office/ }));

    const detail = await screen.findByRole('article');
    expect(within(detail).getByText('The whole text.')).toBeVisible();
    expect(
      within(detail).getByText('The mail headers say it is automatic (out_of_office).'),
    ).toBeVisible();
    expect(within(detail).getByText('Classified as noise, 87% sure (AI).')).toBeVisible();
    expect(detail).toHaveTextContent('2 attachments');
  });

  it('opens a ticket from a message, says nothing is sent, and links to the ticket', async () => {
    const user = userEvent.setup();
    const mail = item(1, { subject: 'Real request' });
    const api = otherMailApi([mail], {
      overrides: {
        'POST /v1/inbound/other-mail/:id/convert': {
          json: {
            inboundMessageId: mail.id,
            ticketId: uuid(1),
            ticketKey: 'OPS-77',
            convertedFrom: 'noise',
          },
        },
      },
    });
    renderConsole(<OtherMailPage />);
    await user.click(await screen.findByRole('button', { name: /Real request/ }));
    const detail = await screen.findByRole('article');
    expect(
      within(detail).getByText(/Nothing is sent to the sender, not even an acknowledgment/),
    ).toBeVisible();

    await user.click(within(detail).getByRole('button', { name: 'This is a ticket' }));
    await waitFor(() => {
      expect(api.callsTo(`/v1/inbound/other-mail/${mail.id}/convert`, 'POST')).toHaveLength(1);
    });
    expect(await screen.findByText('Ticket OPS-77 was opened from this message.')).toBeVisible();
    // The detail is gone from the api now (404), yet the person still sees what happened.
    expect(screen.getByRole('link', { name: 'Open OPS-77' })).toHaveAttribute(
      'href',
      '/?ticket=OPS-77',
    );
  });

  it('explains a refusal in words', async () => {
    const user = userEvent.setup();
    const mail = item(1, { subject: 'Locked org' });
    otherMailApi([mail], {
      overrides: { 'POST /v1/inbound/other-mail/:id/convert': apiError(409, 'conflict') },
    });
    renderConsole(<OtherMailPage />);
    await user.click(await screen.findByRole('button', { name: /Locked org/ }));
    await user.click(await screen.findByRole('button', { name: 'This is a ticket' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This message cannot become a ticket',
    );
  });

  it('says so when nothing is waiting, and when a filter matches nothing', async () => {
    const user = userEvent.setup();
    otherMailApi([]);
    renderConsole(<OtherMailPage />);
    expect(await screen.findByText('Nothing here')).toBeVisible();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'internal');
    expect(await screen.findByText('No message matches')).toBeVisible();
  });

  it('is closed to someone without inbound.read', async () => {
    mockApi({
      'GET /v1/auth/session': { json: makeSession('client') },
      'GET /v1/inbound/other-mail': apiError(403, 'forbidden'),
    });
    renderConsole(<OtherMailPage />);
    expect(await screen.findByText('Other mail is not available to you')).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Show' })).toBeNull();
  });

  it('does not offer to open a ticket to someone who cannot create one', async () => {
    const user = userEvent.setup();
    const mail = item(1, { subject: 'Read only' });
    mockApi({
      'GET /v1/auth/session': {
        json: makeSession('agent', {
          permissions: ['inbound.read', 'ticket.read', 'auth.session.self'],
        }),
      },
      'GET /v1/inbound/other-mail': { json: { items: [mail], nextCursor: null } },
      'GET /v1/inbound/other-mail/:id': { json: detailOf(mail) },
    });
    renderConsole(<OtherMailPage />);
    await user.click(await screen.findByRole('button', { name: /Read only/ }));
    await screen.findByRole('article');
    expect(screen.queryByRole('button', { name: 'This is a ticket' })).toBeNull();
  });
});
