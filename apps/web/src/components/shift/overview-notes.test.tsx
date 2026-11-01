import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';
import { shiftApi } from '@/test/shift-api';
import { rosterEntry, shiftNote, shiftOverview, shiftSession, WHO } from '@/test/shift-fixtures';
import { uuid } from '@/test/fixtures';

import { NotesPage } from './notes-page';
import { OverviewPage } from './overview-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/shift/overview',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Lead view (AC-7: the dashboard shows 0 unacknowledged)', () => {
  it('shows zero unacknowledged items in words once everything is answered', async () => {
    shiftApi({ role: 'lead' });
    renderConsole(<OverviewPage />);
    expect(await screen.findByTestId('unack-summary')).toHaveTextContent('0 unacknowledged');
    expect(screen.getByText('Every handoff item is acknowledged.')).toBeVisible();
    expect(screen.getByText('Nobody is clocked in.')).toBeVisible();
    expect(screen.getByText('Everyone rostered has clocked in.')).toBeVisible();
    expect(screen.getByText('No open questions.')).toBeVisible();
  });

  it('flags overdue items with words and an icon, and shows overdue questions on P1 and P2', async () => {
    shiftApi({
      role: 'lead',
      overrides: {
        'GET /v1/shifts/overview': {
          json: shiftOverview({
            unacknowledged: {
              count: 2,
              overdue: 1,
              items: [
                {
                  itemId: uuid(5001),
                  handoffId: uuid(5000),
                  title: 'OPS-101 Export is slow',
                  ticketKey: 'OPS-101',
                  from: WHO.mana,
                  confirmedAt: '2026-11-02T02:00:00.000Z',
                  overdue: true,
                },
                {
                  itemId: uuid(5002),
                  handoffId: uuid(5000),
                  title: 'Go-live tonight',
                  ticketKey: null,
                  from: WHO.mana,
                  confirmedAt: '2026-11-02T02:50:00.000Z',
                  overdue: false,
                },
              ],
            },
            openQuestions: 3,
            questions: {
              overdue: 1,
              items: [
                {
                  itemId: uuid(5003),
                  handoffId: uuid(5000),
                  title: 'OPS-102 Login loop',
                  ticketKey: 'OPS-102',
                  priority: 'P1',
                  from: WHO.mana,
                  askedBy: WHO.pim,
                  askedAt: '2026-11-02T02:00:00.000Z',
                  overdue: true,
                },
              ],
            },
          }),
        },
      },
    });
    renderConsole(<OverviewPage />);
    expect(await screen.findByTestId('unack-summary')).toHaveTextContent('2 unacknowledged');
    expect(screen.getByTestId('unack-summary')).toHaveTextContent('1 overdue');
    const section = screen.getByRole('region', { name: /Unacknowledged handoff items/ });
    const rows = within(section).getAllByRole('listitem');
    expect(rows[0]).toHaveAttribute('data-overdue', 'true');
    expect(rows[0]).toHaveTextContent('Overdue');
    expect(rows[1]).not.toHaveTextContent('Overdue');
    const questions = screen.getByRole('region', { name: /Open questions on P1 and P2/ });
    expect(questions).toHaveTextContent('OPS-102');
    expect(questions).toHaveTextContent('asked by Pim S.');
    expect(questions).toHaveTextContent('Overdue');
    expect(questions).toHaveTextContent('P1');
    expect(screen.getByText('Open questions in total: 3')).toBeVisible();
  });

  it('lists who is on shift and the no-shows, and lets a lead clock someone out with a reason', async () => {
    const user = userEvent.setup();
    const api = shiftApi({
      role: 'lead',
      overrides: {
        'GET /v1/shifts/overview': {
          json: shiftOverview({
            onShift: [
              shiftSession({
                userId: WHO.pim.id,
                userName: WHO.pim.name,
                late: true,
                lateMinutes: 12,
              }),
            ],
            noShows: [rosterEntry(1, { userId: WHO.dao.id, userName: WHO.dao.name })],
          }),
        },
        'POST /v1/shifts/clock-out': {
          json: {
            session: shiftSession({ clockedOutAt: '2026-11-02T03:00:00.000Z' }),
            overridden: true,
          },
        },
      },
    });
    renderConsole(<OverviewPage />);
    const onShift = await screen.findByRole('region', { name: /On shift/ });
    expect(onShift).toHaveTextContent('Pim S.');
    expect(onShift).toHaveTextContent('late 12m');
    expect(screen.getByRole('region', { name: /No-shows/ })).toHaveTextContent('Dao N.');

    await user.click(screen.getByRole('button', { name: 'Clock out Pim S.' }));
    const dialog = await screen.findByRole('dialog', { name: 'Clock out Pim S.' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      'Left sick, covering now',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Clock out' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/shifts/clock-out', 'POST')[0]?.body).toEqual({
        userId: WHO.pim.id,
        override: { reason: 'Left sick, covering now' },
      });
    });
  });

  it('is not for an agent', async () => {
    shiftApi({ role: 'agent' });
    renderConsole(<OverviewPage />);
    expect(await screen.findByText(/You don’t have access to this page/)).toBeVisible();
  });

  it('says so when the overview cannot be loaded', async () => {
    shiftApi({ role: 'lead', overrides: { 'GET /v1/shifts/overview': apiError(500, 'unknown') } });
    renderConsole(<OverviewPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load the shift information.',
    );
  });
});

