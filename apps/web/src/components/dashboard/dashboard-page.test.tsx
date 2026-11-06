import type { AssistantElement, DashboardOps } from '@watchtower/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import userEvent from '@testing-library/user-event';
import { makeSession } from '@/test/fixtures';
import { consoleApi } from '@/test/console-api';
import { agentDashboardOps, byDay, dashboardOps, INCIDENT_OPEN } from '@/test/dashboard-fixtures';
import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { DashboardPage } from './dashboard-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

type Role = NonNullable<Parameters<typeof consoleApi>[0]>['role'];

/** The page with the api answering `GET /v1/dashboard/ops` from `answer(days)`. */
function open(
  answer: (days: number) => DashboardOps = (days) => dashboardOps({}, days),
  role: Role = 'head',
  options: Parameters<typeof renderConsole>[1] = {},
) {
  const api = consoleApi({
    role,
    overrides: {
      'GET /v1/dashboard/ops': (request) => ({
        json: answer(Number(request.url.searchParams.get('days') ?? '7')),
      }),
    },
  });
  renderConsole(<DashboardPage />, options);
  return api;
}

/** The page opened as `role`, returning the render handle so a test can open it again as someone else. */
function renderOpen(role: Role) {
  consoleApi({
    role,
    overrides: { 'GET /v1/dashboard/ops': () => ({ json: dashboardOps({}, 7) }) },
  });
  return renderConsole(<DashboardPage />);
}

const section = (name: string) => screen.getByRole('region', { name });
const tile = (scope: HTMLElement, label: string | RegExp) =>
  within(scope).getByText(label).closest('[data-state]') as HTMLElement;

