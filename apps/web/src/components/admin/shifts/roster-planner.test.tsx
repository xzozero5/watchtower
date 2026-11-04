import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiError, type MockHandler } from '@/test/mock-api';
import {
  brokenPlan,
  PLAN_ID,
  plan,
  planDefaults,
  shortPlan,
  WEEK,
} from '@/test/roster-plan-fixtures';
import { renderConsole } from '@/test/render-console';
import { shiftApi } from '@/test/shift-api';
import { WHO } from '@/test/shift-fixtures';

import { ShiftsAdminPage } from './shifts-admin-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/shifts',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const summary = (id = PLAN_ID, status: 'draft' | 'applied' = 'draft') => ({
  id,
  weekStart: WEEK,
  status,
  entryCount: 3,
  createdAt: '2026-11-02T03:00:00.000Z',
  appliedAt: null,
});

const plannerApi = (extra: Record<string, MockHandler> = {}, role: 'lead' | 'agent' = 'lead') =>
  shiftApi({
    role,
    overrides: {
      'GET /v1/roster/plans': { json: { plans: [] } },
      'GET /v1/roster/plans/defaults': { json: planDefaults() },
      ...extra,
    },
  });

async function toPlanner() {
  const user = userEvent.setup();
  renderConsole(<ShiftsAdminPage />);
  await user.click(await screen.findByRole('tab', { name: 'Planner' }));
  return user;
}

