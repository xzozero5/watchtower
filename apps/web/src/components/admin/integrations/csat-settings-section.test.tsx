import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CsatSettings } from '@watchtower/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { consoleApi } from '@/test/console-api';
import { apiError, type MockHandler } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { CsatSettingsSection, parseWhole } from './csat-settings-section';

const nav = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/integrations',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@watchtower/ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  toast: nav.toast,
}));

const SETTINGS: CsatSettings = {
  enabled: true,
  delayMinutes: 60,
  reminderHours: 48,
  cooldownDays: 7,
};

beforeEach(() => {
  nav.toast.mockClear();
});

function setup(
  overrides: Record<string, MockHandler> = {},
  role: 'head' | 'lead' | 'agent' = 'head',
) {
  const api = consoleApi({
    role,
    overrides: { 'GET /v1/csat/settings': { json: SETTINGS }, ...overrides },
  });
  renderConsole(<CsatSettingsSection />);
  return api;
}

describe('parseWhole', () => {
  it('accepts whole numbers in range and nothing else', () => {
    expect(parseWhole('0', 90)).toBe(0);
    expect(parseWhole(' 90 ', 90)).toBe(90);
    expect(parseWhole('91', 90)).toBeNull();
    expect(parseWhole('-1', 90)).toBeNull();
    expect(parseWhole('1.5', 90)).toBeNull();
    expect(parseWhole('', 90)).toBeNull();
  });
});

describe('CsatSettingsSection', () => {
  it('shows the current values and sends only what changed', async () => {
    const user = userEvent.setup();
    const api = setup({ 'PUT /v1/csat/settings': { json: { ...SETTINGS, delayMinutes: 120 } } });
    const delay = await screen.findByRole('textbox', { name: /Send after resolved/ });
    expect(delay).toHaveValue('60');
    expect(screen.getByRole('textbox', { name: /Remind after/ })).toHaveValue('48');
    expect(screen.getByRole('textbox', { name: /Quiet period/ })).toHaveValue('7');
    expect(screen.getByRole('checkbox', { name: /Send satisfaction surveys/ })).toBeChecked();

    await user.clear(delay);
    await user.type(delay, '120');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(api.callsTo('/v1/csat/settings', 'PUT')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/csat/settings', 'PUT')[0]?.body).toEqual({ delayMinutes: 120 });
    await waitFor(() => {
      expect(nav.toast).toHaveBeenCalledWith('Survey settings saved');
    });
  });

  it('turns surveys off and keeps 0 as a real value (no reminder, no limit)', async () => {
    const user = userEvent.setup();
    const api = setup({
      'PUT /v1/csat/settings': {
        json: { enabled: false, delayMinutes: 60, reminderHours: 0, cooldownDays: 0 },
      },
    });
    const reminder = await screen.findByRole('textbox', { name: /Remind after/ });
    await user.clear(reminder);
    await user.type(reminder, '0');
    const cooldown = screen.getByRole('textbox', { name: /Quiet period/ });
    await user.clear(cooldown);
    await user.type(cooldown, '0');
    await user.click(screen.getByRole('checkbox', { name: /Send satisfaction surveys/ }));
    expect(screen.getByText('Off: no survey is sent')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/csat/settings', 'PUT')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/csat/settings', 'PUT')[0]?.body).toEqual({
      enabled: false,
      reminderHours: 0,
      cooldownDays: 0,
    });
  });

  it('refuses a value out of range in words and sends nothing', async () => {
    const user = userEvent.setup();
    const api = setup();
    const cooldown = await screen.findByRole('textbox', { name: /Quiet period/ });
    await user.clear(cooldown);
    await user.type(cooldown, '91');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a whole number from 0 to 90.')).toBeVisible();
    expect(cooldown).toBeInvalid();
    expect(api.callsTo('/v1/csat/settings', 'PUT')).toHaveLength(0);
  });

  it('sends nothing when nothing changed', async () => {
    const user = userEvent.setup();
    const api = setup();
    await screen.findByRole('textbox', { name: /Send after resolved/ });
    expect(screen.getByText('Nothing to save')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.callsTo('/v1/csat/settings', 'PUT')).toHaveLength(0);
  });

  it('shows the api sentence when the change is refused', async () => {
    const user = userEvent.setup();
    setup({ 'PUT /v1/csat/settings': apiError(400, 'validation_failed', 'Delay is too long') });
    const delay = await screen.findByRole('textbox', { name: /Send after resolved/ });
    await user.clear(delay);
    await user.type(delay, '5');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Delay is too long')).toBeVisible();
    expect(nav.toast).not.toHaveBeenCalled();
  });

  it('has an error state with a retry', async () => {
    const user = userEvent.setup();
    let calls = 0;
    setup({
      'GET /v1/csat/settings': () => {
        calls += 1;
        return calls === 1 ? apiError(500, 'internal') : { json: SETTINGS };
      },
    });
    expect(await screen.findByText('Could not load the survey settings.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('textbox', { name: /Send after resolved/ })).toBeVisible();
  });

  it('is read-only for someone who can read but not manage integrations', async () => {
    setup({}, 'lead');
    const delay = await screen.findByRole('textbox', { name: /Send after resolved/ });
    expect(screen.getByText('You can see these settings but not change them.')).toBeVisible();
    expect(delay).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('shows nothing, and asks nothing, of someone without csat.read', async () => {
    const api = setup({}, 'agent');
    await waitFor(() => {
      expect(api.calls.length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('heading', { name: 'Satisfaction survey' })).not.toBeInTheDocument();
    expect(api.callsTo('/v1/csat/settings')).toHaveLength(0);
  });
});
