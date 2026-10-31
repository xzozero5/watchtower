import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CALENDAR, consoleApi, POLICY } from '@/test/console-fixtures';
import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { CalendarPage } from './calendar-page';
import { SlaPage } from './sla-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/sla',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SLA policies', () => {
  it('shows each priority’s first response and resolution targets, and the calendar', async () => {
    consoleApi();
    renderConsole(<SlaPage />);
    const table = await screen.findByRole('table', { name: 'Policies' });
    const row = within(table).getAllByRole('row')[1] as HTMLElement;
    expect(within(row).getByText('Gold', { selector: 'button' })).toBeVisible();
    expect(within(row).getByText('15m / 4h')).toBeVisible();
    expect(within(row).getByText('1h / 8h')).toBeVisible();
    expect(within(row).getByText('Bangkok office hours')).toBeVisible();
  });

  it('lists calendars with the number of holidays and links to each', async () => {
    const user = userEvent.setup();
    consoleApi();
    renderConsole(<SlaPage />);
    await user.click(await screen.findByRole('tab', { name: 'Calendars' }));
    const link = await screen.findByRole('link', { name: 'Bangkok office hours' });
    expect(link).toHaveAttribute('href', `/admin/sla/calendars/${CALENDAR.id}`);
    expect(link.closest('tr')).toHaveTextContent('2');
  });

  it('edits a policy and saves targets in minutes', async () => {
    const user = userEvent.setup();
    const api = consoleApi({
      overrides: { [`PATCH /v1/sla-policies/${POLICY.id}`]: { json: POLICY } },
    });
    renderConsole(<SlaPage />);
    await user.click(await screen.findByText('Gold', { selector: 'button' }));
    const sheet = await screen.findByRole('dialog', { name: 'Gold' });
    expect(
      within(sheet).getByText('Changes apply to new due times; running tickets keep theirs.'),
    ).toBeVisible();
    const first = within(sheet).getByLabelText('P3 first response, minutes');
    const resolution = within(sheet).getByLabelText('P3 resolution, minutes');
    await user.type(first, '120');
    await user.type(resolution, '60');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(
      within(sheet).getByText('First response cannot be later than resolution.'),
    ).toBeVisible();
    expect(api.callsTo(`/v1/sla-policies/${POLICY.id}`, 'PATCH')).toHaveLength(0);
    await user.clear(resolution);
    await user.type(resolution, '960');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(api.callsTo(`/v1/sla-policies/${POLICY.id}`, 'PATCH')).toHaveLength(1);
    });
    const body = api.callsTo(`/v1/sla-policies/${POLICY.id}`, 'PATCH')[0]?.body as {
      targets: Record<string, unknown>;
    };
    expect(body.targets.P3).toEqual({
      first_response_min: 120,
      resolution_min: 960,
      calendar: 'business',
    });
    expect(body.targets.P1).toEqual({
      first_response_min: 15,
      resolution_min: 240,
      calendar: '24x7',
    });
    expect(body.targets.P4).toBeUndefined();
  });

  it('is for the head only', async () => {
    consoleApi({ role: 'lead' });
    renderConsole(<SlaPage />);
    expect(await screen.findByText('It needs the Head role.')).toBeVisible();
  });
});

