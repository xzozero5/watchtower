import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeMessage, makeSession, makeTicket, uuid } from '@/test/fixtures';
import { type MockHandler, mockApi } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { DevHome } from './dev-home';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const waiting = makeTicket(11, {
  status: 'waiting_on_dev',
  subject: 'Login fails for [EMAIL_1]',
  requester: { id: uuid(600), name: 'R*** R***', email: 'r***@customer.example' },
  devOwner: null,
});
const mine = makeTicket(12, {
  status: 'open',
  subject: 'Mine to fix',
  devOwner: { id: uuid(900), name: 'Alex Agent' },
});

function api(overrides: Record<string, MockHandler> = {}) {
  return mockApi({
    'GET /health': { json: { status: 'ok' } },
    'GET /v1/auth/session': { json: makeSession('dev') },
    'GET /v1/tickets': (request) => {
      const owner = request.url.searchParams.get('devOwner');
      return { json: { items: owner === 'me' ? [mine] : [waiting], nextCursor: null } };
    },
    'GET /v1/tickets/:id': (request) => ({
      json: request.params.id === mine.key ? mine : waiting,
    }),
    'GET /v1/tickets/:id/timeline': {
      json: {
        entries: [makeMessage(1, waiting, { bodyText: 'Call [PHONE_1] about [EMAIL_1]' })],
        nextCursor: null,
      },
    },
    'GET /v1/tickets/:id/ai': {
      status: 404,
      json: { statusCode: 404, error: 'Not Found', code: 'not_found', message: 'none' },
    },
    ...overrides,
  });
}

describe('the developer home', () => {
  it('lists what waits on dev, then what this person picked up', async () => {
    const user = userEvent.setup();
    const server = api();
    renderConsole(<DevHome />);
    expect(
      await screen.findByRole('button', { name: /Login fails for \[EMAIL_1\]/ }),
    ).toBeVisible();
    expect(server.calls.find((call) => call.path === '/v1/tickets')?.search).toContain(
      'status=waiting_on_dev',
    );
    expect(screen.getByText('Personal data is masked on this page.')).toBeVisible();

    await user.click(screen.getByRole('radio', { name: 'Mine' }));
    expect(await screen.findByRole('button', { name: /Mine to fix/ })).toBeVisible();
    const mineCall = server.calls.filter((call) => call.path === '/v1/tickets').at(-1);
    expect(mineCall?.search).toContain('devOwner=me');
  });

  it('shows the masked ticket and conversation, has no reply box, and picks the ticket up', async () => {
    const user = userEvent.setup();
    const server = api({
      'POST /v1/tickets/:id/dev-owner': {
        json: { ...waiting, devOwner: { id: uuid(900), name: 'Alex Agent' } },
      },
    });
    renderConsole(<DevHome />);
    await user.click(await screen.findByRole('button', { name: /Login fails for/ }));
    expect(await screen.findByText('Call [PHONE_1] about [EMAIL_1]')).toBeVisible();
    expect(screen.getByText(/r\*\*\*@customer\.example/)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: /reply/i })).not.toBeInTheDocument();
    expect(screen.getByText('No AI brief yet.')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Pick up' }));
    await waitFor(() => {
      expect(server.callsTo(`/v1/tickets/${waiting.key}/dev-owner`, 'POST')).toHaveLength(1);
    });
  });

  it('hands a ticket back only with a note', async () => {
    const user = userEvent.setup();
    const server = api({
      'POST /v1/tickets/:id/status': { json: { ...waiting, status: 'open' } },
    });
    renderConsole(<DevHome />);
    await user.click(await screen.findByRole('button', { name: /Login fails for/ }));
    await user.click(await screen.findByRole('button', { name: 'Hand back to support' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Write a note first');
    expect(server.callsTo(`/v1/tickets/${waiting.key}/status`, 'POST')).toHaveLength(0);

    await user.type(screen.getByLabelText('Note (required)'), 'Fixed in the next release');
    await user.click(screen.getByRole('button', { name: 'Hand back to support' }));
    await waitFor(() => {
      expect(server.callsTo(`/v1/tickets/${waiting.key}/status`, 'POST')).toHaveLength(1);
    });
    expect(server.callsTo(`/v1/tickets/${waiting.key}/status`, 'POST')[0]?.body).toEqual({
      status: 'open',
      reason: 'Fixed in the next release',
    });
  });

  it('writes an internal note', async () => {
    const user = userEvent.setup();
    const server = api({
      'POST /v1/tickets/:id/notes': {
        status: 201,
        json: {
          message: makeMessage(2, waiting, { visibility: 'internal', direction: 'internal' }),
          ticket: waiting,
        },
      },
    });
    renderConsole(<DevHome />);
    await user.click(await screen.findByRole('button', { name: /Login fails for/ }));
    await user.type(await screen.findByLabelText('Internal note'), 'Checked the gateway logs');
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => {
      expect(server.callsTo(`/v1/tickets/${waiting.key}/notes`, 'POST')).toHaveLength(1);
    });
    expect(server.callsTo(`/v1/tickets/${waiting.key}/notes`, 'POST')[0]?.body).toEqual({
      body: 'Checked the gateway logs',
    });
  });
});
