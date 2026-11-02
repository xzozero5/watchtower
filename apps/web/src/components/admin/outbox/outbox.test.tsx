import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DeadOutboxItem, OutboxHealth } from '@watchtower/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { consoleApi } from '@/test/console-api';
import { uuid } from '@/test/fixtures';
import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { ageText, OutboxPage } from './outbox-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/outbox',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const AT = '2026-11-02T02:50:00.000Z';

function health(overrides: Partial<OutboxHealth> = {}): OutboxHealth {
  return {
    generatedAt: AT,
    pending: 3,
    dead: 2,
    oldestPendingSeconds: 150,
    status: 'warning',
    warningSeconds: 120,
    criticalSeconds: 600,
    byQueue: [{ queue: 'outbound', pending: 3, dead: 2 }],
    ...overrides,
  };
}

const CUSTOMER_ROW: DeadOutboxItem = {
  id: uuid(1),
  queue: 'outbound',
  jobName: 'dispatch',
  jobId: 'delivery-x-1',
  attempts: 30,
  lastError: 'ConnectionError: redis down',
  createdAt: AT,
  finishedAt: AT,
  replayable: true,
  notReplayableReason: null,
  effect: {
    kind: 'customer_message',
    channel: 'gmail',
    channelAccountName: 'Ops mailbox',
    origin: 'reply',
    ticketNumber: 14,
  },
};

const INGEST_ROW: DeadOutboxItem = {
  ...CUSTOMER_ROW,
  id: uuid(2),
  queue: 'ingest',
  jobName: 'process',
  effect: {
    kind: 'reprocess_inbound',
    channel: 'line',
    channelAccountName: 'LINE OA',
    origin: null,
    ticketNumber: null,
  },
};

const GONE_ROW: DeadOutboxItem = {
  ...CUSTOMER_ROW,
  id: uuid(3),
  queue: 'email',
  jobName: 'send',
  replayable: false,
  notReplayableReason: 'The payload was cleared',
  effect: null,
};

function outboxApi(rows: DeadOutboxItem[], overrides: Parameters<typeof consoleApi>[0] = {}) {
  return consoleApi({
    ...overrides,
    overrides: {
      'GET /v1/ops/outbox': { json: health() },
      'GET /v1/ops/outbox/dead': { json: { items: rows, nextCursor: null } },
      ...overrides.overrides,
    },
  });
}

describe('ageText', () => {
  it('reads seconds under a minute and two units above it', () => {
    expect(ageText(45, 'en')).toBe('45s');
    expect(ageText(150, 'en')).toBe('2m');
    expect(ageText(7_500, 'en')).toBe('2h 5m');
  });
});

describe('Outbox (head)', () => {
  it('shows how late the oldest waiting job is, in words and an icon, not colour alone', async () => {
    outboxApi([CUSTOMER_ROW]);
    renderConsole(<OutboxPage />);
    const strip = await screen.findByRole('region', { name: 'Outbox health' });
    await within(strip).findByText('2m');
    expect(within(strip).getByText('Late')).toBeVisible();
    expect(within(strip).getByText('Oldest waiting')).toBeVisible();
    expect(within(strip).getByText('Waiting')).toBeVisible();
  });

  it('says nothing waits when the queue is empty', async () => {
    outboxApi([], {
      overrides: {
        'GET /v1/ops/outbox': {
          json: health({ pending: 0, dead: 0, oldestPendingSeconds: 0, status: 'ok', byQueue: [] }),
        },
      },
    });
    renderConsole(<OutboxPage />);
    expect(await screen.findByText('Nothing is waiting')).toBeVisible();
    expect(screen.getByText('On time')).toBeVisible();
    expect(await screen.findByText('No dead rows.')).toBeVisible();
  });

  it('lists dead rows and says plainly which resend reaches a customer', async () => {
    outboxApi([CUSTOMER_ROW, INGEST_ROW, GONE_ROW]);
    renderConsole(<OutboxPage />);
    const table = await screen.findByRole('table', { name: 'Dead outbox rows' });
    const customer = within(table).getByRole('row', { name: /outbound · dispatch/ });
    expect(within(customer).getByText('Send a message to a customer')).toBeVisible();
    expect(within(customer).getByText('Ticket OPS-14 by Email (Ops mailbox)')).toBeVisible();
    const ingest = within(table).getByRole('row', { name: /ingest · process/ });
    expect(within(ingest).getByText('Process a received message again')).toBeVisible();
    expect(within(ingest).getByText(/Nothing is sent to anyone/)).toBeVisible();
    const gone = within(table).getByRole('row', { name: /email · send/ });
    expect(within(gone).getByText('Cannot be resent: The payload was cleared')).toBeVisible();
    expect(within(gone).queryByRole('button')).toBeNull();
  });

  it('asks first, names the ticket and channel, shows no message text, then resends', async () => {
    const user = userEvent.setup();
    const api = outboxApi([CUSTOMER_ROW], {
      overrides: {
        'POST /v1/ops/outbox/:id/resend': {
          json: {
            id: CUSTOMER_ROW.id,
            queue: 'outbound',
            jobId: 'delivery-x-1-resend-1',
            status: 'pending',
          },
        },
      },
    });
    renderConsole(<OutboxPage />);
    await user.click(await screen.findByRole('button', { name: 'Resend outbound · dispatch' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resend outbound · dispatch?' });
    expect(
      within(dialog).getByText(
        /This can send a message to a customer: ticket OPS-14, by Email \(Ops mailbox\)/,
      ),
    ).toBeVisible();
    expect(within(dialog).getByText(/message text is not shown here/)).toBeVisible();
    expect(api.callsTo('/v1/ops/outbox/:id/resend', 'POST')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Resend' }));
    await waitFor(() => {
      expect(
        api.calls.some((call) => call.method === 'POST' && call.path.endsWith('/resend')),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('keeps the dialog open with the api sentence when the resend is refused', async () => {
    const user = userEvent.setup();
    outboxApi([INGEST_ROW], {
      overrides: {
        'POST /v1/ops/outbox/:id/resend': apiError(
          409,
          'conflict',
          'The received event was processed already',
        ),
      },
    });
    renderConsole(<OutboxPage />);
    await user.click(await screen.findByRole('button', { name: 'Resend ingest · process' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Nothing is sent to anyone/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Resend' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The received event was processed already',
    );
  });

  it('is for the head only', async () => {
    outboxApi([], { role: 'lead' });
    renderConsole(<OutboxPage />);
    expect(await screen.findByText('You don’t have access to this page.')).toBeVisible();
  });

  it('is in Thai too', async () => {
    outboxApi([CUSTOMER_ROW]);
    renderConsole(<OutboxPage />, { locale: 'th' });
    expect(await screen.findByText('ส่งข้อความถึงลูกค้า')).toBeVisible();
    expect(screen.getByText('ticket OPS-14 ทาง อีเมล (Ops mailbox)')).toBeVisible();
  });
});
