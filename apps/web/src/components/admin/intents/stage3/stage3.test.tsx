import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_ROLE_PERMISSIONS } from '@watchtower/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AutosendDisclosureCard } from '@/components/admin/ai/autosend-disclosure-card';
import { consoleApi } from '@/test/console-api';
import { makeAutonomy, PEOPLE } from '@/test/console-fixtures';
import { makeSession } from '@/test/fixtures';
import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';
import {
  makeGateReport,
  makePromotion,
  STAGE3_INTENT_ID,
  stage3Routes,
} from '@/test/stage3-fixtures';

import { IntentDetailPage } from '../intent-detail-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/intents/x',
}));

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const OWNER = makeSession('head', {
  permissions: [...DEFAULT_ROLE_PERMISSIONS.head, 'ai.autonomy.owner_approve'],
});
const LEAD = makeSession('lead');

type Routes = NonNullable<Parameters<typeof consoleApi>[0]>['overrides'];

function setup(
  options: {
    flag?: boolean;
    stage?: 2 | 3;
    report?: ReturnType<typeof makeGateReport> | null;
    open?: ReturnType<typeof makePromotion> | null;
    history?: ReturnType<typeof makePromotion>[];
    session?: ReturnType<typeof makeSession>;
    overrides?: Routes;
  } = {},
) {
  const base = makeAutonomy({ autosendFlag: options.flag ?? true });
  const autonomy = {
    ...base,
    intents: base.intents.map((intent) =>
      intent.id === STAGE3_INTENT_ID
        ? {
            ...intent,
            stage: options.stage ?? 2,
            effectiveStage: options.stage ?? 2,
            autosend: {
              shadow: true,
              minScore: 0.9,
              dailyCap: 20,
              policy: { channels: ['portal' as const], action: 'reply' as const, maxChars: 1200 },
            },
          }
        : intent,
    ),
  };
  return consoleApi({
    autonomy,
    overrides: {
      ...(options.session ? { 'GET /v1/auth/session': { json: options.session } } : {}),
      ...stage3Routes({
        flag: options.flag ?? true,
        report: options.report,
        open: options.open,
        history: options.history,
      }),
      ...options.overrides,
    },
  });
}

async function openStage3(user: ReturnType<typeof userEvent.setup>) {
  renderConsole(<IntentDetailPage intentId={STAGE3_INTENT_ID} />);
  await user.click(await screen.findByRole('tab', { name: 'Stage 3' }));
}

const askButton = () => screen.getByRole('button', { name: 'Ask the owner for Stage 3' });

