import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiError } from '@/test/mock-api';
import { consoleApi, makeAutonomy, STATS } from '@/test/console-fixtures';
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
    const sla = await screen.findByRole('link', { name: 'SLA at risk, 7 tickets' });
    // 5 at risk and 2 overdue from the counts endpoint: 7 in all.
    expect(sla).toHaveTextContent('7');
    expect(sla).toHaveTextContent('2 overdue');
    expect(sla.getAttribute('href')).toContain('sort=due_asc');
    const unassigned = tile('Unassigned, 3 tickets');
    expect(unassigned).toHaveAttribute('href', expect.stringContaining('assignee=unassigned'));
    expect(tile('New, 4 tickets')).toHaveAttribute('href', '/?status=new');
    expect(tile('Needs triage, 2 tickets')).toHaveAttribute('href', '/?status=triage');
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
    expect(await screen.findByRole('link', { name: 'Open, 31 tickets' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Waiting on customer, 12 tickets' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Support, 22 tickets' })).toHaveAttribute(
      'href',
      expect.stringContaining('queueId='),
    );
    expect(screen.getByRole('link', { name: 'No queue, 3 tickets' })).toBeVisible();
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
            changedAt: '2026-11-02T03:00:00.000Z',
          },
          {
            key: 'ai_kill_switch',
            on: true,
            reason: 'provider outage',
            changedBy: null,
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
    expect(await screen.findByRole('link', { name: 'SLA at risk, 2 tickets' })).toBeVisible();
    // The sections that need the endpoint say so once each, and keep a Try again.
    const messages = await screen.findAllByText('Counts are not available.');
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThanOrEqual(3);
    // Unassigned has no number, only a dash.
    expect(tile('Unassigned, 0 tickets')).toHaveTextContent('—');
    // The rest of the page still works.
    expect(screen.getByRole('list', { name: 'SLA at risk' })).toBeVisible();
  });

  it('shows empty lines instead of empty boxes', async () => {
    consoleApi({
      tickets: [],
      stats: {
        ...STATS,
        byStatus: {},
        byQueue: [],
        byAssignee: [],
        bySlaState: { ok: 0, at_risk: 0, breached: 0, paused: 0 },
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
    expect(await screen.findByRole('link', { name: 'ใกล้หลุด SLA 7 ticket' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'งานที่เปิดอยู่ต่อคน' })).toBeVisible();
  });
});
