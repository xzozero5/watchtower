import type { ProcedureStep, ProcedureSteps, ProcedureVersion } from '@watchtower/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { consoleApi } from '@/test/console-api';
import { uuid } from '@/test/fixtures';
import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { ProcedureTab } from './procedure-tab';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/intents/x',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const INTENT = uuid(700);
const AT = '2026-11-03T03:00:00.000Z';
const BASE = `/v1/intents/${INTENT}/procedure/versions`;

const tool = (id: string, extra: Partial<ProcedureStep> = {}): ProcedureStep =>
  ({ kind: 'tool', id, tool: 'kb_search', ...extra }) as ProcedureStep;
const stepsOf = (list: ProcedureStep[]): ProcedureSteps => ({
  schemaVersion: 1,
  autosend: 'never',
  steps: list,
});

function version(n: number, over: Partial<ProcedureVersion> = {}): ProcedureVersion {
  return {
    id: uuid(900 + n),
    procedureId: uuid(899),
    intentId: INTENT,
    version: n,
    status: 'draft',
    sourceMd: 'Look in the knowledge base first.',
    steps: stepsOf([tool('search_kb')]),
    schemaVersion: 1,
    stepsHash: 'a'.repeat(64),
    compiledByAiRunId: null,
    authoredBy: null,
    confirmedBy: null,
    confirmedAt: null,
    publishedBy: null,
    publishedAt: null,
    retiredBy: null,
    retiredAt: null,
    createdAt: AT,
    simulation: null,
    ...over,
  };
}

const list = (items: ProcedureVersion[], publishedVersionId: string | null = null) => ({
  json: { procedureId: items.length > 0 ? uuid(899) : null, publishedVersionId, items },
});

function open(
  items: ProcedureVersion[],
  options: {
    publishedVersionId?: string | null;
    role?: 'head' | 'lead' | 'agent';
    overrides?: Parameters<typeof consoleApi>[0] extends infer O
      ? O extends { overrides?: infer R }
        ? R
        : never
      : never;
  } = {},
) {
  const api = consoleApi({
    role: options.role ?? 'head',
    overrides: {
      [`GET ${BASE}`]: list(items, options.publishedVersionId ?? null),
      [`GET ${BASE}/:versionId/validation`]: { json: { ok: true, issues: [] } },
      ...options.overrides,
    },
  });
  renderConsole(<ProcedureTab intentId={INTENT} />);
  return api;
}