describe('Stage 3 tab: the button to ask', () => {
  it('is off with the reason in words when the instance has auto-send switched off', async () => {
    const user = userEvent.setup();
    setup({ flag: false });
    await openStage3(user);
    await screen.findByRole('heading', { name: 'Gate report' });
    expect(askButton()).toBeDisabled();
    expect(
      screen.getByText(/switched off for this instance\. The owner turns it on/),
    ).toBeVisible();
    expect(askButton()).toHaveAccessibleDescription(/switched off for this instance/);
  });

  it('is off while the latest report is red', async () => {
    const user = userEvent.setup();
    setup({ report: makeGateReport('red') });
    await openStage3(user);
    await screen.findByRole('heading', { name: 'Gate report' });
    expect(askButton()).toBeDisabled();
    expect(
      screen.getByText('The latest gate report is red. Every check must pass before you can ask.'),
    ).toBeVisible();
  });

  it('is off when there is not enough data', async () => {
    const user = userEvent.setup();
    setup({ report: makeGateReport('insufficient_data') });
    await openStage3(user);
    await screen.findByRole('heading', { name: 'Gate report' });
    expect(askButton()).toBeDisabled();
    expect(screen.getByText(/not enough data yet/)).toBeVisible();
  });

  it('is off with no report, and the report can be made on demand', async () => {
    const user = userEvent.setup();
    const api = setup({
      report: null,
      overrides: {
        'POST /v1/intents/:id/autonomy/gate-reports': { json: makeGateReport('green') },
      },
    });
    await openStage3(user);
    expect(await screen.findByText('There is no gate report yet. Make one below.')).toBeVisible();
    expect(askButton()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Make a report now' }));
    await waitFor(() => {
      expect(
        api.callsTo(`/v1/intents/${STAGE3_INTENT_ID}/autonomy/gate-reports`, 'POST'),
      ).toHaveLength(1);
    });
  });

  it('is on with a green report, and sends the report id and the reason', async () => {
    const user = userEvent.setup();
    const api = setup({
      overrides: { 'POST /v1/intents/:id/autonomy/promotions': { json: makePromotion() } },
    });
    await openStage3(user);
    await screen.findByRole('heading', { name: 'Gate report' });
    expect(askButton()).toBeEnabled();
    await user.click(askButton());
    const dialog = await screen.findByRole('dialog', {
      name: 'Ask the owner to move this intent to Stage 3',
    });
    const send = within(dialog).getByRole('button', { name: 'Send the request' });
    expect(send).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Reason/), 'Four weeks green');
    await user.click(send);
    await waitFor(() => {
      expect(
        api.callsTo(`/v1/intents/${STAGE3_INTENT_ID}/autonomy/promotions`, 'POST')[0]?.body,
      ).toEqual({ gateReportId: makeGateReport().id, reason: 'Four weeks green' });
    });
  });

  it('is not drawn for a lead, who can read but not ask', async () => {
    const user = userEvent.setup();
    setup({ session: LEAD });
    await openStage3(user);
    await screen.findByRole('heading', { name: 'Gate report' });
    expect(screen.queryByRole('button', { name: 'Ask the owner for Stage 3' })).toBeNull();
    expect(screen.getByText(/You can read this but not change it/)).toBeVisible();
  });
});

