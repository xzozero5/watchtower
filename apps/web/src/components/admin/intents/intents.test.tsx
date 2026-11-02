import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { consoleApi } from '@/test/console-api';
import { FULL_INTENTS, makeAutonomy } from '@/test/console-fixtures';
import { uuid } from '@/test/fixtures';
import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { IntentDetailPage } from './intent-detail-page';
import { IntentsPage } from './intents-page';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/intents',
}));

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

const AT = '2026-11-02T03:00:00.000Z';
const LOGIN = uuid(700); // stage 1
const WEBHOOK = uuid(702); // stage 2, pinned in the fixture

const changeResult = (stage: number) => ({
  json: {
    changed: true,
    intent: {
      id: LOGIN,
      key: 'login_issue',
      name: 'login issue',
      isActive: true,
      stage,
      effectiveStage: stage,
      pinned: false,
      updatedAt: AT,
    },
  },
});

async function openAutonomy(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('tab', { name: 'Autonomy' }));
}

describe('Intents list', () => {
  it('shows each intent with its priority, stage and pin', async () => {
    consoleApi();
    renderConsole(<IntentsPage />);
    const table = await screen.findByRole('table', { name: 'Intents' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    const login = rows.find((r) => within(r).queryByText('login_issue')) as HTMLElement;
    expect(within(login).getByText('Stage 1 · Suggest')).toBeVisible();
    const webhook = rows.find((r) => within(r).queryByText('webhook_not_received')) as HTMLElement;
    expect(within(webhook).getByText('Pinned')).toBeVisible();
    expect(within(login).getByRole('link', { name: 'Login issue' })).toHaveAttribute(
      'href',
      `/admin/intents/${LOGIN}`,
    );
  });

  it('opens an intent with Enter on its row', async () => {
    const user = userEvent.setup();
    consoleApi();
    renderConsole(<IntentsPage />);
    const table = await screen.findByRole('table', { name: 'Intents' });
    within(table).getAllByRole('row')[1]?.focus();
    await user.keyboard('{Enter}');
    expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/admin\/intents\//));
  });

  it('filters by name or key', async () => {
    const user = userEvent.setup();
    consoleApi();
    renderConsole(<IntentsPage />);
    await screen.findByRole('table', { name: 'Intents' });
    await user.type(screen.getByRole('searchbox', { name: 'Filter' }), 'webhook');
    expect(screen.getAllByRole('row')).toHaveLength(2);
    await user.clear(screen.getByRole('searchbox', { name: 'Filter' }));
    await user.type(screen.getByRole('searchbox', { name: 'Filter' }), 'zzz');
    expect(await screen.findByText('Nothing matches.')).toBeVisible();
  });

  it('shows an empty-state hint and a New intent button when there are none', async () => {
    consoleApi({ overrides: { 'GET /v1/intents': { json: { intents: [] } } } });
    renderConsole(<IntentsPage />);
    expect(await screen.findByText('No intents yet.')).toBeVisible();
    expect(screen.getByText(/Use "New intent" to add the first one/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'New intent' })).toBeVisible();
  });

  it('creates an intent with a key, validates the key, and opens it', async () => {
    const user = userEvent.setup();
    const api = consoleApi({
      overrides: {
        'POST /v1/intents': { status: 201, json: { ...FULL_INTENTS[0], id: uuid(799) } },
      },
    });
    renderConsole(<IntentsPage />);
    await screen.findByRole('table', { name: 'Intents' });
    await user.click(screen.getByRole('button', { name: 'New intent' }));
    const sheet = await screen.findByRole('dialog', { name: 'New intent' });
    expect(within(sheet).getByText(/Starts at Stage 2/)).toBeVisible();
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(within(sheet).getByText('Required.')).toBeVisible();
    await user.type(within(sheet).getByLabelText('Name'), 'Payment failed');
    await user.type(within(sheet).getByLabelText('Key'), 'Bad Key');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(within(sheet).getByText(/Use lowercase letters, digits and underscores/)).toBeVisible();
    expect(api.callsTo('/v1/intents', 'POST')).toHaveLength(0);
    await user.clear(within(sheet).getByLabelText('Key'));
    await user.type(within(sheet).getByLabelText('Key'), 'payment_failed');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/intents', 'POST')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/intents', 'POST')[0]?.body).toEqual({
      key: 'payment_failed',
      name: 'Payment failed',
      description: '',
    });
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(`/admin/intents/${uuid(799)}`);
    });
  });

  it('shows the api error when the key is taken', async () => {
    const user = userEvent.setup();
    consoleApi({
      overrides: { 'POST /v1/intents': apiError(409, 'conflict', 'The key login_issue is taken') },
    });
    renderConsole(<IntentsPage />);
    await screen.findByRole('table', { name: 'Intents' });
    await user.click(screen.getByRole('button', { name: 'New intent' }));
    const sheet = await screen.findByRole('dialog', { name: 'New intent' });
    await user.type(within(sheet).getByLabelText('Name'), 'Login issue');
    await user.type(within(sheet).getByLabelText('Key'), 'login_issue');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(await within(sheet).findByText(/The key login_issue is taken/)).toBeVisible();
    expect(push).not.toHaveBeenCalled();
  });

  it('is closed to an agent', async () => {
    consoleApi({ role: 'agent' });
    renderConsole(<IntentsPage />);
    expect(await screen.findByText('You don’t have access to this page.')).toBeVisible();
  });
});