describe('Business calendar', () => {
  it('marks holidays that nobody checked, and warns once above the table', async () => {
    consoleApi();
    renderConsole(<CalendarPage calendarId={CALENDAR.id} />);
    const table = await screen.findByRole('table', { name: 'Holidays' });
    const eve = within(table).getByRole('row', { name: /2026-12-31/ });
    const day = within(table).getByRole('row', { name: /2027-01-01/ });
    expect(within(eve).getByText('Not checked')).toBeVisible();
    expect(within(day).getByText('Checked')).toBeVisible();
    expect(screen.getByTestId('verify-warning')).toHaveTextContent(
      'Check every date against the official announcement before using it for a real SLA.',
    );
  });

  it('shows no warning once every holiday is checked', async () => {
    consoleApi({
      overrides: {
        'GET /v1/business-calendars/:id': {
          json: { ...CALENDAR, holidays: CALENDAR.holidays.map((h) => ({ ...h, checked: true })) },
        },
      },
    });
    renderConsole(<CalendarPage calendarId={CALENDAR.id} />);
    await screen.findByRole('table', { name: 'Holidays' });
    expect(screen.queryByTestId('verify-warning')).not.toBeInTheDocument();
  });

  it('treats a server that sends no check state as not checked', async () => {
    consoleApi({
      overrides: {
        'GET /v1/business-calendars/:id': {
          json: { ...CALENDAR, holidays: [{ date: '2026-12-31', name: 'New Year’s Eve' }] },
        },
      },
    });
    renderConsole(<CalendarPage calendarId={CALENDAR.id} />);
    const table = await screen.findByRole('table', { name: 'Holidays' });
    expect(within(table).getByText('Not checked')).toBeVisible();
  });

  it('records the check against the official announcement for one date', async () => {
    const user = userEvent.setup();
    const api = consoleApi({
      overrides: {
        [`PATCH /v1/business-calendars/${CALENDAR.id}/holidays/2026-12-31`]: {
          json: {
            ...CALENDAR,
            holidays: CALENDAR.holidays.map((h) => ({ ...h, checked: true })),
          },
        },
      },
    });
    renderConsole(<CalendarPage calendarId={CALENDAR.id} />);
    await screen.findByRole('table', { name: 'Holidays' });
    await user.click(
      screen.getByRole('button', {
        name: 'Checked against the official announcement: New Year’s Eve',
      }),
    );
    await waitFor(() => {
      expect(
        api.callsTo(`/v1/business-calendars/${CALENDAR.id}/holidays/2026-12-31`, 'PATCH'),
      ).toHaveLength(1);
    });
    expect(
      api.callsTo(`/v1/business-calendars/${CALENDAR.id}/holidays/2026-12-31`, 'PATCH')[0]?.body,
    ).toEqual({ checked: true });
    await waitFor(() => {
      expect(screen.queryByTestId('verify-warning')).not.toBeInTheDocument();
    });
  });

  it('says plainly when the server cannot record checks yet', async () => {
    const user = userEvent.setup();
    consoleApi({
      overrides: {
        [`PATCH /v1/business-calendars/${CALENDAR.id}/holidays/2026-12-31`]: apiError(
          404,
          'not_found',
        ),
      },
    });
    renderConsole(<CalendarPage calendarId={CALENDAR.id} />);
    await screen.findByRole('table', { name: 'Holidays' });
    await user.click(
      screen.getByRole('button', {
        name: 'Checked against the official announcement: New Year’s Eve',
      }),
    );
    expect(await screen.findByText('This server cannot record the check yet.')).toBeVisible();
  });

  it('adds a holiday and refuses a date that is already listed', async () => {
    const user = userEvent.setup();
    const api = consoleApi({
      overrides: {
        [`PATCH /v1/business-calendars/${CALENDAR.id}`]: { json: CALENDAR },
      },
    });
    renderConsole(<CalendarPage calendarId={CALENDAR.id} />);
    await screen.findByRole('table', { name: 'Holidays' });
    const date = screen.getByLabelText('Date');
    fireEvent.change(date, { target: { value: '2026-12-31' } });
    await user.type(screen.getAllByLabelText('Name')[0] as HTMLElement, 'Again');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('That date is already listed.')).toBeVisible();
    fireEvent.change(date, { target: { value: '2027-05-01' } });
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(api.callsTo(`/v1/business-calendars/${CALENDAR.id}`, 'PATCH')).toHaveLength(1);
    });
    expect(api.callsTo(`/v1/business-calendars/${CALENDAR.id}`, 'PATCH')[0]?.body).toEqual({
      holidays: [
        { date: '2026-12-31', name: 'New Year’s Eve' },
        { date: '2027-01-01', name: 'New Year’s Day' },
        { date: '2027-05-01', name: 'Again' },
      ],
    });
  });

  it('previews an imported file and flags dates already listed', async () => {
    const user = userEvent.setup();
    const api = consoleApi({
      overrides: { [`PATCH /v1/business-calendars/${CALENDAR.id}`]: { json: CALENDAR } },
    });
    renderConsole(<CalendarPage calendarId={CALENDAR.id} />);
    await screen.findByRole('table', { name: 'Holidays' });
    const file = new File(
      [
        JSON.stringify([
          { date: '2027-02-14', name: 'Example Day' },
          { date: '2027-01-01', name: 'New Year’s Day' },
        ]),
      ],
      'holidays.json',
      { type: 'application/json' },
    );
    await user.upload(screen.getByLabelText('Import JSON', { selector: 'input' }), file);
    const dialog = await screen.findByRole('dialog', { name: 'Import holidays' });
    expect(within(dialog).getByText('1 new, 1 already listed.')).toBeVisible();
    expect(within(dialog).getByText('Already listed')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Add 1' }));
    await waitFor(() => {
      expect(api.callsTo(`/v1/business-calendars/${CALENDAR.id}`, 'PATCH')).toHaveLength(1);
    });
    expect(
      (
        api.callsTo(`/v1/business-calendars/${CALENDAR.id}`, 'PATCH')[0]?.body as {
          holidays: unknown[];
        }
      ).holidays,
    ).toHaveLength(3);
  });

  it('rejects a file that is not a list of holidays', async () => {
    const user = userEvent.setup();
    consoleApi();
    renderConsole(<CalendarPage calendarId={CALENDAR.id} />);
    await screen.findByRole('table', { name: 'Holidays' });
    await user.upload(
      screen.getByLabelText('Import JSON', { selector: 'input' }),
      new File(['{"nope":1}'], 'x.json', { type: 'application/json' }),
    );
    expect(await screen.findByText('The file is not a list of dates and names.')).toBeVisible();
  });

  it('edits opening hours and saves them', async () => {
    const user = userEvent.setup();
    const api = consoleApi({
      overrides: { [`PATCH /v1/business-calendars/${CALENDAR.id}`]: { json: CALENDAR } },
    });
    renderConsole(<CalendarPage calendarId={CALENDAR.id} />);
    await screen.findByRole('table', { name: 'Holidays' });
    const save = screen.getAllByRole('button', { name: 'Save' })[0] as HTMLElement;
    expect(save).toBeDisabled();
    await user.click(screen.getAllByRole('checkbox', { name: 'Open' })[6] as HTMLElement); // Saturday
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => {
      expect(api.callsTo(`/v1/business-calendars/${CALENDAR.id}`, 'PATCH')).toHaveLength(1);
    });
    const hours = (
      api.callsTo(`/v1/business-calendars/${CALENDAR.id}`, 'PATCH')[0]?.body as {
        hours: Record<string, unknown[]>;
      }
    ).hours;
    expect(hours.sat).toEqual([{ start: '09:00', end: '18:00' }]);
    expect(hours.sun).toEqual([]);
  });
});
