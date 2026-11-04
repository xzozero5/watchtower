import type { CeoView } from '@watchtower/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { consoleApi } from '@/test/console-api';
import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { CeoPage } from './ceo-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/ceo',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const ok = (value: number, previous: number | null, samples = 10) => ({
  status: 'ok' as const,
  data: { value, previous, samples },
});

function view(over: Partial<CeoView> = {}, days = 7): CeoView {
  return {
    generatedAt: '2026-11-04T10:00:00.000Z',
    window: { from: '2026-10-29T00:00:00.000Z', to: '2026-11-04T10:00:00.000Z', days },
    previous: { from: '2026-10-22T00:00:00.000Z', to: '2026-10-29T00:00:00.000Z' },
    seedExcluded: true,
    kpis: {
      volume: ok(120, 100, 120),
      firstResponse: ok(1_800, 3_600),
      resolution: ok(7_200, null),
      sla: ok(0.9, 0.95),
      csat: ok(4.5, 4.4, 30),
      aiHandled: ok(0.4, null, 50),
      verifiedResolution: { status: 'not_available', reason: 'needs_grader' },
      automationSavings: ok(3.3, 2),
    },
    formula: {
      assumed: true,
      minutesPerTicket: 10,
      staffCostUsdPerHour: null,
      aiHandledTickets: 20,
      noTouchTickets: 8,
      hours: 3.3,
      savedUsd: null,
      aiCostUsd: 2.5,
      netUsd: null,
      aiCostPerResolvedTicketUsd: 0.05,
      previousAiCostPerResolvedTicketUsd: null,
    },
    externalTiles: [
      {
        key: 'uptime',
        label: 'Platform uptime',
        unit: '%',
        higherIsBetter: true,
        value: 99.9,
        previous: 99,
        observedAt: '2026-11-01T00:00:00.000Z',
      },
    ],
    ...over,
  };
}

function open(
  answer: (days: number) => CeoView = (days) => view({}, days),
  role: 'head' | 'lead' | 'agent' = 'head',
  extra: Parameters<typeof consoleApi>[0] extends infer O
    ? O extends { overrides?: infer R }
      ? R
      : never
    : never = {},
) {
  const api = consoleApi({
    role,
    overrides: {
      'GET /v1/reports/ceo': (request) => ({
        json: answer(Number(request.url.searchParams.get('days') ?? '7')),
      }),
      ...extra,
    },
  });
  renderConsole(<CeoPage />);
  return api;
}

const tile = (label: string | RegExp) =>
  screen.getByText(label).closest('[data-state]') as HTMLElement;

describe('CEO view: the figures', () => {
  it('shows each figure next to the period before it, in words', async () => {
    open();
    await screen.findByText('Ticket volume');
    expect(tile('Ticket volume')).toHaveTextContent('120');
    expect(tile('Ticket volume')).toHaveTextContent('+20% vs previous period');
    // 30 minutes against an hour: shorter is the good direction.
    expect(tile('First response (median)')).toHaveTextContent('30m');
    expect(tile('First response (median)')).toHaveTextContent('−50% vs previous period');
    expect(tile('SLA compliance')).toHaveTextContent('90%');
    expect(tile('SLA compliance')).toHaveTextContent('−5 pts vs previous period');
    expect(tile('CSAT')).toHaveTextContent('4.5');
    expect(tile('AI-assisted')).toHaveTextContent('40%');
    expect(tile('AI-assisted')).toHaveTextContent('20 tickets, 8 unchanged');
  });

  it('shows a reason and no number for a figure with nothing behind it, and no chip without a base', async () => {
    open();
    await screen.findByText('Ticket volume');
    const verified = tile('Verified resolutions');
    expect(verified).toHaveAttribute('data-state', 'unavailable');
    expect(verified).toHaveTextContent('Waits for the AI grader');
    expect(verified).not.toHaveTextContent(/\d%/);
    // Resolution time had no previous period: the value shows, the chip does not.
    expect(tile('Resolution time (median)')).toHaveTextContent('2h');
    expect(tile('Resolution time (median)')).not.toHaveTextContent('vs previous period');
  });

  it('prints the savings formula as an assumption, with hours only while no hourly cost is set', async () => {
    open();
    const formula = await screen.findByRole('heading', {
      name: 'How automation savings are worked out',
    });
    const box = formula.closest('section') as HTMLElement;
    expect(box).toHaveTextContent('This is an assumption, not a measurement.');
    expect(box).toHaveTextContent(
      'Hours = AI-assisted resolved tickets (20) × 10 minutes ÷ 60 = 3.3 h.',
    );
    expect(box).toHaveTextContent('No hourly cost is set, so no money figure is shown.');
    expect(box).toHaveTextContent('$0.050');
    expect(box).toHaveTextContent('previous period: none');
    expect(box).not.toHaveTextContent('Saved cost');
  });

  it('prints the saved cost and the net when an hourly cost is set', async () => {
    open(() =>
      view({
        formula: {
          ...view().formula,
          staffCostUsdPerHour: 20,
          savedUsd: 66,
          netUsd: 63.5,
        },
      }),
    );
    const formula = await screen.findByRole('heading', {
      name: 'How automation savings are worked out',
    });
    const box = formula.closest('section') as HTMLElement;
    expect(box).toHaveTextContent('Saved cost = hours × $20.00 per hour = $66.00.');
    expect(box).toHaveTextContent('AI spend in the window: $2.50. Net: $63.50.');
  });

  it('says demo tickets are left out when they are', async () => {
    open();
    expect(await screen.findByText('Demo (seed) tickets are not counted.')).toBeVisible();
  });

  it('asks for 7 days first and reloads for 30 without dropping the page', async () => {
    const api = open();
    await screen.findByRole('heading', { name: 'CEO view', level: 1 });
    expect(api.callsTo('/v1/reports/ceo')[0]?.search).toBe('?days=7');
    fireEvent.click(screen.getByRole('radio', { name: 'Last 30 days' }));
    expect(screen.queryByRole('status', { name: /Loading/ })).toBeNull();
    await waitFor(() => {
      expect(api.callsTo('/v1/reports/ceo').map((call) => call.search)).toContain('?days=30');
    });
  });

  it('shows a retryable error when the first load fails', async () => {
    consoleApi({ overrides: { 'GET /v1/reports/ceo': () => apiError(500, 'internal') } });
    renderConsole(<CeoPage />);
    expect(await screen.findByText('Could not load the CEO view.')).toBeVisible();
  });

  it('refuses an agent without asking for the report', async () => {
    const api = open(undefined, 'agent');
    expect(await screen.findByText(/don.t have access/i)).toBeVisible();
    expect(api.callsTo('/v1/reports/ceo')).toHaveLength(0);
  });
});

