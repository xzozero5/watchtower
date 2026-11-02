import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EvidenceCard, TicketTools } from '@watchtower/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { consoleApi } from '@/test/console-api';
import { uuid } from '@/test/fixtures';
import { apiError, type MockHandler } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { InvestigatePanel } from './investigate-panel';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const AT = '2026-11-02T02:55:00.000Z';

const TOOLS: TicketTools = {
  intentKey: null,
  buttons: [
    {
      templateId: uuid(11),
      kind: 'logs',
      name: 'recent-errors',
      title: 'Recent errors',
      inputParams: [],
      connected: true,
      mock: false,
    },
    {
      templateId: uuid(12),
      kind: 'data',
      name: 'account-usage',
      title: 'Account usage',
      inputParams: ['report_id'],
      connected: true,
      mock: true,
    },
    {
      templateId: uuid(13),
      kind: 'logs',
      name: 'deploys',
      title: 'Recent deploys',
      inputParams: [],
      connected: false,
      mock: false,
    },
  ],
};

function card(overrides: Partial<EvidenceCard> = {}): EvidenceCard {
  return {
    id: uuid(21),
    ticketId: uuid(1),
    incidentId: null,
    kind: 'logs',
    templateId: uuid(11),
    templateName: 'recent-errors',
    title: 'Recent errors',
    summary: '12 entries, 02:00 to 03:00',
    excerpt: 'ERROR timeout calling <email>',
    resultCount: 12,
    truncated: false,
    maskedColumns: [],
    windowFrom: null,
    windowTo: null,
    mock: false,
    createdBy: uuid(900),
    createdAt: AT,
    ...overrides,
  };
}

function panelApi(options: {
  role?: 'agent' | 'dev' | 'client' | 'lead';
  tools?: TicketTools;
  cards?: EvidenceCard[];
  run?: MockHandler;
  unpin?: MockHandler;
}) {
  let cards = options.cards ?? [];
  return consoleApi({
    role: options.role ?? 'agent',
    overrides: {
      'GET /v1/tickets/:id/tools': { json: options.tools ?? TOOLS },
      'GET /v1/tickets/:id/evidence': () => ({ json: { items: cards } }),
      'POST /v1/tickets/:id/tools/run':
        options.run ??
        (() => {
          cards = [card()];
          return { status: 201, json: cards[0] };
        }),
      'DELETE /v1/tickets/:id/evidence/:cardId':
        options.unpin ??
        (() => {
          cards = [];
          return { status: 204 };
        }),
    },
  });
}