describe('Stage 3 tab: the gate report', () => {
  it('shows every check with its result in words, value, limit and where the limit comes from', async () => {
    const user = userEvent.setup();
    setup({
      report: makeGateReport('red', {
        criteria: [
          { key: 'reopen_rate', pass: false, value: 0.2, threshold: 0.1, basis: 'PRD' },
          { key: 'shadow_precision', pass: null, value: null, threshold: 0.9, basis: 'ASSUMED' },
          { key: 'csat_parity', pass: true, value: 4.5, threshold: 4.2, basis: 'ASSUMED' },
          { key: 'redaction_eval', pass: null, value: 'not_measured', threshold: 'pass' },
        ],
      }),
    });
    await openStage3(user);
    const table = await screen.findByRole('table', { name: 'Checks of the gate report' });
    const row = (key: string) => table.querySelector(`tr[data-criterion="${key}"]`) as HTMLElement;
    expect(within(row('reopen_rate')).getByText('Fail')).toBeVisible();
    expect(within(row('reopen_rate')).getByText('20%')).toBeVisible();
    expect(within(row('reopen_rate')).getByText('10%')).toBeVisible();
    expect(within(row('reopen_rate')).getByText('PRD')).toBeVisible();
    expect(within(row('shadow_precision')).getByText('Not known yet')).toBeVisible();
    expect(within(row('shadow_precision')).getByText('ASSUMED')).toBeVisible();
    expect(within(row('csat_parity')).getByText('Pass')).toBeVisible();
    expect(within(row('redaction_eval')).getByText('Not measured here')).toBeVisible();
    expect(screen.getByText('Red · a check fails')).toBeVisible();
  });

  it('shows the shadow numbers', async () => {
    const user = userEvent.setup();
    setup();
    await openStage3(user);
    const shadow = (await screen.findByRole('heading', { name: 'Shadow results' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(shadow).getByText('94%')).toBeVisible();
    expect(within(shadow).getByText('60')).toBeVisible();
  });

  it('says so when the report cannot be loaded, and retries', async () => {
    const user = userEvent.setup();
    setup({ overrides: { 'GET /v1/intents/:id/autonomy/gate-reports': apiError(500, 'unknown') } });
    await openStage3(user);
    expect(await screen.findByText('Could not load Stage 3 for this intent.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

describe('Stage 3 tab: settings', () => {
  it('saves the changed settings with a reason', async () => {
    const user = userEvent.setup();
    const api = setup({
      overrides: {
        'PUT /v1/intents/:id/autonomy/autosend': {
          json: {
            changed: true,
            autosend: {
              shadow: false,
              minScore: 0.9,
              dailyCap: 20,
              policy: { channels: ['portal', 'gmail'], action: 'reply', maxChars: 1200 },
            },
          },
        },
      },
    });
    await openStage3(user);
    await user.click(await screen.findByRole('checkbox', { name: 'Email (Gmail)' }));
    await user.click(screen.getByRole('checkbox', { name: /Shadow mode/ }));
    const save = screen.getByRole('button', { name: 'Save settings' });
    expect(save).toBeDisabled();
    await user.type(
      screen.getByLabelText(/Reason \(3 to 500 characters\)\. It is kept/),
      'Shadow looks right',
    );
    await user.click(save);
    await waitFor(() => {
      expect(
        api.callsTo(`/v1/intents/${STAGE3_INTENT_ID}/autonomy/autosend`, 'PUT')[0]?.body,
      ).toEqual({
        shadow: false,
        minScore: 0.9,
        dailyCap: 20,
        policy: { channels: ['portal', 'gmail'], action: 'reply', maxChars: 1200 },
        reason: 'Shadow looks right',
      });
    });
  });

  it('refuses a score outside 0.70 to 1.00 before it is sent', async () => {
    const user = userEvent.setup();
    const api = setup();
    await openStage3(user);
    const score = await screen.findByLabelText(/Lowest grade that may go out/);
    await user.clear(score);
    await user.type(score, '0.5');
    expect(screen.getByText(/outside the allowed range/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
    expect(api.callsTo(`/v1/intents/${STAGE3_INTENT_ID}/autonomy/autosend`, 'PUT')).toHaveLength(0);
  });

  it('is read-only for a lead', async () => {
    const user = userEvent.setup();
    setup({ session: LEAD });
    await openStage3(user);
    expect(await screen.findByText('Only the head can change these settings.')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /Shadow mode/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
  });
});

describe('Stage 3 tab: the owner decides', () => {
  const requested = makePromotion('requested', { requestedBy: PEOPLE.mana.id });

  it('asks the owner to type the key of the intent, then sends it', async () => {
    const user = userEvent.setup();
    const api = setup({
      session: OWNER,
      open: requested,
      overrides: {
        'POST /v1/autonomy/promotions/:promotionId/decide': {
          json: { status: 'approved', selfApproved: false },
        },
      },
    });
    await openStage3(user);
    await user.click(await screen.findByRole('button', { name: 'Approve…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve Stage 3 for billing' });
    const submit = within(dialog).getByRole('button', { name: 'Approve' });
    await user.type(within(dialog).getByLabelText(/Reason/), 'Reviewed the report');
    await user.type(within(dialog).getByLabelText(/Type the key of the intent/), 'bill');
    expect(within(dialog).getByText('The key does not match.')).toBeVisible();
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Type the key of the intent/), 'ing');
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => {
      expect(
        api.callsTo(`/v1/autonomy/promotions/${requested.id}/decide`, 'POST')[0]?.body,
      ).toEqual({ approve: true, reason: 'Reviewed the report', confirmKey: 'billing' });
    });
  });

  it('sends the person to sign in again on reauth_required and keeps the way back', async () => {
    const user = userEvent.setup();
    const api = setup({
      session: OWNER,
      open: requested,
      overrides: {
        'POST /v1/autonomy/promotions/:promotionId/decide': apiError(
          403,
          'reauth_required',
          'Sign in again to approve a promotion',
        ),
        'POST /v1/auth/logout': { status: 204 },
      },
    });
    await openStage3(user);
    await user.click(await screen.findByRole('button', { name: 'Approve…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve Stage 3 for billing' });
    await user.type(within(dialog).getByLabelText(/Reason/), 'Reviewed the report');
    await user.type(within(dialog).getByLabelText(/Type the key of the intent/), 'billing');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/auth/logout', 'POST')).toHaveLength(1);
    });
    expect(window.location.pathname + window.location.search).toBe(
      `/admin/intents/${STAGE3_INTENT_ID}?tab=stage3&approve=${requested.id}`,
    );
  });

  it('opens the same dialog again when the owner comes back from signing in', async () => {
    window.history.replaceState(
      null,
      '',
      `/admin/intents/${STAGE3_INTENT_ID}?tab=stage3&approve=${requested.id}`,
    );
    setup({ session: OWNER, open: requested });
    renderConsole(<IntentDetailPage intentId={STAGE3_INTENT_ID} />);
    expect(
      await screen.findByRole('dialog', { name: 'Approve Stage 3 for billing' }),
    ).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Stage 3', hidden: true })).toHaveAttribute(
      'data-state',
      'active',
    );
  });

  it('shows a head that only the owner approves, and no approve button', async () => {
    const user = userEvent.setup();
    setup({ open: requested });
    await openStage3(user);
    expect(
      await screen.findByText(/Waiting for the owner\. Only the owner can approve\./),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve…' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeVisible();
  });

  it('applies an approved request, and marks one the owner approved for themselves', async () => {
    const user = userEvent.setup();
    const approved = makePromotion('approved', {
      requestedBy: OWNER.user.id,
      decidedBy: OWNER.user.id,
      decidedByName: 'Alex',
      decidedAt: '2026-11-02T03:00:00.000Z',
      decisionReason: 'ok',
      selfApproved: true,
    });
    const api = setup({
      session: OWNER,
      open: approved,
      overrides: {
        'POST /v1/autonomy/promotions/:promotionId/apply': { json: { status: 'applied' } },
      },
    });
    await openStage3(user);
    expect(await screen.findByText('Approved by the same person who asked')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Apply: move to Stage 3' }));
    await waitFor(() => {
      expect(api.callsTo(`/v1/autonomy/promotions/${approved.id}/apply`, 'POST')).toHaveLength(1);
    });
  });

  it('keeps Apply off while auto-send is switched off, and says why', async () => {
    const user = userEvent.setup();
    setup({
      flag: false,
      session: OWNER,
      open: makePromotion('approved'),
    });
    await openStage3(user);
    expect(await screen.findByRole('button', { name: 'Apply: move to Stage 3' })).toBeDisabled();
  });
});

describe('Admin AI: the notice on automatic replies', () => {
  it('shows the stored text and saves a change with a reason', async () => {
    const user = userEvent.setup();
    const api = consoleApi({
      overrides: {
        'PUT /v1/autonomy/disclosure': {
          json: { enabled: false, text: { th: 'ข้อความไทย', en: 'English text' } },
        },
      },
    });
    renderConsole(<AutosendDisclosureCard />);
    const th = await screen.findByLabelText('Notice in Thai');
    expect(th).toHaveValue(
      'ข้อความนี้ส่งโดยระบบอัตโนมัติ (AI) หากต้องการคุยกับเจ้าหน้าที่ ตอบกลับข้อความนี้ได้เลย',
    );
    await user.clear(th);
    await user.type(th, 'ข้อความไทย');
    await user.clear(screen.getByLabelText('Notice in English'));
    await user.type(screen.getByLabelText('Notice in English'), 'English text');
    await user.click(screen.getByRole('checkbox', { name: 'Add the notice to automatic replies' }));
    await user.type(
      screen.getByLabelText(/Reason \(3 to 500 characters\)\. It is kept in the audit/),
      'Wording',
    );
    await user.click(screen.getByRole('button', { name: 'Save notice' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/autonomy/disclosure', 'PUT')[0]?.body).toEqual({
        enabled: false,
        text: { th: 'ข้อความไทย', en: 'English text' },
        reason: 'Wording',
      });
    });
  });

  it('is read-only for a lead', async () => {
    consoleApi({ role: 'lead' });
    renderConsole(<AutosendDisclosureCard />);
    expect(await screen.findByText('Only the head can change the notice.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save notice' })).toBeNull();
  });
});