describe('Shift notes', () => {
  it('shows the inbox with unread notes and marks one read', async () => {
    const user = userEvent.setup();
    const api = shiftApi({
      overrides: {
        [`POST /v1/shift-notes/${shiftNote(1).id}/read`]: {
          json: shiftNote(1, { readAt: '2026-11-02T03:00:00.000Z' }),
        },
      },
    });
    renderConsole(<NotesPage />);
    const note = (await screen.findByText('Note number 1')).closest('li') as HTMLElement;
    expect(within(note).getByText('Unread')).toBeVisible();
    expect(screen.getByText('1 unread')).toBeVisible();
    await user.click(within(note).getByRole('button', { name: 'Mark as read' }));
    await waitFor(() => {
      expect(api.callsTo(`/v1/shift-notes/${shiftNote(1).id}/read`, 'POST')).toHaveLength(1);
    });
  });

  it('asks only for unread notes when the box is ticked, and for sent notes on the Sent tab', async () => {
    const user = userEvent.setup();
    const api = shiftApi();
    renderConsole(<NotesPage />);
    await screen.findByText('Note number 1');
    await user.click(screen.getByRole('checkbox', { name: 'Unread only' }));
    await waitFor(() => {
      expect(
        api.callsTo('/v1/shift-notes', 'GET').some((call) => call.search.includes('unread=true')),
      ).toBe(true);
    });
    await user.click(screen.getByRole('radio', { name: 'Sent' }));
    await waitFor(() => {
      expect(
        api.callsTo('/v1/shift-notes', 'GET').some((call) => call.search.includes('box=sent')),
      ).toBe(true);
    });
  });

  it('shows an empty state', async () => {
    shiftApi({
      overrides: {
        'GET /v1/shift-notes': { json: { items: [], nextCursor: null, unreadCount: 0 } },
      },
    });
    renderConsole(<NotesPage />);
    expect(await screen.findByText('No notes.')).toBeVisible();
  });

  it('sends a note to the next shift', async () => {
    const user = userEvent.setup();
    const api = shiftApi({
      overrides: { 'POST /v1/shift-notes': { status: 201, json: shiftNote(2) } },
    });
    renderConsole(<NotesPage />);
    await screen.findByText('Note number 1');
    await user.click(screen.getByRole('button', { name: 'Send note' }));
    expect(screen.getByText('Required.')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: 'Note' }), 'Check the export at 22:00');
    await user.click(screen.getByRole('button', { name: 'Send note' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/shift-notes', 'POST')[0]?.body).toEqual({
        audience: 'next_shift',
        body: 'Check the export at 22:00',
      });
    });
  });

  it('needs a person for a note to a person, and picks from the assignee list without the sender', async () => {
    const user = userEvent.setup();
    const api = shiftApi({
      overrides: { 'POST /v1/shift-notes': { status: 201, json: shiftNote(3) } },
    });
    renderConsole(<NotesPage />);
    await screen.findByText('Note number 1');
    await user.click(screen.getByRole('radio', { name: 'Person' }));
    const picker = await screen.findByRole('combobox', { name: 'To' });
    expect(within(picker).queryByRole('option', { name: 'Alex Agent' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Note' }), 'Call me');
    await user.click(screen.getByRole('button', { name: 'Send note' }));
    expect(await screen.findByText('Required.')).toBeVisible();
    expect(api.callsTo('/v1/shift-notes', 'POST')).toHaveLength(0);
    await user.selectOptions(picker, WHO.pim.id);
    await user.click(screen.getByRole('button', { name: 'Send note' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/shift-notes', 'POST')[0]?.body).toEqual({
        audience: 'person',
        body: 'Call me',
        toUserId: WHO.pim.id,
      });
    });
  });
});