describe('CEO view: tiles fed from outside', () => {
  it('shows a tile with its change, direction-aware, and when it was observed', async () => {
    open();
    const uptime = await screen.findByText('Platform uptime');
    const box = uptime.closest('[data-state]') as HTMLElement;
    expect(box).toHaveTextContent('99.9 %');
    expect(box).toHaveTextContent('vs previous period');
    expect(box).toHaveTextContent('as of');
  });

  it('says there are none yet instead of leaving the section blank', async () => {
    open(() => view({ externalTiles: [] }));
    const section = (await screen.findByRole('heading', { name: 'Other figures' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(section).getByText('Not collected yet')).toBeVisible();
  });

  it('lets a head import a CSV and refreshes the view; shows the api sentence when it is refused', async () => {
    let imported = 0;
    const api = open(undefined, 'head', {
      'POST /v1/reports/ceo/points/import': (request) => {
        const csv = (request.body as { csv: string }).csv;
        if (csv.includes('bad')) {
          return apiError(400, 'validation_failed', 'line 2: value is not a number');
        }
        imported += 1;
        return { status: 201, json: { imported: 2 } };
      },
    });
    await screen.findByText('Platform uptime');
    const field = screen.getByLabelText('CSV');
    fireEvent.change(field, { target: { value: 'key,label\nbad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(
      await screen.findByText('Could not import: line 2: value is not a number'),
    ).toBeVisible();

    fireEvent.change(field, {
      target: { value: 'key,label,unit,higher_is_better,value,observed_at' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('Imported 2 values.')).toBeVisible();
    expect(imported).toBe(1);
    await waitFor(() => {
      expect(api.callsTo('/v1/reports/ceo', 'GET').length).toBeGreaterThan(1);
    });
  });

  it('asks before removing a tile, then removes it', async () => {
    const api = open(undefined, 'head', {
      'DELETE /v1/reports/ceo/metrics/:key': { status: 204 },
    });
    await screen.findByText('Platform uptime');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Platform uptime' }));
    expect(await screen.findByText('Remove “Platform uptime”?')).toBeVisible();
    expect(api.callsTo('/v1/reports/ceo/metrics/uptime', 'DELETE')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/reports/ceo/metrics/uptime', 'DELETE')).toHaveLength(1);
    });
  });

  it('shows a lead the tiles but neither the import panel nor the remove button', async () => {
    open(undefined, 'lead');
    await screen.findByText('Platform uptime');
    expect(screen.queryByLabelText('CSV')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
  });
});

describe('CEO view: export', () => {
  it('downloads the CSV and the HTML for the chosen window, through the authenticated client', async () => {
    const created: string[] = [];
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: (blob: Blob) => {
          created.push(blob.type);
          return 'blob:test';
        },
        revokeObjectURL: () => undefined,
      }),
    );
    const api = open(undefined, 'lead', {
      'GET /v1/reports/ceo/export': () => ({ json: {} }),
    });
    await screen.findByText('Ticket volume');
    fireEvent.click(screen.getByRole('radio', { name: 'Last 30 days' }));
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Last 30 days' })).toBeChecked();
    });
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    fireEvent.click(screen.getByRole('button', { name: /Export HTML/ }));
    await waitFor(() => {
      expect(api.callsTo('/v1/reports/ceo/export').map((call) => call.search)).toEqual([
        '?days=30&format=csv',
        '?days=30&format=html',
      ]);
    });
    await waitFor(() => {
      expect(created).toEqual(['text/csv', 'text/html']);
    });
  });

  it('says so when the export fails', async () => {
    open(undefined, 'lead', {
      'GET /v1/reports/ceo/export': () => apiError(403, 'forbidden'),
    });
    await screen.findByText('Ticket volume');
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    expect(await screen.findByText('Could not export. Try again.')).toBeVisible();
  });
});
