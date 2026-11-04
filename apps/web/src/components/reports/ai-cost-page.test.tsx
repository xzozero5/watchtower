import type { AiCost } from '@watchtower/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { consoleApi } from '@/test/console-api';
import { uuid } from '@/test/fixtures';
import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { AiCostPage } from './ai-cost-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/cost',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const line = (over: Partial<AiCost['totals']> = {}) => ({
  runs: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  unpricedRuns: 0,
  ...over,
});

const day = (n: number) => `2026-11-0${String(n)}`;

function cost(over: Partial<AiCost> = {}, days = 7): AiCost {
  return {
    generatedAt: '2026-11-04T10:00:00.000Z',
    window: { from: '2026-10-29T00:00:00.000Z', to: '2026-11-04T10:00:00.000Z', days },
    previous: { from: '2026-10-22T00:00:00.000Z', to: '2026-10-29T00:00:00.000Z' },
    totals: {
      ...line({
        runs: 40,
        inputTokens: 90_000,
        outputTokens: 30_000,
        costUsd: 1.5,
        unpricedRuns: 3,
      }),
      tickets: 12,
    },
    previousTotals: {
      ...line({ runs: 20, inputTokens: 40_000, outputTokens: 20_000, costUsd: 1 }),
      tickets: 6,
    },
    byAgent: [
      { agent: 'drafter', ...line({ runs: 20, costUsd: 1 }) },
      { agent: 'summarizer', ...line({ runs: 20, costUsd: 0.5 }) },
      { agent: 'newagent', ...line({ runs: 1, costUsd: 0.1 }) },
    ],
    byIntent: [
      { intent: 'billing', ...line({ runs: 10, costUsd: 0.8 }) },
      { intent: null, ...line({ runs: 10, costUsd: 0.4 }) },
    ],
    byIntentOthers: line({ runs: 5, costUsd: 0.3 }),
    topTickets: [
      {
        ticketId: uuid(1),
        key: 'OPS-12',
        number: 12,
        orgId: uuid(2),
        ...line({ runs: 4, inputTokens: 5_000, outputTokens: 1_000, costUsd: 0.4 }),
      },
    ],
    byDay: [1, 2, 3].map((n) => ({ day: day(n), ...line({ runs: n, costUsd: n / 10 }) })),
    ...over,
  };
}

function open(
  answer: (days: number) => AiCost = (days) => cost({}, days),
  role: 'head' | 'lead' | 'agent' = 'head',
) {
  const api = consoleApi({
    role,
    overrides: {
      'GET /v1/reports/ai-cost': (request) => ({
        json: answer(Number(request.url.searchParams.get('days') ?? '7')),
      }),
    },
  });
  renderConsole(<AiCostPage />);
  return api;
}

describe('AI cost page', () => {
  it('shows the totals against the period before, with words for the change', async () => {
    open();
    expect(await screen.findByRole('heading', { name: 'AI cost', level: 1 })).toBeVisible();
    const costTile = (await screen.findAllByText('Cost'))[0]?.closest(
      '[data-state]',
    ) as HTMLElement;
    expect(costTile).toHaveTextContent('$1.50');
    // $1.50 against $1.00: +50 %.
    expect(costTile).toHaveTextContent('+50% vs previous period');
    expect(costTile).toHaveTextContent('3 calls without a price');
    const tokens = screen.getAllByText('Tokens')[0]?.closest('[data-state]') as HTMLElement;
    expect(tokens).toHaveTextContent('120,000');
    expect(tokens).toHaveTextContent('90,000 in, 30,000 out');
    expect(screen.getByText('Tickets with AI').closest('[data-state]')).toHaveTextContent('12');
  });

  it('asks for 7 days and 10 rows, reloads for 30 and keeps the old page until it arrives', async () => {
    const api = open();
    await screen.findByRole('heading', { name: 'AI cost', level: 1 });
    expect(api.callsTo('/v1/reports/ai-cost')[0]?.search).toBe('?days=7&top=10');
    fireEvent.click(screen.getByRole('radio', { name: 'Last 30 days' }));
    expect(screen.queryByRole('status', { name: /Loading/ })).toBeNull();
    await waitFor(() => {
      expect(api.callsTo('/v1/reports/ai-cost').map((call) => call.search)).toContain(
        '?days=30&top=10',
      );
    });
  });

  it('names known agents, keeps an unknown one as it is, and lists intents with "No intent" and the rest', async () => {
    open();
    await screen.findByRole('heading', { name: 'Cost per agent' });
    const agents = screen.getByRole('region', { name: 'Cost per agent' });
    expect(within(agents).getByText('Reply drafter')).toBeVisible();
    expect(within(agents).getByText('Summarizer')).toBeVisible();
    expect(within(agents).getByText('newagent')).toBeVisible();
    const intents = screen.getByRole('region', { name: 'Cost per intent' });
    expect(within(intents).getByText('billing')).toBeVisible();
    expect(within(intents).getByText('No intent')).toBeVisible();
    expect(within(intents).getByText('Other intents')).toBeVisible();
  });

  it('links each costly ticket to the ticket and links the budget card instead of repeating it', async () => {
    open();
    const link = await screen.findByRole('link', { name: 'Open OPS-12' });
    expect(link).toHaveAttribute('href', '/?ticket=OPS-12');
    expect(screen.getByRole('link', { name: 'Today against the daily caps' })).toHaveAttribute(
      'href',
      '/admin/ai',
    );
    // The page shows no budget meter of its own.
    expect(screen.queryByText(/daily cap/i, { selector: 'meter,progress' })).toBeNull();
  });

  it('says so when nothing used AI, instead of an empty chart', async () => {
    open(() =>
      cost({
        totals: { ...line(), tickets: 0 },
        previousTotals: { ...line(), tickets: 0 },
        byAgent: [],
        byIntent: [],
        byIntentOthers: null,
        topTickets: [],
        byDay: [],
      }),
    );
    expect(await screen.findByText('No ticket used AI in this window')).toBeVisible();
    expect(screen.getAllByText('No AI calls in this window')).toHaveLength(2);
    // No previous period to compare to: no change chip, not "+infinity".
    expect(screen.queryByText(/vs previous period/)).toBeNull();
  });

  it('shows a retryable error when the first load fails', async () => {
    consoleApi({
      overrides: { 'GET /v1/reports/ai-cost': () => apiError(500, 'internal') },
    });
    renderConsole(<AiCostPage />);
    expect(await screen.findByText('Could not load AI cost.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('refuses an agent without asking for the report', async () => {
    const api = open(undefined, 'agent');
    expect(await screen.findByText(/don.t have access/i)).toBeVisible();
    expect(api.callsTo('/v1/reports/ai-cost')).toHaveLength(0);
  });
});