describe('Investigation buttons', () => {
  it('lists the checks: sample data says Mock, an unconnected system says so and cannot be pressed', async () => {
    panelApi({});
    renderConsole(<InvestigatePanel ticketKey="OPS-1" />);
    const list = await screen.findByRole('list', { name: 'Investigation buttons' });
    const usage = within(list).getByRole('button', { name: /Account usage/ });
    expect(within(usage).getByText('Mock')).toBeVisible();
    const deploys = within(list).getByRole('button', { name: /Recent deploys/ });
    expect(within(deploys).getByText('Not connected')).toBeVisible();
    expect(deploys).toBeDisabled();
    expect(within(list).getByRole('button', { name: 'Recent errors' })).toBeEnabled();
  });

  it('runs a check in one press and pins the result, with Mock on a mock card', async () => {
    const user = userEvent.setup();
    const api = panelApi({});
    renderConsole(<InvestigatePanel ticketKey="OPS-1" />);
    await user.click(await screen.findByRole('button', { name: 'Recent errors' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/tools/run', 'POST')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/tickets/OPS-1/tools/run', 'POST')[0]?.body).toEqual({
      templateId: uuid(11),
    });
    const cards = await screen.findByRole('list', { name: 'Pinned results' });
    expect(within(cards).getByText('Recent errors')).toBeVisible();
    expect(within(cards).getByText('12 results')).toBeVisible();
    expect(within(cards).queryByText('Mock')).toBeNull();
  });

  it('shows a mock card as mock, and what was hidden and cut short', async () => {
    panelApi({
      cards: [card({ mock: true, truncated: true, maskedColumns: ['email', 'phone'] })],
    });
    renderConsole(<InvestigatePanel ticketKey="OPS-1" />);
    const cards = await screen.findByRole('list', { name: 'Pinned results' });
    expect(within(cards).getByText('Mock')).toBeVisible();
    expect(within(cards).getByText('Cut short')).toBeVisible();
    expect(within(cards).getByText('2 columns hidden').closest('[title]')).toHaveAttribute(
      'title',
      expect.stringContaining('email, phone'),
    );
  });

  it('asks for the values a check needs, then sends them', async () => {
    const user = userEvent.setup();
    const api = panelApi({});
    renderConsole(<InvestigatePanel ticketKey="OPS-1" />);
    await user.click(await screen.findByRole('button', { name: /Account usage/ }));
    expect(api.callsTo('/v1/tickets/OPS-1/tools/run', 'POST')).toHaveLength(0);
    const run = screen.getByRole('button', { name: 'Run' });
    expect(run).toBeDisabled();
    await user.type(screen.getByLabelText('Value for report_id'), 'r-42');
    await user.click(run);
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/tools/run', 'POST')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/tickets/OPS-1/tools/run', 'POST')[0]?.body).toEqual({
      templateId: uuid(12),
      params: { report_id: 'r-42' },
    });
  });

  it('answers "not connected" as an answer, not as a failure, and pins nothing', async () => {
    const user = userEvent.setup();
    panelApi({ run: apiError(503, 'service_unavailable', 'not connected') });
    renderConsole(<InvestigatePanel ticketKey="OPS-1" />);
    await user.click(await screen.findByRole('button', { name: 'Recent errors' }));
    const status = await screen.findByText(/Recent errors: the system is not connected here/);
    expect(status).toBeVisible();
    expect(status.className).not.toContain('text-danger');
    expect(screen.getByText('Nothing pinned yet.')).toBeVisible();
  });

  it('says when the rate budget is used up', async () => {
    const user = userEvent.setup();
    panelApi({ run: apiError(429, 'rate_limited', 'slow down') });
    renderConsole(<InvestigatePanel ticketKey="OPS-1" />);
    await user.click(await screen.findByRole('button', { name: 'Recent errors' }));
    expect(
      await screen.findByText('Too many checks just now. Try again in a minute.'),
    ).toBeVisible();
  });

  it('unpins a result', async () => {
    const user = userEvent.setup();
    const api = panelApi({ cards: [card()] });
    renderConsole(<InvestigatePanel ticketKey="OPS-1" />);
    await user.click(await screen.findByRole('button', { name: 'Unpin Recent errors' }));
    await waitFor(() => {
      expect(api.callsTo(`/v1/tickets/OPS-1/evidence/${uuid(21)}`, 'DELETE')).toHaveLength(1);
    });
    expect(await screen.findByText('Nothing pinned yet.')).toBeVisible();
  });

  it('says when a ticket has no checks', async () => {
    panelApi({ tools: { intentKey: null, buttons: [] } });
    renderConsole(<InvestigatePanel ticketKey="OPS-1" />);
    expect(await screen.findByText('No checks are set up for this ticket.')).toBeVisible();
  });

  it('is there for dev, who may run checks, and never calls an ad-hoc route', async () => {
    const user = userEvent.setup();
    const api = panelApi({ role: 'dev' });
    renderConsole(<InvestigatePanel ticketKey="OPS-1" />);
    await user.click(await screen.findByRole('button', { name: 'Recent errors' }));
    await screen.findByRole('list', { name: 'Pinned results' });
    expect(api.calls.some((call) => call.path.includes('/investigate/adhoc'))).toBe(false);
    expect(screen.queryByRole('button', { name: /ad-hoc|adhoc|query of your own/i })).toBeNull();
  });

  it('is not shown to someone who may not investigate', async () => {
    const api = panelApi({ role: 'client' });
    renderConsole(<InvestigatePanel ticketKey="OPS-1" />);
    await waitFor(() => {
      expect(api.callsTo('/v1/auth/session', 'GET').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText('Investigate')).toBeNull();
    expect(api.callsTo('/v1/tickets/OPS-1/tools', 'GET')).toHaveLength(0);
  });

  it('is in Thai too', async () => {
    panelApi({});
    renderConsole(<InvestigatePanel ticketKey="OPS-1" />, { locale: 'th' });
    expect(await screen.findByRole('heading', { name: 'สืบค้น' })).toBeVisible();
    expect(await screen.findByText('ยังไม่เชื่อมต่อ')).toBeVisible();
    expect(screen.getByText('จำลอง')).toBeVisible();
  });
});
