import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { consoleApi } from '@/test/console-api';
import { makeAutonomy } from '@/test/console-fixtures';
import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { AiControlsPage } from './ai-controls-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/ai',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const AT = '2026-11-02T03:00:00.000Z';
const killOn = makeAutonomy({
  switches: [
    {
      key: 'ai_stage_cap_pinned',
      on: false,
      reason: '',
      changedBy: null,
      changedByName: null,
      changedAt: AT,
    },
    {
      key: 'ai_kill_switch',
      on: true,
      reason: 'provider outage',
      changedBy: '00000000-0000-4000-8000-000000000001',
      changedByName: 'Mana K.',
      changedAt: AT,
    },
  ],
});

const row = (title: string) =>
  screen.getByRole('heading', { name: title }).closest('li') as HTMLElement;

describe('AI controls', () => {
  it('shows both switches with their state in words, and who changed the last one and why', async () => {
    consoleApi({ autonomy: killOn });
    renderConsole(<AiControlsPage />);
    await screen.findByRole('heading', { name: 'Stop all AI runs' });
    const kill = row('Stop all AI runs');
    expect(kill).toHaveAttribute('data-on', 'true');
    expect(within(kill).getByText(/^On/)).toBeVisible();
    expect(within(kill).getByText(/Mana K\./)).toBeVisible();
    expect(within(kill).getByText(/provider outage/)).toBeVisible();
    expect(within(kill).getByRole('button', { name: /Turn off/ })).toBeVisible();
    const cap = row('Never let AI send on its own (cap at Stage 2)');
    expect(cap).toHaveAttribute('data-on', 'false');
    expect(within(cap).getByText('Off')).toBeVisible();
    expect(within(cap).getByRole('button', { name: /Turn on/ })).toBeVisible();
  });

  it('explains the stages in plain words', async () => {
    consoleApi();
    renderConsole(<AiControlsPage />);
    const legend = await screen.findByRole('region', { name: 'What the stages mean' });
    expect(within(legend).getByText(/Stage 0 · Observe/)).toBeVisible();
    expect(within(legend).getByText(/Stage 1 · Suggest/)).toBeVisible();
    expect(
      within(legend).getByText(/Stage 2 · Draft for approval: the AI drafts, a person sends/),
    ).toBeVisible();
    expect(within(legend).getByText(/Stage 3 · Sends on its own/)).toBeVisible();
  });

  it('flips the kill switch only after a reason is given, and records it', async () => {
    const user = userEvent.setup();
    const api = consoleApi({
      overrides: {
        'POST /v1/autonomy/switches': ({ body }) => ({
          json: {
            changed: true,
            switches: [
              {
                key: 'ai_stage_cap_pinned',
                on: false,
                reason: '',
                changedBy: null,
                changedByName: null,
                changedAt: AT,
              },
              {
                key: 'ai_kill_switch',
                on: (body as { on: boolean }).on,
                reason: (body as { reason: string }).reason,
                changedBy: null,
                changedByName: null,
                changedAt: AT,
              },
            ],
          },
        }),
      },
    });
    renderConsole(<AiControlsPage />);
    await screen.findByRole('heading', { name: 'Stop all AI runs' });
    await user.click(within(row('Stop all AI runs')).getByRole('button', { name: /Turn on/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Stop all AI runs?' });
    expect(
      within(dialog).getByText('Recorded in the audit log with your name and reason.'),
    ).toBeVisible();
    // The reason field has the focus, and the live counter starts at zero.
    const reason = within(dialog).getByLabelText(/Reason \(required, 3–500 characters\)/);
    expect(reason).toHaveFocus();
    expect(within(dialog).getByText('0/500')).toBeVisible();

    // Too short: nothing is sent and the field says why.
    await user.type(reason, 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Stop AI runs' }));
    expect(within(dialog).getByText('Give a reason of 3 to 500 characters.')).toBeVisible();
    expect(api.callsTo('/v1/autonomy/switches', 'POST')).toHaveLength(0);

    await user.type(reason, 'xx');
    await user.click(within(dialog).getByRole('button', { name: 'Stop AI runs' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/autonomy/switches', 'POST')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/autonomy/switches', 'POST')[0]?.body).toEqual({
      switch: 'ai_kill_switch',
      on: true,
      reason: 'xxx',
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Stop all AI runs?' })).not.toBeInTheDocument();
    });
  });

  it('asks for a reason in the other direction too, and Ctrl+Enter submits', async () => {
    const user = userEvent.setup();
    const api = consoleApi({
      autonomy: killOn,
      overrides: {
        'POST /v1/autonomy/switches': { json: { changed: true, switches: killOn.switches } },
      },
    });
    renderConsole(<AiControlsPage />);
    await screen.findByRole('heading', { name: 'Stop all AI runs' });
    await user.click(within(row('Stop all AI runs')).getByRole('button', { name: /Turn off/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Resume AI runs?' });
    await user.type(within(dialog).getByLabelText(/Reason/), 'provider is back');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => {
      expect(api.callsTo('/v1/autonomy/switches', 'POST')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/autonomy/switches', 'POST')[0]?.body).toEqual({
      switch: 'ai_kill_switch',
      on: false,
      reason: 'provider is back',
    });
  });

  it('turns the stage limit on and off with its own wording', async () => {
    const user = userEvent.setup();
    consoleApi();
    renderConsole(<AiControlsPage />);
    await screen.findByRole('heading', { name: 'Stop all AI runs' });
    await user.click(
      within(row('Never let AI send on its own (cap at Stage 2)')).getByRole('button', {
        name: /Turn on/,
      }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Limit all intents to Stage 2 or lower?',
    });
    expect(within(dialog).getByRole('button', { name: 'Turn on limit' })).toBeVisible();
    expect(within(dialog).getByText('It never raises a Stage 0 or 1 intent.')).toBeVisible();
  });

  it('closes with Escape without changing anything', async () => {
    const user = userEvent.setup();
    const api = consoleApi();
    renderConsole(<AiControlsPage />);
    await screen.findByRole('heading', { name: 'Stop all AI runs' });
    await user.click(within(row('Stop all AI runs')).getByRole('button', { name: /Turn on/ }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.callsTo('/v1/autonomy/switches', 'POST')).toHaveLength(0);
  });

  it('says so in the dialog when the server refuses', async () => {
    const user = userEvent.setup();
    consoleApi({ overrides: { 'POST /v1/autonomy/switches': apiError(403, 'forbidden') } });
    renderConsole(<AiControlsPage />);
    await screen.findByRole('heading', { name: 'Stop all AI runs' });
    await user.click(within(row('Stop all AI runs')).getByRole('button', { name: /Turn on/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason/), 'testing the denial');
    await user.click(within(dialog).getByRole('button', { name: 'Stop AI runs' }));
    expect(await within(dialog).findByText('You do not have permission to do this.')).toBeVisible();
  });

  it('shows a 400 about the reason next to the reason field', async () => {
    const user = userEvent.setup();
    consoleApi({ overrides: { 'POST /v1/autonomy/switches': apiError(400, 'validation_failed') } });
    renderConsole(<AiControlsPage />);
    await screen.findByRole('heading', { name: 'Stop all AI runs' });
    await user.click(within(row('Stop all AI runs')).getByRole('button', { name: /Turn on/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason/), 'long enough');
    await user.click(within(dialog).getByRole('button', { name: 'Stop AI runs' }));
    expect(await within(dialog).findByText('Give a reason of 3 to 500 characters.')).toBeVisible();
  });

  it('tells a lead who may look but not change', async () => {
    consoleApi({ role: 'lead', autonomy: killOn });
    renderConsole(<AiControlsPage />);
    await screen.findByRole('heading', { name: 'Stop all AI runs' });
    expect(screen.getByText('Only the head can change these.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Turn o/ })).not.toBeInTheDocument();
    // The state and the history are still there.
    expect(within(row('Stop all AI runs')).getByText(/provider outage/)).toBeVisible();
  });

  it('is closed to an agent', async () => {
    consoleApi({ role: 'agent' });
    renderConsole(<AiControlsPage />);
    expect(await screen.findByText('You don’t have access to this page.')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Stop all AI runs' })).not.toBeInTheDocument();
  });

  it('keeps its last state and offers a retry when the status cannot be loaded', async () => {
    const user = userEvent.setup();
    consoleApi({ overrides: { 'GET /v1/autonomy': apiError(500, 'unknown') } });
    renderConsole(<AiControlsPage />);
    expect(
      await screen.findByText('Couldn’t load AI status. The switches keep their last state.'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
  });

  it('shows how many intents sit at each stage and links to them, with no stage 3', async () => {
    consoleApi();
    renderConsole(<AiControlsPage />);
    const stages = await screen.findByRole('list', { name: 'Intents per stage' });
    expect(within(stages).getAllByRole('listitem').length).toBeGreaterThanOrEqual(3);
    // The plain legend names stage 3 as unavailable; the per-stage list never draws it.
    expect(within(stages).queryByText(/Stage 3/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Intents' })).toHaveAttribute('href', '/admin/intents');
    fireEvent.focus(stages);
  });
});