describe('Procedure tab', () => {
  it('says the default investigation runs when there is no procedure, and starts a draft from a template', async () => {
    const user = userEvent.setup();
    const created = version(1, { steps: stepsOf([tool('search_kb')]) });
    const api = open([], {
      overrides: { [`POST ${BASE}`]: { status: 201, json: created } },
    });
    expect(await screen.findByText(/No procedure yet/)).toBeVisible();
    await user.selectOptions(
      screen.getByLabelText('Start from a template'),
      'investigate_then_reply',
    );
    await waitFor(() => {
      expect(api.callsTo(BASE, 'POST')).toHaveLength(1);
    });
    const body = api.callsTo(BASE, 'POST')[0]?.body as { sourceMd: string; steps: ProcedureSteps };
    expect(body.steps.autosend).toBe('never');
    expect(body.steps.steps.length).toBeGreaterThan(2);
    expect(body.sourceMd).toMatch(/knowledge base/);
  });

  it('shows the state of each version in words, and who confirmed and published', async () => {
    const live = version(2, {
      status: 'published',
      confirmedBy: uuid(1),
      confirmedAt: AT,
      publishedBy: uuid(1),
      publishedAt: AT,
    });
    open([live, version(1, { status: 'retired', retiredAt: AT })], { publishedVersionId: live.id });
    const versions = await screen.findByRole('list', { name: 'Choose a version' });
    expect(within(versions).getAllByText('Published').length).toBeGreaterThan(0);
    expect(within(versions).getByText('Live')).toBeVisible();
    expect(within(versions).getByText('Retired')).toBeVisible();
    expect(screen.getByText(/Published by .* on /)).toBeVisible();
    expect(screen.getByText(/Confirmed by .* on /)).toBeVisible();
    // A live version cannot be edited.
    expect(screen.getByText(/cannot be edited/)).toBeVisible();
  });

  it('lets a person write the steps by hand when the AI is unavailable (503)', async () => {
    const user = userEvent.setup();
    open([version(1)], {
      overrides: { [`POST ${BASE}/:versionId/compile`]: apiError(503, 'ai_unavailable') },
    });
    await user.click(await screen.findByRole('button', { name: 'Draft steps with AI' }));
    expect(await screen.findByText(/The AI is not available now/)).toBeVisible();
    // The form still works: add a reply guideline and type into it.
    await user.selectOptions(screen.getByLabelText('Kind of step'), 'reply_guideline');
    await user.click(screen.getByRole('button', { name: 'Add a step' }));
    await user.type(screen.getByLabelText('Guideline'), 'Be brief.');
    expect(screen.getByLabelText('Guideline')).toHaveValue('Be brief.');
    expect(
      screen.getByText(
        'You changed the steps. Save the draft to check them against this instance.',
      ),
    ).toBeVisible();
  });

  it('says so when the AI answered with steps that do not fit (502)', async () => {
    const user = userEvent.setup();
    open([version(1)], {
      overrides: { [`POST ${BASE}/:versionId/compile`]: apiError(502, 'ai_unavailable') },
    });
    await user.click(await screen.findByRole('button', { name: 'Draft steps with AI' }));
    expect(await screen.findByText(/did not fit|do not fit/)).toBeVisible();
  });

  it('puts the drafted steps in the form and shows what the AI had to guess', async () => {
    const user = userEvent.setup();
    const drafted = version(1, {
      steps: stepsOf([tool('search_kb'), tool('find_similar', { tool: 'similar_tickets' })]),
      compiledByAiRunId: uuid(5),
    });
    open([version(1)], {
      overrides: {
        [`POST ${BASE}/:versionId/compile`]: {
          json: {
            version: drafted,
            validation: { ok: true, issues: [] },
            assumptions: ['Assumed the P1 rule applies to every channel.'],
            promptVersion: 1,
          },
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Draft steps with AI' }));
    expect(await screen.findByText('Assumed the P1 rule applies to every channel.')).toBeVisible();
    expect(screen.getByText('2 of 20 steps')).toBeVisible();
  });

  it("shows the api's problem beside the step it belongs to, and keeps Confirm closed", async () => {
    open([version(1)], {
      overrides: {
        [`GET ${BASE}/:versionId/validation`]: {
          json: {
            ok: false,
            issues: [
              {
                code: 'tool_not_allowed',
                stepId: 'search_kb',
                message: 'This intent may not use kb_search.',
              },
            ],
          },
        },
      },
    });
    expect(await screen.findByText('This intent may not use kb_search.')).toBeVisible();
    expect(screen.getByText('1 problems found.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Confirm steps' })).toBeDisabled();
    expect(screen.getByText('Fix the problems first.')).toBeVisible();
  });

  it('saves an edited draft, then confirms it after reading', async () => {
    const user = userEvent.setup();
    const saved = version(1, { sourceMd: 'New text.' });
    let stored = version(1);
    const api = open([], {
      overrides: {
        [`GET ${BASE}`]: () => list([stored]),
        [`PATCH ${BASE}/:versionId`]: () => {
          stored = saved;
          return { json: saved };
        },
        [`POST ${BASE}/:versionId/confirm`]: {
          json: {
            version: { ...saved, status: 'confirmed', confirmedBy: uuid(1), confirmedAt: AT },
            validation: { ok: true, issues: [] },
          },
        },
      },
    });
    const text = await screen.findByLabelText('What should happen, in plain language');
    await user.clear(text);
    await user.type(text, 'New text.');
    // Not saved: Confirm waits.
    expect(screen.getByRole('button', { name: 'Confirm steps' })).toBeDisabled();
    expect(screen.getByText('Save the draft first.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(api.callsTo(`${BASE}/${version(1).id}`, 'PATCH')).toHaveLength(1);
    });
    const patch = api.callsTo(`${BASE}/${version(1).id}`, 'PATCH')[0]?.body as { sourceMd: string };
    expect(patch.sourceMd).toBe('New text.');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Confirm steps' })).toBeEnabled();
    });
  });

  it('compares a draft with the live version', async () => {
    const live = version(1, { status: 'published', steps: stepsOf([tool('search_kb')]) });
    const draft = version(2, {
      steps: stepsOf([tool('search_kb', { params: { limit: 3 } }), tool('find_similar')]),
    });
    open([draft, live], { publishedVersionId: live.id });
    const diff = await screen.findByRole('region', { name: 'Changes from the live version' });
    expect(within(diff).getByText('Compared with version 1.')).toBeVisible();
    expect(within(diff).getByText('Added')).toBeVisible();
    expect(within(diff).getByText('find_similar')).toBeVisible();
    expect(within(diff).getByText('Changed')).toBeVisible();
    expect(within(diff).getByText('Changed: params')).toBeVisible();
  });

  describe('simulation (T-303f)', () => {
    const confirmed = () =>
      version(1, { status: 'confirmed', confirmedBy: uuid(1), confirmedAt: AT });
    const metrics = (over: Record<string, unknown> = {}) => ({
      mode: 'instance',
      caseCount: 12,
      failedCases: 0,
      seededCases: 0,
      candidate: {
        editDistance: 21.5,
        uncitedClaims: 1,
        drafted: 12,
        violations: 0,
        disclosureLeaks: 0,
      },
      baseline: { editDistance: 24, uncitedClaims: 2, drafted: 12 },
      baselineVersionId: uuid(950),
      deadSteps: [],
      toolCalls: 30,
      failReasons: [],
      cases: [],
      ...over,
    });
    const result = (v: ProcedureVersion, passed: boolean, over: Record<string, unknown> = {}) => ({
      id: uuid(7),
      versionId: v.id,
      stepsHash: v.stepsHash,
      passed,
      seedOnly: false,
      caseCount: 12,
      metrics: metrics(),
      ranBy: uuid(1),
      createdAt: AT,
      ...over,
    });

    it('queues a run, reads the result when it appears and shows the numbers; Publish stays closed until the versions refresh says simulated', async () => {
      const user = userEvent.setup();
      const v = confirmed();
      let ran = false;
      const api = open([v], {
        overrides: {
          [`POST ${BASE}/:versionId/simulate`]: () => {
            ran = true;
            return { status: 202, json: { versionId: v.id, queued: true } };
          },
          [`GET ${BASE}/:versionId/simulation`]: () => ({
            json: { versionId: v.id, simulation: ran ? result(v, true) : null },
          }),
        },
      });
      expect(await screen.findByText('Not simulated yet.')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Run simulation' }));
      await waitFor(() => {
        expect(api.callsTo(`${BASE}/${v.id}/simulate`, 'POST')).toHaveLength(1);
      });
      expect(await screen.findByText('Passed on 12 tickets')).toBeVisible();
      expect(screen.getByText('Tickets replayed')).toBeVisible();
      expect(screen.getByText(/This version 21\.5 · Live now 24\.0/)).toBeVisible();
    });

    it('keeps asking while the worker runs, says it is running, and shows the result when it lands', async () => {
      const user = userEvent.setup();
      const v = confirmed();
      let reads = 0;
      let ran = false;
      open([v], {
        overrides: {
          [`POST ${BASE}/:versionId/simulate`]: () => {
            ran = true;
            return { status: 202, json: { versionId: v.id, queued: true } };
          },
          [`GET ${BASE}/:versionId/simulation`]: () => {
            if (ran) reads += 1;
            return {
              json: { versionId: v.id, simulation: ran && reads >= 2 ? result(v, false) : null },
            };
          },
        },
      });
      await user.click(await screen.findByRole('button', { name: 'Run simulation' }));
      expect((await screen.findAllByText(/Simulating on resolved tickets/)).length).toBeGreaterThan(
        0,
      );
      expect(screen.getByRole('button', { name: 'Run simulation' })).toBeDisabled();
      expect(
        await screen.findByText('Did not pass on 12 tickets', {}, { timeout: 8000 }),
      ).toBeVisible();
      await waitFor(() => {
        expect(screen.queryByText(/Simulating on resolved tickets/)).toBeNull();
      });
    }, 15000);

    it('says why a simulation did not pass, in words', async () => {
      const v = version(1, {
        status: 'simulated',
        simulation: { id: uuid(7), passed: false, seedOnly: true, caseCount: 0, createdAt: AT },
      });
      open([v], {
        overrides: {
          [`GET ${BASE}/:versionId/simulation`]: {
            json: {
              versionId: v.id,
              simulation: result(v, false, {
                seedOnly: true,
                caseCount: 0,
                metrics: metrics({
                  caseCount: 0,
                  failReasons: ['no_cases', 'disclosure_leak'],
                  deadSteps: ['search_kb'],
                  mode: 'fixture',
                }),
              }),
            },
          },
        },
      });
      expect(await screen.findByText('Did not pass on 0 tickets')).toBeVisible();
      expect(
        await screen.findByText('There are no resolved tickets of this intent to replay yet.'),
      ).toBeVisible();
      expect(screen.getByText('A reply told what a disclosure step forbids.')).toBeVisible();
      expect(
        within(screen.getByRole('region', { name: 'Simulation' })).getByText('search_kb'),
      ).toBeVisible();
      expect(screen.getByText('Made-up test cases, not tickets of this instance.')).toBeVisible();
      expect(
        screen.getByText(
          'Seeded tickets only: it does not count for an intent at Stage 3 or higher.',
        ),
      ).toBeVisible();
      // Not passed: Publish exists but is closed, with the reason.
      expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    });

    it('explains a 503 (the AI cannot run) and a 409 instead of failing silently', async () => {
      const user = userEvent.setup();
      const v = confirmed();
      let status = 503;
      open([v], {
        overrides: {
          [`POST ${BASE}/:versionId/simulate`]: () =>
            status === 503
              ? apiError(503, 'ai_unavailable', 'x')
              : apiError(409, 'conflict', 'A version in status draft cannot be simulated'),
        },
      });
      await user.click(await screen.findByRole('button', { name: 'Run simulation' }));
      expect(await screen.findByText(/The AI cannot run right now/)).toBeVisible();
      status = 409;
      await user.click(screen.getByRole('button', { name: 'Run simulation' }));
      expect(await screen.findByText(/cannot be simulated in its current state/)).toBeVisible();
    });

    it('does not offer the run to someone who cannot publish', async () => {
      open([confirmed()], { role: 'agent' });
      expect(await screen.findByText('Not simulated yet.')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Run simulation' })).toBeNull();
      expect(
        screen.getByText('Needs permission to publish procedures to run a simulation.'),
      ).toBeVisible();
    });
  });

  it('publishes a version whose simulation passed, after asking', async () => {
    const user = userEvent.setup();
    const simulated = version(1, {
      status: 'simulated',
      simulation: { id: uuid(7), passed: true, seedOnly: false, caseCount: 30, createdAt: AT },
    });
    const api = open([simulated], {
      overrides: {
        [`POST ${BASE}/:versionId/publish`]: {
          json: { ...simulated, status: 'published', publishedAt: AT, publishedBy: uuid(1) },
        },
      },
    });
    expect(await screen.findByText('Passed on 30 tickets')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish version 1?' });
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => {
      expect(api.callsTo(`${BASE}/${simulated.id}/publish`, 'POST')).toHaveLength(1);
    });
  });

  it("shows the database's refusal to publish inside the dialog", async () => {
    const user = userEvent.setup();
    const simulated = version(1, {
      status: 'simulated',
      simulation: { id: uuid(7), passed: true, seedOnly: false, caseCount: 30, createdAt: AT },
    });
    open([simulated], {
      overrides: {
        [`POST ${BASE}/:versionId/publish`]: apiError(
          409,
          'conflict',
          'The simulation is older than 30 days.',
        ),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    expect(await within(dialog).findByText('The simulation is older than 30 days.')).toBeVisible();
  });

  it('retires the live version and offers a roll back on an older one', async () => {
    const user = userEvent.setup();
    const live = version(2, { status: 'published', publishedAt: AT, publishedBy: uuid(1) });
    const older = version(1, {
      status: 'retired',
      publishedAt: AT,
      retiredAt: AT,
      simulation: { id: uuid(7), passed: true, seedOnly: false, caseCount: 30, createdAt: AT },
    });
    const api = open([live, older], {
      publishedVersionId: live.id,
      overrides: { [`POST ${BASE}/:versionId/retire`]: { json: { ...live, status: 'retired' } } },
    });
    await user.click(await screen.findByRole('button', { name: 'Retire' }));
    const dialog = await screen.findByRole('dialog', { name: 'Retire the live version?' });
    await user.click(within(dialog).getByRole('button', { name: 'Retire' }));
    await waitFor(() => {
      expect(api.callsTo(`${BASE}/${live.id}/retire`, 'POST')).toHaveLength(1);
    });
    await user.click(screen.getByRole('button', { name: /Version 1/ }));
    expect(await screen.findByRole('button', { name: 'Roll back to this version' })).toBeEnabled();
  });

  it('lets an agent read but not change anything', async () => {
    open([version(1)], { role: 'agent' });
    expect(await screen.findByText('You can read this procedure but not change it.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New draft' })).toBeNull();
    expect(screen.getByLabelText('What should happen, in plain language')).toBeDisabled();
  });

  it('shows an error with a retry when the versions cannot load', async () => {
    open([], { overrides: { [`GET ${BASE}`]: apiError(500, 'internal') } });
    expect(await screen.findByText('Could not load the procedure.')).toBeVisible();
    expect(screen.getByRole('button', { name: /Try again|Retry/ })).toBeVisible();
  });

  it('edits a condition as a form (priority is P1, confidence at most 0.6)', async () => {
    const user = userEvent.setup();
    const escalate: ProcedureStep = {
      kind: 'escalate',
      id: 'p1_to_lead',
      when: { all: [{ field: 'ticket.priority', op: 'eq', value: 'P1' }] },
      to: { role: 'lead' },
      note: 'Look first.',
    };
    open([version(1, { steps: stepsOf([escalate]) })]);
    await user.selectOptions(await screen.findByLabelText('Field 1'), 'classifier.confidence');
    // The comparison and the value follow the field.
    expect(screen.getByLabelText('Comparison 1')).toHaveDisplayValue('is');
    const value = screen.getByLabelText('Value 1');
    await user.clear(value);
    await user.type(value, '0.6');
    expect(value).toHaveValue(0.6);
    await user.selectOptions(screen.getByLabelText('Comparison 1'), 'lte');
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
  });
});
