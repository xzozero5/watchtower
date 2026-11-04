import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GoldenAnswer, Message } from '@watchtower/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { consoleApi } from '@/test/console-api';
import { uuid } from '@/test/fixtures';
import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { GoldenMarkButton } from './golden-mark';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const AT = '2026-11-02T03:00:00.000Z';

const REPLY: Message = {
  id: uuid(41),
  ticketId: uuid(40),
  ticketKey: 'OPS-7',
  channel: 'gmail',
  direction: 'outbound',
  visibility: 'public',
  sender: { type: 'user', id: uuid(900), name: 'Alex Agent' },
  bodyText: 'We reset your password.',
  deliveryStatus: 'delivered',
  attachments: [],
  createdAt: AT,
};

const GOLDEN: GoldenAnswer = {
  id: uuid(50),
  ticketId: uuid(40),
  ticketKey: 'OPS-7',
  messageId: REPLY.id,
  intent: { key: 'password_reset', name: 'Password reset' },
  text: 'We reset your password.',
  language: 'en',
  createdBy: { id: uuid(900), name: 'Alex Agent' },
  createdAt: AT,
};

function open(
  message: Message,
  options: {
    role?: 'lead' | 'agent';
    golden?: GoldenAnswer[];
    mark?: ReturnType<typeof apiError>;
  } = {},
) {
  const api = consoleApi({
    role: options.role ?? 'lead',
    overrides: {
      'GET /v1/tickets/:id/golden': { json: { items: options.golden ?? [] } },
      'POST /v1/tickets/:id/golden': options.mark ?? { status: 201, json: GOLDEN },
    },
  });
  renderConsole(<GoldenMarkButton message={message} />);
  return api;
}

describe('GoldenMarkButton', () => {
  it('marks a sent reply and says so', async () => {
    const user = userEvent.setup();
    const api = open(REPLY);
    await user.click(await screen.findByRole('button', { name: 'Mark as golden answer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Keep this reply as a golden answer' });
    const shareable = within(dialog).getByRole('checkbox', {
      name: /Shareable with other organizations/,
    });
    expect(shareable).not.toBeChecked();
    expect(within(dialog).getByText(/replaced by placeholders/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Keep as golden answer' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-7/golden', 'POST')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/tickets/OPS-7/golden', 'POST')[0]?.body).toEqual({
      messageId: REPLY.id,
      shareable: false,
    });
    expect(await screen.findByRole('button', { name: 'Golden answer' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('sends shareable: true only when the lead ticks the box', async () => {
    const user = userEvent.setup();
    const api = open(REPLY);
    await user.click(await screen.findByRole('button', { name: 'Mark as golden answer' }));
    await user.click(await screen.findByRole('checkbox', { name: /Shareable with other/ }));
    await user.click(screen.getByRole('button', { name: 'Keep as golden answer' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-7/golden', 'POST')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/tickets/OPS-7/golden', 'POST')[0]?.body).toEqual({
      messageId: REPLY.id,
      shareable: true,
    });
  });

  it('sends nothing when the lead cancels the dialog', async () => {
    const user = userEvent.setup();
    const api = open(REPLY);
    await user.click(await screen.findByRole('button', { name: 'Mark as golden answer' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.callsTo('/v1/tickets/OPS-7/golden', 'POST')).toHaveLength(0);
  });

  it('shows a reply that is already golden as marked, with no way to mark it twice', async () => {
    open(REPLY, { golden: [GOLDEN] });
    expect(await screen.findByRole('button', { name: 'Golden answer' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Mark as golden answer' })).toBeNull();
  });

  it('says why a ticket without an intent cannot keep it', async () => {
    const user = userEvent.setup();
    open(REPLY, {
      mark: apiError(
        409,
        'conflict',
        'Set the intent of the ticket before marking a reply as golden',
      ),
    });
    await user.click(await screen.findByRole('button', { name: 'Mark as golden answer' }));
    await user.click(await screen.findByRole('button', { name: 'Keep as golden answer' }));
    expect(
      await screen.findByText('Set the intent of the ticket first, then mark the reply.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Mark as golden answer' })).toBeVisible();
  });

  it('is not drawn for an agent, or for a message that was not sent to the customer', async () => {
    const agent = open(REPLY, { role: 'agent' });
    await waitFor(() => {
      expect(agent.callsTo('/v1/auth/session').length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('button', { name: /golden/i })).toBeNull();
  });

  it('is not drawn for a customer message or a reply that failed', async () => {
    const api = open({ ...REPLY, direction: 'inbound' });
    await waitFor(() => {
      expect(api.callsTo('/v1/auth/session').length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('button', { name: /golden/i })).toBeNull();
    expect(api.callsTo('/v1/tickets/OPS-7/golden')).toHaveLength(0);
  });
});