describe('Ops dashboard: structure', () => {
  it('shows the grades element to registry-permitted staff without fetching metric.read data', async () => {
    const api = consoleApi({
      role: 'head',
      overrides: {
        'GET /v1/auth/session': {
          json: makeSession('head', {
            permissions: ['assistant.use', 'dashboard.ops.read', 'ai.run.read'],
          }),
        },
        'GET /v1/dashboard/ops': { json: dashboardOps({}, 7) },
        'GET /v1/assistant/starters': {
          json: {
            state: 'ok',
            reason: null,
            starters: [],
            limits: { messagesPerHour: 30, remainingThisHour: 30 },
          },
        },
      },
    });
    renderConsole(<DashboardPage />);
    const button = await screen.findByRole('button', { name: 'Ask AI about Grades' });
    await waitFor(() => {
      expect(button).not.toHaveAttribute('aria-disabled');
    });
    expect(api.callsTo('/v1/ai/grades/metrics')).toHaveLength(0);
    const listener = vi.fn();
    window.addEventListener('wt:assistant-open', listener);
    await userEvent.click(button);
    expect(
      (listener.mock.calls[0]?.[0] as CustomEvent<{ element: AssistantElement }>).detail.element,
    ).toEqual({
      key: 'dashboard.ops.grades',
      scope: 'instance',
      period: 'd7',
    });
    window.removeEventListener('wt:assistant-open', listener);
  });

  it('lists the sections in the order of the spec, with the window control above them', async () => {
    open();
    await screen.findByRole('region', { name: 'Now' });
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      'Now',
      'Volume',
      'SLA',
      'Quality',
      'Reliability',
      'AI',
      'Verified or assumed, by intent',
      'Team',
      'Product usage',
      'Service status',
    ]);
    const windowControl = screen.getByRole('radiogroup', { name: 'Time window' });
    expect(
      windowControl.compareDocumentPosition(section('Now')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('asks for 7 days first and reloads for 30 and 90, keeping the old figures until they arrive', async () => {
    const api = open();
    await screen.findByRole('region', { name: 'Now' });
    expect(api.callsTo('/v1/dashboard/ops')[0]?.search).toBe('?days=7');
    expect(screen.getByRole('radio', { name: 'Last 7 days' })).toBeChecked();

    fireEvent.click(screen.getByRole('radio', { name: 'Last 30 days' }));
    // No skeleton, no blank: the page stays and is only dimmed while the new window loads.
    expect(screen.queryByRole('status', { name: /Loading/ })).toBeNull();
    expect(screen.getByRole('region', { name: 'Now' })).toBeVisible();
    await waitFor(() => {
      expect(api.callsTo('/v1/dashboard/ops').map((call) => call.search)).toContain('?days=30');
    });
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Last 30 days' })).toBeChecked();
    });

    fireEvent.click(screen.getByRole('radio', { name: 'Last 90 days' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/dashboard/ops').map((call) => call.search)).toContain('?days=90');
    });
  });

  it('refetches at the api cache cadence (30 s) without a loading state', async () => {
    const { DASHBOARD_POLL_MS } = await import('@/lib/dashboard/queries');
    expect(DASHBOARD_POLL_MS).toBe(30_000);
  });
});

describe('Ops dashboard: Now, Volume, SLA', () => {
  it('shows the queue figures, with breached drawn as an alert in words and an icon', async () => {
    open();
    const now = await screen.findByRole('region', { name: 'Now' });
    expect(tile(now, 'Open')).toHaveTextContent('23');
    expect(tile(now, 'Unassigned')).toHaveTextContent('4');
    const breached = tile(now, 'Breached now');
    expect(breached).toHaveTextContent('2');
    expect(within(breached).getByText('2')).toHaveClass('text-danger');
    expect(tile(now, 'At risk now')).toHaveTextContent('5');
    // Aging buckets: all four, every one with its value at the tip.
    const aging = within(now).getByRole('figure', { name: 'Open by age' });
    const rows = within(aging).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Under 4 h9',
      '4 to 24 h8',
      '1 to 3 days4',
      'Over 3 days2',
    ]);
  });

  it('shows 0 for a real zero, not a reason', async () => {
    open((days) =>
      dashboardOps(
        {
          queue: {
            ...dashboardOps().queue,
            open: 0,
            unassigned: 0,
            breachedNow: 0,
            atRiskNow: 0,
            paused: 0,
            aging: { lt_4h: 0, h4_24: 0, d1_3: 0, gt_3d: 0 },
          },
        },
        days,
      ),
    );
    const now = await screen.findByRole('region', { name: 'Now' });
    for (const label of ['Open', 'Unassigned', 'Breached now', 'At risk now', 'SLA paused']) {
      const figure = tile(now, label);
      expect(figure).toHaveAttribute('data-state', 'ok');
      expect(figure).toHaveTextContent('0');
      expect(within(figure).getByText('0')).not.toHaveClass('text-danger');
    }
  });

  it('shows the volume per day as a chart with a table twin, and the channels with their counts', async () => {
    open();
    const volume = await screen.findByRole('region', { name: 'Volume' });
    const figure = within(volume).getByRole('figure', { name: 'Created per day' });
    expect(within(figure).getByRole('group', { name: 'Created per day' })).toBeVisible();
    fireEvent.click(within(figure).getByRole('button', { name: 'Show as a table' }));
    expect(within(figure).getAllByRole('row')).toHaveLength(8);
    expect(within(figure).getByRole('columnheader', { name: 'Day (UTC)' })).toBeVisible();
    // The channels are named in the language of the app, with their counts.
    expect(within(volume).getByText('Email')).toBeVisible();
    expect(within(volume).getByText('22')).toBeVisible();
  });

  it('draws 90 days without a horizontal scroll container of its own', async () => {
    open((days) =>
      dashboardOps(
        {
          volume: {
            created: 90,
            byChannel: {},
            byDay: byDay(90),
            previous: {
              from: '2026-05-05T00:00:00.000Z',
              to: '2026-08-03T00:00:00.000Z',
              created: 0,
            },
          },
        },
        days,
      ),
    );
    const volume = await screen.findByRole('region', { name: 'Volume' });
    expect(within(volume).getByText('No tickets in this window.')).toBeVisible();
    const figure = within(volume).getByRole('figure', { name: 'Created per day' });
    expect(figure.querySelectorAll('rect[data-slot]')).toHaveLength(90);
  });

  it('says the SLA is wall clock and an assumption, behind a button a keyboard can reach', async () => {
    open();
    const sla = await screen.findByRole('region', { name: 'SLA' });
    const first = tile(sla, 'First response');
    expect(first).toHaveTextContent('9m');
    expect(first).toHaveTextContent('p90 1h 30m');
    fireEvent.click(within(first).getByRole('button', { name: 'About how this is measured' }));
    expect(await screen.findByText(/Wall clock: nights and weekends count/)).toBeVisible();
    expect(screen.getByText(/This is an assumption, not confirmed\./)).toBeVisible();
    // A late rate that is really 0 reads 0%, with its count.
    const late = tile(sla, 'Resolution late');
    expect(late).toHaveTextContent('0%');
    expect(late).toHaveTextContent('0 of 30');
  });

  it('puts the at-risk rule and the change-failure rule on the figure', async () => {
    open();
    const now = await screen.findByRole('region', { name: 'Now' });
    fireEvent.click(
      within(tile(now, 'At risk now')).getByRole('button', { name: 'About at risk' }),
    );
    expect(await screen.findByText(/within 60 minutes/)).toBeVisible();
    expect(screen.getByText(/assumption/)).toBeVisible();
  });
});

