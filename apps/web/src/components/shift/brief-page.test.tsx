import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';
import { shiftApi } from '@/test/shift-api';
import {
  handoffItem,
  incomingHandoffs,
  nth,
  p3Item,
  shiftBrief,
  shiftNote,
  shiftSession,
  WHO,
} from '@/test/shift-fixtures';
import { uuid } from '@/test/fixtures';

import { BriefPage } from './brief-page';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/shift/brief',
}));

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

const ticket = (n: number, overrides = {}) => ({
  id: uuid(3000 + n),
  key: `OPS-${String(100 + n)}`,
  subject: `Subject ${String(n)}`,
  priority: 'P1' as const,
  status: 'open',
  slaState: 'at_risk' as const,
  slaMinutesLeft: 90,
  dueAt: null,
  ...overrides,
});

describe('Daily brief', () => {
  it('lists the sections in the order of the spec, collapsing empty ones to one line', async () => {
    shiftApi({ overrides: { 'GET /v1/shifts/brief': { json: shiftBrief() } } });
    renderConsole(<BriefPage />);
    await screen.findByRole('heading', { name: 'Daily brief' });
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      'Daily brief',
      expect.stringContaining('Handoff from the previous shift'),
      expect.stringContaining('Open incidents'),
      expect.stringContaining('My tickets by SLA risk'),
      expect.stringContaining('Tickets carried over to me'),
      expect.stringContaining('Snoozed alerts'),
      expect.stringContaining('Deploys in the last 24 hours'),
      expect.stringContaining('Customer watch items'),
      expect.stringContaining('Knowledge base changes'),
      expect.stringContaining('Notes left for me'),
    ]);
    expect(screen.getByText('No open incidents.')).toBeVisible();
    expect(screen.getByText('You have no open tickets.')).toBeVisible();
    // No AI text: the summary section is absent when `aiSummary` is null.
    expect(screen.queryByText('AI summary')).not.toBeInTheDocument();
    expect(screen.getByText(/No AI text is mixed in/)).toBeVisible();
  });

  it('shows my tickets with the SLA minutes the server counted', async () => {
    shiftApi({
      overrides: {
        'GET /v1/shifts/brief': {
          json: shiftBrief({
            myTickets: [
              ticket(1),
              ticket(2, { slaState: 'breached', slaMinutesLeft: 0, priority: 'P2' }),
              ticket(3, { slaState: null, slaMinutesLeft: null, priority: 'P3' }),
              ticket(4, { slaState: 'paused', slaMinutesLeft: null, priority: 'P4' }),
            ],
            carriedOver: [{ ...ticket(1), crossedShifts: 3 }],
          }),
        },
      },
    });
    renderConsole(<BriefPage />);
    const section = await screen.findByRole('region', { name: /My tickets by SLA risk/ });
    const rows = within(section).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('OPS-101');
    expect(rows[0]).toHaveTextContent('SLA at risk');
    expect(rows[0]).toHaveTextContent('1h 30m left');
    expect(rows[1]).toHaveTextContent('SLA breached');
    expect(rows[1]).not.toHaveTextContent('left');
    expect(rows[2]).toHaveTextContent('No SLA running');
    expect(rows[3]).toHaveTextContent('SLA paused');
    expect(within(nth(rows, 0)).getByRole('link', { name: 'Open OPS-101' })).toHaveAttribute(
      'href',
      '/?ticket=OPS-101',
    );
    expect(screen.getByText('Crossed 3 shifts')).toBeVisible();
  });

  it('shows an AI summary only with its chip and its times, when the api sends one', async () => {
    shiftApi({
      overrides: {
        'GET /v1/shifts/brief': {
          json: shiftBrief({
            aiSummary: {
              text: 'Two tickets need you first.',
              generatedAt: '2026-11-02T01:01:00.000Z',
              dataAsOf: '2026-11-02T01:00:00.000Z',
              aiRunId: 'run-1',
              // T-135: the api now sends the claims behind `text`; the screen still shows `text` until the claim line is built.
              claims: [
                {
                  text: 'Two tickets need you first.',
                  evidence: [{ kind: 'ticket', label: 'OPS-1', href: '/?ticket=OPS-1' }],
                  uncited: false,
                },
              ],
              mock: false,
            },
          }),
        },
      },
    });
    renderConsole(<BriefPage />);
    expect(await screen.findByText('Two tickets need you first.')).toBeVisible();
    expect(screen.getByText('AI')).toBeVisible();
    expect(screen.getByText('Generated at 08:01 from data at 08:00')).toBeVisible();
  });

  it('marks the brief read and goes to the queue', async () => {
    const user = userEvent.setup();
    const api = shiftApi({
      overrides: {
        'POST /v1/shifts/brief/read': {
          json: shiftSession({ briefReadAt: '2026-11-02T03:00:00.000Z' }),
        },
      },
    });
    renderConsole(<BriefPage />);
    await user.click(await screen.findByRole('button', { name: 'Mark brief read' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/shifts/brief/read', 'POST')).toHaveLength(1);
    });
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/');
    });
  });

  it('tells a person who is not clocked in to clock in, and hides the button', async () => {
    shiftApi({ overrides: { 'GET /v1/shifts/brief': { json: shiftBrief({ session: null }) } } });
    renderConsole(<BriefPage />);
    expect(await screen.findByText('Clock in to mark the brief read.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Mark brief read' })).not.toBeInTheDocument();
  });

  it('shows unread notes with Mark as read', async () => {
    const user = userEvent.setup();
    const api = shiftApi({
      overrides: {
        'GET /v1/shifts/brief': { json: shiftBrief({ notes: [shiftNote(1)] }) },
        [`POST /v1/shift-notes/${shiftNote(1).id}/read`]: {
          json: shiftNote(1, { readAt: '2026-11-02T03:00:00.000Z' }),
        },
      },
    });
    renderConsole(<BriefPage />);
    expect(await screen.findByText('Note number 1')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Mark as read' }));
    await waitFor(() => {
      expect(api.callsTo(`/v1/shift-notes/${shiftNote(1).id}/read`, 'POST')).toHaveLength(1);
    });
  });

  it('says so and offers a retry when the brief cannot be loaded', async () => {
    shiftApi({ overrides: { 'GET /v1/shifts/brief': apiError(500, 'unknown') } });
    renderConsole(<BriefPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load the shift information.',
    );
  });
});