describe('Intent autonomy control', () => {
  it('offers stages 0, 1 and 2 and never anything above', async () => {
    const user = userEvent.setup();
    consoleApi();
    renderConsole(<IntentDetailPage intentId={LOGIN} />);
    await openAutonomy(user);
    const group = await screen.findByRole('radiogroup', { name: 'Stage' });
    const options = within(group).getAllByRole('radio');
    expect(options.map((o) => o.textContent)).toEqual([
      'Stage 0 · Observe',
      'Stage 1 · Suggest',
      'Stage 2 · Draft for approval',
    ]);
    expect(screen.queryByRole('radio', { name: /Stage 3/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.getByText(/Stage 3 and above is the owner’s decision/)).toBeVisible();
  });

  it('changes stage 1 to 2 only with a reason, and sends exactly that', async () => {
    const user = userEvent.setup();
    const api = consoleApi({
      overrides: { [`POST /v1/intents/${LOGIN}/autonomy`]: changeResult(2) },
    });
    renderConsole(<IntentDetailPage intentId={LOGIN} />);
    await openAutonomy(user);
    const group = await screen.findByRole('radiogroup', { name: 'Stage' });
    // Nothing to save until a different stage is chosen.
    expect(screen.queryByRole('button', { name: 'Change stage' })).not.toBeInTheDocument();
    await user.click(within(group).getByRole('radio', { name: 'Stage 2 · Draft for approval' }));
    const button = screen.getByRole('button', { name: 'Change stage' });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText('Reason (required)'), 'eval run passed');
    expect(button).toBeEnabled();
    await user.click(button);
    await waitFor(() => {
      expect(api.callsTo(`/v1/intents/${LOGIN}/autonomy`, 'POST')).toHaveLength(1);
    });
    expect(api.callsTo(`/v1/intents/${LOGIN}/autonomy`, 'POST')[0]?.body).toEqual({
      stage: 2,
      reason: 'eval run passed',
    });
  });

  it('can only go down while the stage limit is on', async () => {
    const user = userEvent.setup();
    consoleApi({
      autonomy: makeAutonomy({
        switches: [
          {
            key: 'ai_stage_cap_pinned',
            on: true,
            reason: 'eval regression',
            changedBy: null,
            changedByName: null,
            changedAt: AT,
          },
          {
            key: 'ai_kill_switch',
            on: false,
            reason: '',
            changedBy: null,
            changedByName: null,
            changedAt: AT,
          },
        ],
      }),
    });
    renderConsole(<IntentDetailPage intentId={LOGIN} />);
    await openAutonomy(user);
    const group = await screen.findByRole('radiogroup', { name: 'Stage' });
    expect(
      within(group).getByRole('radio', { name: 'Stage 2 · Draft for approval' }),
    ).toBeDisabled();
    expect(within(group).getByRole('radio', { name: 'Stage 0 · Observe' })).toBeEnabled();
    expect(screen.getByText('Stage limit is on — stages can only go down.')).toBeVisible();
  });

  it('locks a pinned intent and says who pinned it', async () => {
    const user = userEvent.setup();
    consoleApi({
      overrides: {
        [`GET /v1/intents/${WEBHOOK}/autonomy/history`]: {
          json: {
            items: [
              {
                id: uuid(1101),
                intentId: WEBHOOK,
                change: 'pin',
                fromStage: 2,
                toStage: 2,
                pinned: true,
                reason: 'freeze for the audit',
                changedBy: uuid(910),
                changedByName: 'Mana',
                changedAt: AT,
              },
            ],
            nextCursor: null,
          },
        },
      },
    });
    renderConsole(<IntentDetailPage intentId={WEBHOOK} />);
    await openAutonomy(user);
    const group = await screen.findByRole('radiogroup', { name: 'Stage' });
    for (const option of within(group).getAllByRole('radio')) expect(option).toBeDisabled();
    expect(await screen.findByText(/Pinned by Mana on .* — unpin to change/)).toBeVisible();
  });

  it('lets the head pin with a reason of its own', async () => {
    const user = userEvent.setup();
    const api = consoleApi({
      overrides: {
        [`POST /v1/intents/${LOGIN}/autonomy`]: {
          json: {
            changed: true,
            intent: {
              id: LOGIN,
              key: 'login_issue',
              name: 'login issue',
              isActive: true,
              stage: 1,
              effectiveStage: 1,
              pinned: true,
              updatedAt: AT,
            },
          },
        },
      },
    });
    renderConsole(<IntentDetailPage intentId={LOGIN} />);
    await openAutonomy(user);
    await user.click(
      await screen.findByRole('checkbox', {
        name: 'Pin this stage — nobody can change it until unpinned',
      }),
    );
    await user.type(screen.getByLabelText('Reason (required)'), 'freeze for the audit');
    await user.click(screen.getByRole('button', { name: 'Pin' }));
    await waitFor(() => {
      expect(api.callsTo(`/v1/intents/${LOGIN}/autonomy`, 'POST')).toHaveLength(1);
    });
    expect(api.callsTo(`/v1/intents/${LOGIN}/autonomy`, 'POST')[0]?.body).toEqual({
      pinned: true,
      reason: 'freeze for the audit',
    });
  });

  it('shows a lead the pin as text and no pin checkbox', async () => {
    const user = userEvent.setup();
    consoleApi({ role: 'lead' });
    renderConsole(<IntentDetailPage intentId={WEBHOOK} />);
    await openAutonomy(user);
    await screen.findByRole('radiogroup', { name: 'Stage' });
    expect(screen.queryByRole('checkbox', { name: /Pin this stage/ })).not.toBeInTheDocument();
    expect(screen.getAllByText('Pinned').length).toBeGreaterThan(0);
  });

  it('explains a 409 with the api’s own sentence', async () => {
    const user = userEvent.setup();
    consoleApi({
      overrides: {
        [`POST /v1/intents/${LOGIN}/autonomy`]: apiError(409, 'conflict', 'The intent is pinned'),
      },
    });
    renderConsole(<IntentDetailPage intentId={LOGIN} />);
    await openAutonomy(user);
    const group = await screen.findByRole('radiogroup', { name: 'Stage' });
    await user.click(within(group).getByRole('radio', { name: 'Stage 0 · Observe' }));
    await user.type(screen.getByLabelText('Reason (required)'), 'nobody reads this');
    await user.click(screen.getByRole('button', { name: 'Change stage' }));
    expect(await screen.findByText('The intent is pinned')).toBeVisible();
  });

  it('maps autonomy_stage_requires_owner to the owner-only explanation', async () => {
    const user = userEvent.setup();
    consoleApi({
      overrides: {
        [`POST /v1/intents/${LOGIN}/autonomy`]: apiError(403, 'autonomy_stage_requires_owner'),
      },
    });
    renderConsole(<IntentDetailPage intentId={LOGIN} />);
    await openAutonomy(user);
    const group = await screen.findByRole('radiogroup', { name: 'Stage' });
    await user.click(within(group).getByRole('radio', { name: 'Stage 2 · Draft for approval' }));
    await user.type(screen.getByLabelText('Reason (required)'), 'trying anyway');
    await user.click(screen.getByRole('button', { name: 'Change stage' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Stage 3 and above is the owner’s decision');
  });

  it('shows the history to a lead and says it is for the head when the api refuses', async () => {
    const user = userEvent.setup();
    consoleApi({ role: 'lead' });
    const { unmount } = renderConsole(<IntentDetailPage intentId={LOGIN} />);
    await user.click(await screen.findByRole('tab', { name: 'History' }));
    expect(
      await screen.findByText('Stage 1 · Suggest → Stage 2 · Draft for approval'),
    ).toBeVisible();
    expect(screen.getByText(/eval run passed/)).toBeVisible();
    unmount();

    consoleApi({
      role: 'lead',
      overrides: { [`GET /v1/intents/${LOGIN}/autonomy/history`]: apiError(403, 'forbidden') },
    });
    renderConsole(<IntentDetailPage intentId={LOGIN} />);
    await user.click(await screen.findByRole('tab', { name: 'History' }));
    expect(await screen.findByText('History is visible to the head.')).toBeVisible();
  });

  it('edits the details of an intent', async () => {
    const user = userEvent.setup();
    const api = consoleApi({
      overrides: { [`PATCH /v1/intents/${LOGIN}`]: { json: FULL_INTENTS[0] } },
    });
    renderConsole(<IntentDetailPage intentId={LOGIN} />);
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Sign-in problem');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(api.callsTo(`/v1/intents/${LOGIN}`, 'PATCH')).toHaveLength(1);
    });
    expect(api.callsTo(`/v1/intents/${LOGIN}`, 'PATCH')[0]?.body).toMatchObject({
      name: 'Sign-in problem',
      defaultPriority: 'P2',
      isActive: true,
    });
  });

  it('says an intent that does not exist is not found', async () => {
    consoleApi();
    renderConsole(<IntentDetailPage intentId={uuid(999)} />);
    expect(await screen.findByText('Intent not found.')).toBeVisible();
  });
});