describe('Ops dashboard: a figure that is missing says why (N5)', () => {
  it('gives each reason its own short copy and never a number', async () => {
    open((days) =>
      dashboardOps(
        {
          quality: {
            ...dashboardOps().quality,
            escalation: { status: 'not_available', reason: 'not_implemented' },
            reopen: { status: 'not_available', reason: 'no_data' },
            toDev: { status: 'not_available', reason: 'not_collected' },
          },
        },
        days,
      ),
    );
    const quality = await screen.findByRole('region', { name: 'Quality' });
    const cases: [string, string][] = [
      ['Escalated', 'Not built yet'],
      ['Reopened', 'No data in this window'],
      ['Waited on dev', 'Not collected yet'],
    ];
    for (const [label, copy] of cases) {
      const figure = tile(quality, label);
      expect(figure).toHaveAttribute('data-state', 'unavailable');
      expect(figure).toHaveTextContent(copy);
      expect(figure.textContent).not.toMatch(/\d/);
    }
    // The grader reason lives in the AI section.
    const ai = screen.getByRole('region', { name: 'AI' });
    const noTouch = tile(ai, 'Solved without a human');
    expect(noTouch).toHaveTextContent('Waits for the AI grader');
    expect(noTouch.textContent).not.toMatch(/\d/);
    expect(new Set([noTouch.textContent, 'Not built yet', 'No data in this window']).size).toBe(3);
  });

  it('keeps the median as a number when the p90 is the same and when there is one sample', async () => {
    open((days) =>
      dashboardOps(
        {
          sla: {
            ...dashboardOps().sla,
            firstResponse: {
              status: 'ok',
              data: { medianSeconds: 30, p90Seconds: 30, samples: 1 },
            },
          },
        },
        days,
      ),
    );
    const sla = await screen.findByRole('region', { name: 'SLA' });
    expect(tile(sla, 'First response')).toHaveTextContent('30s');
  });

  it('shows a missing services list and a missing AI section as one reason line', async () => {
    open((days) =>
      dashboardOps(
        {
          services: { status: 'not_available', reason: 'not_collected' },
          ai: { status: 'not_available', reason: 'no_data' },
        },
        days,
      ),
    );
    const services = await screen.findByRole('region', { name: 'Service status' });
    expect(within(services).getByText('Not collected yet')).toBeVisible();
    const ai = screen.getByRole('region', { name: 'AI' });
    expect(within(ai).getByText('No data in this window')).toBeVisible();
  });
});

