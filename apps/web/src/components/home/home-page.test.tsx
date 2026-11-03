import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiError } from '@/test/mock-api';
import { consoleApi } from '@/test/console-api';
import { makeAutonomy, STATS } from '@/test/console-fixtures';
import { dashboardOps } from '@/test/dashboard-fixtures';
import { renderConsole } from '@/test/render-console';

import { HomePage } from './home-page';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/home',
}));

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

const tile = (name: RegExp | string) => screen.getByRole('link', { name });

describe('Home', () => {
  it('leads with the numbers the head decides on, each a link to the queue', async () => {
    consoleApi();
    renderConsole(<HomePage />);
    const sla = await screen.findByRole('link', { name: /^SLA at risk\s*7/ });
    // 5 at risk and 2 overdue from the counts endpoint: 7 in all.
    expect(sla).toHaveTextContent('7');
    expect(sla).toHaveTextContent('2 overdue');
    expect(sla.getAttribute('href')).toContain('sort=due_asc');
    const unassigned = tile(/^Unassigned\s*3/);
    expect(unassigned).toHaveAttribute('href', expect.stringContaining('assignee=unassigned'));
    expect(tile(/^New\s*4/)).toHaveAttribute('href', '/?status=new');
    expect(tile(/^Needs triage\s*2/)).toHaveAttribute('href', '/?status=triage');
  });

  it('asks the counts endpoint about open work only, and the list about at-risk tickets only', async () => {
    const api = consoleApi();
    renderConsole(<HomePage />);
    await screen.findByRole('link', { name: /^SLA at risk\s*7/ });
    const stats = new URLSearchParams(api.callsTo('/v1/tickets/stats', 'GET')[0]?.search);
    expect(stats.get('status')).toBe('new,triage,open,waiting_on_customer,waiting_on_dev');
    const list = api
      .callsTo('/v1/tickets', 'GET')
      .map((call) => new URLSearchParams(call.search))
      .find((params) => params.has('slaState'));
    expect(list?.get('slaState')).toBe('at_risk,breached');
    expect(list?.get('sort')).toBe('sla_due_asc');
    const oldest = api
      .callsTo('/v1/tickets', 'GET')
      .map((call) => new URLSearchParams(call.search))
      .find((params) => params.get('assignee') === 'unassigned');
    expect(oldest?.get('sort')).toBe('created_asc');
    expect(oldest?.get('limit')).toBe('1');
  });

  it('shows how many open tickets and how many at risk each person holds', async () => {
    consoleApi();
    renderConsole(<HomePage />);
    const load = await screen.findByRole('region', { name: 'Open per person' });
    const mana = (await within(load).findByText('Mana K.')).closest('a') as HTMLElement;
    expect(mana).toHaveTextContent('9');
    expect(mana).toHaveTextContent('2 at risk');
  });

  it('lists the tickets at risk with severity, key, SLA and who has them', async () => {
    consoleApi();
    renderConsole(<HomePage />);
    const list = await screen.findByRole('list', { name: 'SLA at risk' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // The overdue P1 comes first; the P2 still has time but is inside the at-risk window.
    expect(within(rows[0] as HTMLElement).getByText('OPS-1')).toBeVisible();
    expect(within(rows[0] as HTMLElement).getByText('P1')).toBeVisible();
    expect(within(rows[0] as HTMLElement).getByText(/Overdue/)).toBeVisible();
    expect(within(rows[0] as HTMLElement).getByText('Acme Logistics')).toBeVisible();
    expect(within(rows[0] as HTMLElement).getByText('Unassigned')).toBeVisible();
  });

  it('shows open counts by status and by queue, and the load of each active person', async () => {
    consoleApi();
    renderConsole(<HomePage />);
    expect(await screen.findByRole('link', { name: /^Open\s*31/ })).toBeVisible();
    expect(screen.getByRole('link', { name: /^Waiting on customer\s*12/ })).toBeVisible();
    expect(screen.getByRole('link', { name: /^Support\s*22/ })).toHaveAttribute(
      'href',
      expect.stringContaining('queueId='),
    );
    expect(screen.getByRole('link', { name: /^No queue\s*3/ })).toBeVisible();
    const load = screen.getByRole('region', { name: 'Open per person' });
    expect(within(load).getByText('Mana K.')).toBeVisible();
    expect(within(load).getByText('Pim S.')).toBeVisible();
    // A disabled account is not part of the team's load.
    expect(within(load).queryByText('Dao N.')).not.toBeInTheDocument();
  });

  it('shows the AI at a glance: both switches, intents per stage, a quiet slot for drafts', async () => {
    consoleApi({
      autonomy: makeAutonomy({
        switches: [
          {
            key: 'ai_stage_cap_pinned',
            on: false,
            reason: '',
            changedBy: null,
            changedByName: null,
            changedAt: '2026-11-02T03:00:00.000Z',
          },
          {
            key: 'ai_kill_switch',
            on: true,
            reason: 'provider outage',
            changedBy: null,
            changedByName: null,
            changedAt: '2026-11-02T03:00:00.000Z',
          },
        ],
      }),
    });
    renderConsole(<HomePage />);
    const ai = await screen.findByRole('region', { name: 'AI' });
    await waitFor(() => {
      expect(within(ai).getByText('Stopped')).toBeVisible();
    });
    expect(within(ai).getByText('Off')).toBeVisible();
    // Fixture: one intent at stage 0, one at 1, two at 2 (one of them pinned).
    const stages = within(ai).getByRole('list', { name: 'Intents per stage' });
    expect(within(stages).getByText('Stage 0 · Observe').closest('li')).toHaveTextContent('1');
    expect(
      within(stages).getByText('Stage 2 · Draft for approval').closest('li'),
    ).toHaveTextContent('2');
    expect(within(stages).queryByText(/Stage 3/)).not.toBeInTheDocument();
    expect(within(ai).getByText('1 pinned')).toBeVisible();
    // The AI insight contract does not exist yet: a dash, not an invented number.
    expect(within(ai).getByText('Draft ready').closest('div')).toHaveTextContent('—');
    expect(within(ai).getByText('Needs you').closest('div')).toHaveTextContent('—');
    expect(within(ai).getByRole('link', { name: 'AI controls' })).toHaveAttribute(
      'href',
      '/admin/ai',
    );
  });

  it('reports database and Redis, and says plainly what has no data source yet', async () => {
    consoleApi();
    renderConsole(<HomePage />);
    const system = await screen.findByRole('region', { name: 'System' });
    await waitFor(() => {
      expect(within(system).getByText('Database and Redis: ready')).toBeVisible();
    });
    expect(within(system).getByText(/Outbound queue: Not available yet/)).toBeVisible();
    expect(within(system).getByText(/Integrations: Not available yet/)).toBeVisible();
  });

  it('says the database is not responding when readiness fails', async () => {
    consoleApi({
      overrides: { 'GET /health/ready': { status: 503, json: { status: 'unavailable' } } },
    });
    renderConsole(<HomePage />);
    expect(await screen.findByText('Database or Redis: not responding')).toBeVisible();
  });

  it('falls back quietly while the counts endpoint is missing: the SLA number comes from the list', async () => {
    consoleApi({ stats: () => apiError(404, 'not_found') });
    renderConsole(<HomePage />);
    // Both fixture tickets are at risk or overdue, counted from the loaded page.
    expect(await screen.findByRole('link', { name: /^SLA at risk\s*2/ })).toBeVisible();
    // The sections that need the endpoint say so once each, and keep a Try again.
    const messages = await screen.findAllByText('Counts are not available.');
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThanOrEqual(3);
    // Unassigned has no number, only a dash.
    expect(tile(/^Unassigned/)).toHaveTextContent('—');
    // The rest of the page still works.
    expect(screen.getByRole('list', { name: 'SLA at risk' })).toBeVisible();
  });

  it('shows empty lines instead of empty boxes', async () => {
    consoleApi({
      tickets: [],
      stats: {
        ...STATS,
        total: { count: 0, open: 0, sla: { ok: 0, at_risk: 0, breached: 0, paused: 0 } },
        byStatus: [],
        byQueue: [],
        byAssignee: [],
      },
    });
    renderConsole(<HomePage />);
    expect(await screen.findByText('No tickets at risk.')).toBeVisible();
    expect(screen.getAllByText('No open tickets.')).toHaveLength(2);
  });

  it('is open to a lead and closed to an agent, with a way back', async () => {
    consoleApi({ role: 'lead' });
    const { unmount } = renderConsole(<HomePage />);
    expect(await screen.findByRole('link', { name: /^SLA at risk/ })).toBeVisible();
    unmount();

    consoleApi({ role: 'agent' });
    renderConsole(<HomePage />);
    expect(await screen.findByText('You don’t have access to this page.')).toBeVisible();
    expect(screen.getByText('It needs the Lead role.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to the queue' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('link', { name: /SLA at risk/ })).not.toBeInTheDocument();
  });

  it('reads in Thai', async () => {
    consoleApi();
    renderConsole(<HomePage />, { locale: 'th' });
    expect(await screen.findByRole('link', { name: /^ใกล้หลุด SLA\s*7/ })).toBeVisible();
    expect(screen.getByRole('region', { name: 'งานที่เปิดอยู่ต่อคน' })).toBeVisible();
  });

  it('shows the share of accepted AI drafts on the highlight card, and no card without a figure', async () => {
    consoleApi({
      overrides: { 'GET /v1/dashboard/ops': () => ({ json: dashboardOps() }) },
    });
    renderConsole(<HomePage />);
    const card = await screen.findByRole('region', { name: 'Drafts accepted' });
    expect(card).toHaveClass('bg-highlight');
    expect(card).toHaveTextContent('85%');
    expect(card).toHaveTextContent('20 decided, 5 edited');
  });

  it('leaves the highlight card out when the dashboard figures cannot be read (N5)', async () => {
    consoleApi({ overrides: { 'GET /v1/dashboard/ops': () => apiError(500, 'internal') } });
    renderConsole(<HomePage />);
    await screen.findByRole('link', { name: /^SLA at risk\s*7/ });
    expect(screen.queryByRole('region', { name: 'Drafts accepted' })).toBeNull();
  });
});
