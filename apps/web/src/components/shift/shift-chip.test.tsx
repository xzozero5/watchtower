import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderConsole } from '@/test/render-console';
import { shiftApi } from '@/test/shift-api';
import { apiError } from '@/test/mock-api';
import { offShiftStatus, shiftSession, shiftStatus } from '@/test/shift-fixtures';

import { ShiftChip } from './shift-chip';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shift chip', () => {
  it('invites an off-shift person to clock in', async () => {
    shiftApi({ overrides: { 'GET /v1/shifts/status': { json: offShiftStatus() } } });
    renderConsole(<ShiftChip expanded />);
    const chip = await screen.findByRole('link', { name: 'Off shift — Clock in' });
    expect(chip).toHaveAttribute('href', '/shift');
    expect(chip).toHaveAttribute('data-shift-state', 'off');
  });

  it('warns in words when the person is late, and counts unread notes and acks for assistive technology', async () => {
    shiftApi({
      overrides: {
        'GET /v1/shifts/status': {
          json: shiftStatus({
            session: shiftSession({ late: true, lateMinutes: 12 }),
            unreadNotes: 2,
            pendingAcks: 1,
          }),
        },
      },
    });
    renderConsole(<ShiftChip expanded />);
    const chip = await screen.findByRole('link', { name: /Late 12m/ });
    expect(chip).toHaveAccessibleName(/Unread notes: 2/);
    expect(chip).toHaveAccessibleName(/Handoff items to acknowledge: 1/);
  });

  it('says in words what the number is: 3 to acknowledge, on the wide rail and in the name on the narrow one', async () => {
    shiftApi({
      overrides: {
        'GET /v1/shifts/status': { json: shiftStatus({ unreadNotes: 2, pendingAcks: 1 }) },
      },
    });
    const wide = renderConsole(<ShiftChip expanded />);
    const chip = await screen.findByRole('link', { name: /On shift/ });
    expect(chip).toHaveTextContent('3 to acknowledge');
    expect(chip).toHaveAccessibleName(/3 to acknowledge/);
    wide.unmount();

    renderConsole(<ShiftChip expanded={false} />);
    const narrow = await screen.findByRole('link', { name: /On shift/ });
    expect(narrow).toHaveAccessibleName(/3 to acknowledge/);
    expect(narrow.querySelector('[data-count="3"]')).not.toBeNull();
  });

  it('asks to finish the handoff once the shift has ended', async () => {
    shiftApi({
      overrides: { 'GET /v1/shifts/status': { json: shiftStatus({ minutesToEnd: -10 }) } },
    });
    renderConsole(<ShiftChip expanded={false} />);
    const chip = await screen.findByRole('link', { name: /Shift ended 10m ago — finish handoff/ });
    expect(chip).toHaveAttribute('data-shift-state', 'ended');
  });

  it('says the shift in words even on the narrow rail, not as an icon alone (T-151)', async () => {
    shiftApi({ overrides: { 'GET /v1/shifts/status': { json: shiftStatus() } } });
    renderConsole(<ShiftChip expanded={false} />);
    const chip = await screen.findByRole('link', { name: /^On shift/ });
    // The visible short form is the shift's hours; the full sentence stays the name.
    expect(chip.textContent).toMatch(/\d{1,2}[:.]\d{2}\s*–\s*\d{1,2}[:.]\d{2}/);
    expect(chip.textContent).not.toMatch(/left/);
  });

  it('greens the clock on a rostered shift going to plan, but not off the roster or when late', async () => {
    const iconOf = (chip: HTMLElement) => chip.querySelector('svg')?.getAttribute('class') ?? '';

    shiftApi({ overrides: { 'GET /v1/shifts/status': { json: shiftStatus() } } });
    const rostered = renderConsole(<ShiftChip expanded />);
    expect(iconOf(await screen.findByRole('link', { name: /^On shift/ }))).toContain(
      'text-tint-green-icon',
    );
    rostered.unmount();

    shiftApi({
      overrides: {
        'GET /v1/shifts/status': {
          json: shiftStatus({
            session: shiftSession({ scheduledStart: null, scheduledEnd: null }),
          }),
        },
      },
    });
    const offRoster = renderConsole(<ShiftChip expanded />);
    expect(iconOf(await screen.findByRole('link', { name: /^On shift/ }))).not.toContain('green');
    offRoster.unmount();

    shiftApi({
      overrides: {
        'GET /v1/shifts/status': {
          json: shiftStatus({ session: shiftSession({ late: true, lateMinutes: 12 }) }),
        },
      },
    });
    renderConsole(<ShiftChip expanded />);
    const late = iconOf(await screen.findByRole('link', { name: /Late 12m/ }));
    expect(late).toContain('text-tint-amber-icon');
    expect(late).not.toContain('green');
  });

  it('shows nothing for a customer, and nothing while the status cannot be read', async () => {
    shiftApi({ role: 'client' });
    const view = renderConsole(<ShiftChip expanded />);
    await vi.waitFor(() => {
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });
    view.unmount();

    shiftApi({ overrides: { 'GET /v1/shifts/status': apiError(500, 'unknown') } });
    renderConsole(<ShiftChip expanded />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