describe('Ops dashboard: what a role does not see', () => {
  it('says so and shows no number, for an agent', async () => {
    open((days) => agentDashboardOps(days), 'agent');
    const quality = await screen.findByRole('region', { name: 'Quality' });
    const csat = tile(quality, 'CSAT');
    expect(csat).toHaveAttribute('data-state', 'restricted');
    expect(csat).toHaveTextContent('Not visible to your role');
    expect(csat.textContent).not.toMatch(/\d/);

    const ai = screen.getByRole('region', { name: 'AI' });
    expect(ai).toHaveTextContent('Not visible to your role');
    expect(within(ai).queryByText(/Drafts accepted/)).toBeNull();

    const usage = screen.getByRole('region', { name: 'Product usage' });
    expect(within(usage).getAllByText('Not visible to your role').length).toBeGreaterThan(0);
    expect(usage).not.toHaveTextContent('Acme Logistics');

    const team = screen.getByRole('region', { name: 'Team' });
    expect(within(team).queryByText('Mana K.')).toBeNull();
    // What the agent does see is still there.
    const now = screen.getByRole('region', { name: 'Now' });
    expect(tile(now, 'Open')).toHaveTextContent('23');
  });

  it('keeps a restricted figure apart from a missing one', async () => {
    open((days) => agentDashboardOps(days), 'agent');
    const quality = await screen.findByRole('region', { name: 'Quality' });
    expect(tile(quality, 'CSAT')).toHaveAttribute('data-state', 'restricted');
    expect(tile(quality, 'Escalated')).toHaveAttribute('data-state', 'unavailable');
  });

  it('is denied to someone without the permission', async () => {
    open(undefined, 'client');
    expect(await screen.findByText(/don.t have access/i)).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Now' })).toBeNull();
  });

  it('links the AI cost page and the CEO view to those who may read them, and to nobody else', async () => {
    const { unmount } = renderOpen('lead');
    expect(await screen.findByRole('link', { name: 'AI cost' })).toHaveAttribute(
      'href',
      '/dashboard/cost',
    );
    expect(screen.getByRole('link', { name: 'CEO view' })).toHaveAttribute(
      'href',
      '/dashboard/ceo',
    );
    unmount();
    renderOpen('agent');
    await screen.findByRole('region', { name: 'Now' });
    expect(screen.queryByRole('link', { name: 'AI cost' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'CEO view' })).toBeNull();
  });
});