describe('the roster planner tab', () => {
  it('is not offered to an agent (the page is for lead and head)', async () => {
    plannerApi({}, 'agent');
    renderConsole(<ShiftsAdminPage />);
    expect(await screen.findByText(/You don’t have access to this page/)).toBeVisible();
    expect(screen.queryByRole('tab', { name: 'Planner' })).toBeNull();
  });

  it('starts a plan from what the server suggests, with leave, and sends the coverage only when it was edited', async () => {
    const api = plannerApi({
      'POST /v1/roster/plans': { status: 201, json: plan() },
      [`GET /v1/roster/plans/${PLAN_ID}`]: { json: plan() },
    });
    const user = await toPlanner();
    const form = await screen.findByRole('form', { name: 'Plan a week' });
    expect(within(form).getByLabelText('Rest between shifts (hours)')).toHaveValue(11);
    expect(within(form).getByLabelText('Day (08:00–17:00)')).toHaveValue(2);
    expect(within(form).getByText(/A guess from the tickets of the past 4 weeks/)).toBeVisible();

    await user.selectOptions(within(form).getByRole('combobox', { name: 'Person' }), WHO.pim.id);
    await user.type(within(form).getByLabelText('Date'), '2026-11-11');
    await user.click(within(form).getByRole('button', { name: 'Add leave' }));
    expect(within(form).getByText(/Pim S\. · 2026-11-11/)).toBeVisible();

    await user.click(within(form).getByRole('button', { name: 'Make the draft plan' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/roster/plans', 'POST')).toHaveLength(1);
    });
    const body = api.callsTo('/v1/roster/plans', 'POST')[0]?.body as Record<string, unknown>;
    expect(body.coverage).toBeUndefined();
    expect(typeof body.weekStart).toBe('string');
    expect(String(body.weekStart)).toHaveLength(10);
    expect(body.unavailable).toEqual([{ userId: WHO.pim.id, dates: ['2026-11-11'] }]);
    expect(body.rules).toEqual({
      minRestHours: 11,
      maxShiftsPerWeek: 5,
      maxConsecutiveDays: 6,
      maxConsecutiveNights: 3,
    });
    expect(
      await screen.findByRole('region', { name: 'Plan for the week of 2026-11-09' }),
    ).toBeVisible();
  });

  it('sends the lead’s own coverage once a number is changed', async () => {
    const api = plannerApi({
      'POST /v1/roster/plans': { status: 201, json: plan() },
      [`GET /v1/roster/plans/${PLAN_ID}`]: { json: plan() },
    });
    const user = await toPlanner();
    const form = await screen.findByRole('form', { name: 'Plan a week' });
    const day = within(form).getByLabelText('Day (08:00–17:00)');
    await user.clear(day);
    await user.type(day, '3');
    expect(within(form).getByText('Your numbers are used on every day of the week.')).toBeVisible();
    await user.click(within(form).getByRole('button', { name: 'Make the draft plan' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/roster/plans', 'POST')).toHaveLength(1);
    });
    const body = api.callsTo('/v1/roster/plans', 'POST')[0]?.body as {
      coverage: { required: number }[];
    };
    expect(body.coverage.map((rule) => rule.required)).toEqual([3, 1]);
  });

  it('refuses a plan with nobody picked', async () => {
    const api = plannerApi({});
    const user = await toPlanner();
    const form = await screen.findByRole('form', { name: 'Plan a week' });
    for (const box of within(form).getAllByRole('checkbox')) await user.click(box);
    await user.click(within(form).getByRole('button', { name: 'Make the draft plan' }));
    expect(await within(form).findByText('Pick at least one person.')).toBeVisible();
    expect(api.callsTo('/v1/roster/plans', 'POST')).toHaveLength(0);
  });
});

describe('a plan', () => {
  const withPlan = (value = plan(), extra: Record<string, MockHandler> = {}) =>
    plannerApi({
      'GET /v1/roster/plans': { json: { plans: [summary()] } },
      [`GET /v1/roster/plans/${PLAN_ID}`]: { json: value },
      ...extra,
    });

  async function openPlan() {
    const user = await toPlanner();
    await user.click(
      await screen.findByRole('button', { name: 'Open the plan for the week of 2026-11-09' }),
    );
    return {
      user,
      view: await screen.findByRole('region', { name: 'Plan for the week of 2026-11-09' }),
    };
  }

  it('shows the week as a table, the constraint report, and the load per person', async () => {
    withPlan();
    const { view } = await openPlan();
    expect(within(view).getByText('Every shift has the people it needs.')).toBeVisible();
    const grid = within(view).getByRole('table', { name: 'Plan for the week of 2026-11-09' });
    expect(within(grid).getAllByRole('columnheader')).toHaveLength(8);
    const dayRow = within(grid).getByRole('row', { name: /Day/ });
    expect(dayRow).toHaveTextContent('Mana K.');
    expect(dayRow).toHaveTextContent('Pim S.');
    const report = within(view).getByRole('region', { name: 'Constraint report' });
    expect(within(report).getAllByRole('listitem').length).toBeGreaterThanOrEqual(8);
    expect(within(view).getByRole('table', { name: 'Load per person' })).toHaveTextContent(
      'Dao N.',
    );
  });

  it('says why a shift is short, and what the program proved', async () => {
    withPlan(shortPlan());
    const { view } = await openPlan();
    expect(
      within(view).getByText('No plan can give every shift the people it needs.'),
    ).toBeVisible();
    expect(
      within(view).getByText('The program searched everything: this is the best plan it found.'),
    ).toBeVisible();
    expect(
      within(view).getByText(
        /Tue, Nov 10, Day: 1 of 2 people; others could not be added: on leave 2/,
      ),
    ).toBeVisible();
  });

  it('takes a person off by hand and shows the plan as the server checked it again', async () => {
    const after = plan({ entries: plan().entries.slice(1) });
    const api = withPlan(plan(), {
      [`PATCH /v1/roster/plans/${PLAN_ID}/entries`]: { json: after },
    });
    const { user, view } = await openPlan();
    await user.click(
      within(view).getByRole('button', { name: 'Take Mana K. off Day on 2026-11-09' }),
    );
    await waitFor(() => {
      expect(api.callsTo(`/v1/roster/plans/${PLAN_ID}/entries`, 'PATCH')).toHaveLength(1);
    });
    expect(api.callsTo(`/v1/roster/plans/${PLAN_ID}/entries`, 'PATCH')[0]?.body).toEqual({
      add: [],
      remove: [{ userId: WHO.mana.id, shiftId: expect.any(String) as string, workDate: WEEK }],
    });
    await waitFor(() => {
      expect(
        within(view).queryByRole('button', { name: 'Take Mana K. off Day on 2026-11-09' }),
      ).toBeNull();
    });
  });

  it('cannot be applied while a rule is broken', async () => {
    withPlan(brokenPlan());
    const { view } = await openPlan();
    expect(
      within(view).getByText('A rule is broken. Fix it by hand before applying.'),
    ).toBeVisible();
    expect(within(view).getByRole('button', { name: 'Apply to the roster…' })).toBeDisabled();
    expect(
      within(view).getByText(/Mana K\., Tue, Nov 10: less rest than the minimum before Day/),
    ).toBeVisible();
  });

  it('asks before it applies, and a shortfall must be accepted first', async () => {
    const api = withPlan(shortPlan(), {
      [`POST /v1/roster/plans/${PLAN_ID}/apply`]: {
        json: {
          plan: plan({ status: 'applied', appliedAt: '2026-11-03T03:00:00.000Z' }),
          added: 3,
          removed: 0,
        },
      },
    });
    const { user, view } = await openPlan();
    await user.click(within(view).getByRole('button', { name: 'Apply to the roster…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Apply this plan to the roster?' });
    const confirm = within(dialog).getByRole('button', { name: 'Apply to the roster' });
    expect(confirm).toBeDisabled();
    expect(api.callsTo(`/v1/roster/plans/${PLAN_ID}/apply`, 'POST')).toHaveLength(0);
    await user.click(
      within(dialog).getByLabelText('I accept that some shifts have fewer people than needed.'),
    );
    await user.click(confirm);
    await waitFor(() => {
      expect(api.callsTo(`/v1/roster/plans/${PLAN_ID}/apply`, 'POST')).toHaveLength(1);
    });
    expect(api.callsTo(`/v1/roster/plans/${PLAN_ID}/apply`, 'POST')[0]?.body).toEqual({
      acceptShortfall: true,
    });
    expect(await within(view).findByText(/This plan was applied on/)).toBeVisible();
    expect(within(view).queryByRole('button', { name: 'Apply to the roster…' })).toBeNull();
  });

  it('shows the refusal of the server inside the dialog', async () => {
    withPlan(plan(), {
      [`POST /v1/roster/plans/${PLAN_ID}/apply`]: apiError(
        409,
        'conflict',
        '2 planned shift(s) have already started',
      ),
    });
    const { user, view } = await openPlan();
    await user.click(within(view).getByRole('button', { name: 'Apply to the roster…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Apply this plan to the roster?' });
    await user.click(within(dialog).getByRole('button', { name: 'Apply to the roster' }));
    expect(
      await within(dialog).findByText('2 planned shift(s) have already started'),
    ).toBeVisible();
  });

  it('blocks apply while a planned shift has started', async () => {
    withPlan(plan({ diff: { add: 3, remove: 0, keep: 0, locked: 1, started: 2 } }));
    const { view } = await openPlan();
    expect(
      within(view).getByText('2 planned shifts have already started. Take them off the plan.'),
    ).toBeVisible();
    expect(within(view).getByRole('button', { name: 'Apply to the roster…' })).toBeDisabled();
  });

  it('discards after a question', async () => {
    const api = withPlan(plan(), {
      [`POST /v1/roster/plans/${PLAN_ID}/discard`]: { json: plan({ status: 'discarded' }) },
    });
    const { user, view } = await openPlan();
    await user.click(within(view).getByRole('button', { name: 'Discard the plan' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard this plan?' });
    expect(api.callsTo(`/v1/roster/plans/${PLAN_ID}/discard`, 'POST')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Discard the plan' }));
    expect(await within(view).findByText('This plan was discarded.')).toBeVisible();
  });
});

describe('the AI explanation', () => {
  const setup = (extra: Record<string, MockHandler>) =>
    plannerApi({
      'GET /v1/roster/plans': { json: { plans: [summary()] } },
      [`GET /v1/roster/plans/${PLAN_ID}`]: { json: plan() },
      ...extra,
    });

  async function openPlan() {
    const user = await toPlanner();
    await user.click(
      await screen.findByRole('button', { name: 'Open the plan for the week of 2026-11-09' }),
    );
    return {
      user,
      view: await screen.findByRole('region', { name: 'Plan for the week of 2026-11-09' }),
    };
  }

  it('is written under the plan, labelled as AI that cannot change it', async () => {
    const api = setup({
      [`POST /v1/roster/plans/${PLAN_ID}/explain`]: {
        json: plan({
          explanation: {
            text: 'Every shift is covered. Dao N. carries the only night.',
            locale: 'en',
            promptVersion: 1,
            createdAt: '2026-11-02T03:05:00.000Z',
          },
        }),
      },
    });
    const { user, view } = await openPlan();
    expect(within(view).getByText(/No explanation yet/)).toBeVisible();
    await user.click(within(view).getByRole('button', { name: 'Explain with AI' }));
    expect(
      await within(view).findByText('Every shift is covered. Dao N. carries the only night.'),
    ).toBeVisible();
    expect(api.callsTo(`/v1/roster/plans/${PLAN_ID}/explain`, 'POST')[0]?.body).toEqual({
      locale: 'en',
    });
    expect(within(view).getByText(/It explains and cannot change the plan/)).toBeVisible();
    expect(within(view).getByRole('button', { name: 'Explain again' })).toBeVisible();
  });

  it('says the AI is not available and leaves the plan usable', async () => {
    setup({
      [`POST /v1/roster/plans/${PLAN_ID}/explain`]: apiError(
        503,
        'ai_unavailable',
        'kill_switch_on',
      ),
    });
    const { user, view } = await openPlan();
    await user.click(within(view).getByRole('button', { name: 'Explain with AI' }));
    expect(
      await within(view).findByText(
        'The AI is not available now. The plan is complete without it: try again later.',
      ),
    ).toBeVisible();
    expect(within(view).getByRole('button', { name: 'Apply to the roster…' })).toBeEnabled();
  });
});