describe('Handoff acknowledgment in the brief (spec 9.4)', () => {
  const items = () => [
    handoffItem(1, { nextAction: 'Wait for the log file', carriedShifts: 3 }),
    p3Item(2),
    handoffItem(3, { ackStatus: 'accepted', ackBy: WHO.me }),
    handoffItem(4, { kind: 'watch', requiresAck: false, ticket: null, title: 'Go-live tonight' }),
  ];

  const open = (extra: Record<string, unknown> = {}) =>
    shiftApi({
      overrides: {
        'GET /v1/shifts/brief': { json: shiftBrief({ handoff: incomingHandoffs(items()) }) },
        ...extra,
      },
    });

  it('shows progress, the lead alert time, the carried warning and who answered', async () => {
    open();
    renderConsole(<BriefPage />);
    expect(await screen.findByTestId('ack-progress')).toHaveTextContent('1 of 3 acknowledged');
    expect(
      screen.getByText('The lead will be alerted at 10:10 if items are still unacknowledged.'),
    ).toBeVisible();
    const list = screen.getByRole('list', { name: 'Handoff items' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Crossed 3 shifts');
    expect(rows[0]).toHaveTextContent('Next: Wait for the log file');
    expect(rows[2]).toHaveTextContent('Accepted by Alex Agent');
    expect(within(nth(rows, 2)).queryByRole('button')).not.toBeInTheDocument();
    expect(rows[3]).toHaveTextContent('For information');
  });

  it('answers the focused item with 1, and moves with J and K', async () => {
    const user = userEvent.setup();
    const api = open({
      [`POST /v1/handoffs/items/${handoffItem(1).id}/ack`]: {
        json: { ...handoffItem(1, { ackStatus: 'accepted' }), warnings: [] },
      },
    });
    renderConsole(<BriefPage />);
    const list = await screen.findByRole('list', { name: 'Handoff items' });
    const rows = within(list).getAllByRole('listitem');
    nth(rows, 0).focus();
    await user.keyboard('j');
    expect(rows[1]).toHaveFocus();
    await user.keyboard('k');
    expect(rows[0]).toHaveFocus();
    await user.keyboard('1');
    await waitFor(() => {
      expect(api.callsTo(`/v1/handoffs/items/${handoffItem(1).id}/ack`, 'POST')).toHaveLength(1);
    });
    expect(api.callsTo(`/v1/handoffs/items/${handoffItem(1).id}/ack`, 'POST')[0]?.body).toEqual({
      decision: 'accept',
    });
  });

  it('keeps a P1 ticket away from someone off shift but lets a P3 wait for them', async () => {
    const user = userEvent.setup();
    const api = open({
      [`POST /v1/handoffs/items/${handoffItem(2).id}/ack`]: {
        json: { ...handoffItem(2, { ackStatus: 'reassigned' }), warnings: ['assignee_off_shift'] },
      },
    });
    renderConsole(<BriefPage />);
    const list = await screen.findByRole('list', { name: 'Handoff items' });
    const rows = within(list).getAllByRole('listitem');

    // P1: Dao (off shift) cannot be picked.
    await user.click(within(nth(rows, 0)).getByRole('button', { name: 'Reassign…' }));
    let dialog = await screen.findByRole('dialog');
    const dao = within(dialog).getByRole('option', { name: /Dao N\./ });
    expect(dao).toBeDisabled();
    expect(dao).toHaveTextContent('off shift');
    expect(within(dialog).getByText(/can only go to someone who is clocked in/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    // P3: Dao can be picked, with a note, and the answer carries the warning.
    await user.click(within(nth(rows, 1)).getByRole('button', { name: 'Reassign…' }));
    dialog = await screen.findByRole('dialog');
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Assign to' }),
      WHO.dao.id,
    );
    expect(within(dialog).getByText(/not clocked in/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Reassign…' }));
    await waitFor(() => {
      expect(api.callsTo(`/v1/handoffs/items/${handoffItem(2).id}/ack`, 'POST')[0]?.body).toEqual({
        decision: 'reassign',
        assigneeId: WHO.dao.id,
      });
    });
    expect(await screen.findByText('Reassigned, but that person is not clocked in.')).toBeVisible();
  });

  it('shows the api sentence when a reassign is refused', async () => {
    const user = userEvent.setup();
    open({
      [`POST /v1/handoffs/items/${handoffItem(1).id}/ack`]: apiError(
        400,
        'validation_failed',
        'OPS-101 is P1: reassign it to someone who is clocked in',
      ),
    });
    renderConsole(<BriefPage />);
    const list = await screen.findByRole('list', { name: 'Handoff items' });
    await user.click(
      within(nth(within(list).getAllByRole('listitem'), 0)).getByRole('button', {
        name: 'Reassign…',
      }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Assign to' }),
      WHO.pim.id,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reassign…' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'OPS-101 is P1: reassign it to someone who is clocked in',
    );
  });

  it('needs a note for a question and keeps the item open', async () => {
    const user = userEvent.setup();
    const api = open({
      [`POST /v1/handoffs/items/${handoffItem(1).id}/ack`]: {
        json: { ...handoffItem(1, { ackStatus: 'question' }), warnings: [] },
      },
    });
    renderConsole(<BriefPage />);
    const list = await screen.findByRole('list', { name: 'Handoff items' });
    await user.click(
      within(nth(within(list).getAllByRole('listitem'), 0)).getByRole('button', {
        name: 'Ask a question',
      }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Send question' }));
    expect(within(dialog).getByText('Required.')).toBeVisible();
    expect(api.callsTo(`/v1/handoffs/items/${handoffItem(1).id}/ack`, 'POST')).toHaveLength(0);
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Your question' }),
      'Which log file?',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Send question' }));
    await waitFor(() => {
      expect(api.callsTo(`/v1/handoffs/items/${handoffItem(1).id}/ack`, 'POST')[0]?.body).toEqual({
        decision: 'question',
        note: 'Which log file?',
      });
    });
  });

  it('shows all done when every item is answered', async () => {
    shiftApi({
      overrides: {
        'GET /v1/shifts/brief': {
          json: shiftBrief({
            handoff: incomingHandoffs([handoffItem(1, { ackStatus: 'accepted', ackBy: WHO.me })]),
          }),
        },
      },
    });
    renderConsole(<BriefPage />);
    expect(await screen.findByTestId('ack-progress')).toHaveTextContent(
      'All items are acknowledged (1).',
    );
    expect(screen.queryByText(/The lead will be alerted/)).not.toBeInTheDocument();
  });
});