describe('Ops dashboard: reliability, AI, team, usage, services', () => {
  it('links every open incident, with its severity in words and an icon', async () => {
    open();
    const reliability = await screen.findByRole('region', { name: 'Reliability' });
    const link = within(reliability).getByRole('link', { name: /Checkout API slow in region A/ });
    expect(link).toHaveAttribute('href', `/incidents?incident=${INCIDENT_OPEN.id}`);
    const row = link.closest('li') as HTMLElement;
    expect(row).toHaveTextContent('SEV2');
    expect(row).toHaveTextContent('Major');
    expect(row).toHaveTextContent('Investigating');
    // Severity bars: every level has a row, a real zero is written as 0.
    const bars = within(reliability).getByRole('figure', { name: 'Incidents by severity' });
    expect(within(bars).getAllByRole('listitem')).toHaveLength(4);
    expect(within(bars).getAllByRole('listitem')[0]).toHaveTextContent('SEV1');
    expect(within(bars).getAllByRole('listitem')[0]).toHaveTextContent('0');
  });

  it('shows the figures with their rules and their missing reasons', async () => {
    open();
    const reliability = await screen.findByRole('region', { name: 'Reliability' });
    expect(tile(reliability, 'MTTR')).toHaveTextContent('1h');
    expect(tile(reliability, 'MTTA')).toHaveTextContent('No data in this window');
    expect(tile(reliability, 'Noisy alerts')).toHaveTextContent('30%');
    const cfr = tile(reliability, 'Change failure');
    expect(cfr).toHaveTextContent('10%');
    fireEvent.click(within(cfr).getByRole('button', { name: 'About change failure' }));
    expect(await screen.findByText(/within 2 hours/)).toBeVisible();
  });

  it('says there is no open incident instead of an empty list', async () => {
    open((days) =>
      dashboardOps(
        {
          reliability: {
            ...dashboardOps().reliability,
            incidents: { ...dashboardOps().reliability.incidents, openNow: 0, open: [] },
          },
        },
        days,
      ),
    );
    const reliability = await screen.findByRole('region', { name: 'Reliability' });
    expect(within(reliability).getByText('No open incident.')).toBeVisible();
    expect(tile(reliability, 'Open incidents')).toHaveTextContent('0');
  });

  it('shows the stage of every intent, acceptance, cost per ticket and KB freshness', async () => {
    open();
    const ai = await screen.findByRole('region', { name: 'AI' });
    expect(tile(ai, 'Drafts accepted')).toHaveTextContent('85%');
    expect(tile(ai, 'Cost per ticket')).toHaveTextContent('$0.042');
    const kb = tile(ai, 'Stale KB articles');
    expect(kb).toHaveTextContent('4 of 30');
    fireEvent.click(within(kb).getByRole('button', { name: 'About stale articles' }));
    expect(await screen.findByText(/not verified for 90 days/)).toBeVisible();
    const stages = within(ai).getAllByRole('listitem');
    expect(stages[0]).toHaveTextContent('Password reset');
    expect(stages[0]).toHaveTextContent('Stage 2');
    expect(stages[1]).toHaveTextContent('Billing question');
    expect(stages[1]).toHaveTextContent('Stage 1');
    expect(within(stages[1] as HTMLElement).getByRole('img', { name: 'Pinned' })).toBeVisible();
  });

  it('shows per person, the LINE quota, and gaps as a real zero', async () => {
    open();
    const team = await screen.findByRole('region', { name: 'Team' });
    const mana = within(team).getByRole('row', { name: /Mana K\./ });
    expect(mana).toHaveTextContent('9');
    expect(mana).toHaveTextContent('14');
    expect(tile(team, 'Coverage gaps')).toHaveAttribute('data-state', 'ok');
    expect(tile(team, 'Coverage gaps')).toHaveTextContent('0');
    expect(tile(team, 'LINE messages')).toHaveTextContent('412 of 1,000');
  });

  it('shows anomalies, the lowest health, and the service status in words', async () => {
    open();
    const usage = await screen.findByRole('region', { name: 'Product usage' });
    expect(within(usage).getByText('exports_started')).toBeVisible();
    expect(within(usage).getByText('Acme Logistics')).toBeVisible();
    expect(within(usage).getByText('Score 41')).toBeVisible();
    const services = screen.getByRole('region', { name: 'Service status' });
    expect(within(services).getByText('Degraded performance')).toBeVisible();
    expect(within(services).getByText('Operational')).toBeVisible();
  });
});

describe('Ops dashboard: loading, error, language', () => {
  it('shows a skeleton with a status while the first answer is on its way', async () => {
    consoleApi({
      overrides: {
        'GET /v1/dashboard/ops': () => new Promise(() => undefined) as never,
      },
    });
    renderConsole(<DashboardPage />);
    expect(await screen.findByText('Loading the dashboard…')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Now' })).toBeNull();
  });

  it('shows an error with a retry, and recovers', async () => {
    let fail = true;
    consoleApi({
      overrides: {
        'GET /v1/dashboard/ops': () =>
          fail ? apiError(500, 'internal') : { json: dashboardOps() },
      },
    });
    renderConsole(<DashboardPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the dashboard.');
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Now' })).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('speaks Thai: sections, reasons and the role notice', async () => {
    open((days) => agentDashboardOps(days), 'agent', { locale: 'th' });
    expect(await screen.findByRole('region', { name: 'ตอนนี้' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'คุณภาพ' })).toHaveTextContent(
      'บทบาทของคุณไม่เห็นข้อมูลนี้',
    );
    expect(screen.getByRole('region', { name: 'คุณภาพ' })).toHaveTextContent('ยังไม่ได้พัฒนา');
    expect(screen.getByRole('radio', { name: '7 วันที่ผ่านมา' })).toBeChecked();
  });
});
