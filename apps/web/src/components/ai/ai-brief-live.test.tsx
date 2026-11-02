import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetPendingSends } from '@/lib/outbound/pending-sends';
import { resetPreferencesCache } from '@/lib/preferences';
import { renderWorkspace } from '@/test-utils';
import {
  makeInsight,
  makeInvestigatingInsight,
  makeProgressInsight,
  makeReport,
} from '@/test/ai-fixtures';
import { makeAutonomy } from '@/test/console-fixtures';
import { makeTicket } from '@/test/fixtures';
import { apiError } from '@/test/mock-api';
import { workspaceApi } from '@/test/scenarios';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

beforeEach(() => {
  resetPendingSends();
  localStorage.clear();
  resetPreferencesCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ticket1 = makeTicket(1, { subject: 'Re: Re: login', priority: 'P2' });

async function openBrief() {
  window.history.replaceState(null, '', '/?ticket=OPS-1');
  renderWorkspace();
  const conversation = await screen.findByRole('region', { name: 'Conversation' });
  const brief = await within(conversation).findByRole('region', { name: 'AI brief' });
  return { conversation, brief };
}

describe('the investigation report', () => {
  it('shows the cause with its confidence, findings with their evidence, gaps and the tools that ran', async () => {
    const user = userEvent.setup();
    workspaceApi({
      tickets: [ticket1],
      ai: { 'OPS-1': makeInsight({ report: makeReport() }) },
    });
    const { brief } = await openBrief();
    const report = within(brief).getByTestId('ai-report');
    await user.click(within(report).getByText('What the AI found'));

    expect(
      within(report).getByText('A lockout policy, not a bug in the reset flow.'),
    ).toBeVisible();
    // One of its tools ran on sample data, so the run is a demo: a chip, no confidence number.
    expect(within(report).getByText('Demo')).toBeVisible();
    expect(within(report).queryByRole('meter')).toBeNull();
    // A finding with evidence names it; a finding without says so (N5).
    expect(within(report).getByText(/The account was locked after five failed/)).toBeVisible();
    expect(
      within(report).getByText('Evidence: Unlocking an account after failed sign-ins'),
    ).toBeVisible();
    expect(within(report).getByText('No evidence')).toBeVisible();
    expect(within(report).getByText('Did the customer use the second reset link?')).toBeVisible();
    // A refused tool is listed in words, and sample data is marked.
    expect(within(report).getByText('kb_search · done')).toBeVisible();
    expect(within(report).getByText('gcp_logs · not allowed · sample data')).toBeVisible();
    expect(
      within(report).getByText('Tools scoped to the intent because the AI was confident.'),
    ).toBeVisible();
  });

  it('shows the cause with its confidence when every tool ran for real', async () => {
    const user = userEvent.setup();
    workspaceApi({
      tickets: [ticket1],
      ai: {
        'OPS-1': makeInsight({
          report: makeReport({
            tools: [{ name: 'kb_search', status: 'ok', mock: false }],
          }),
        }),
      },
    });
    const { brief } = await openBrief();
    const report = within(brief).getByTestId('ai-report');
    await user.click(within(report).getByText('What the AI found'));
    expect(within(report).getByRole('meter', { name: 'Confidence High 0.82' })).toBeVisible();
    expect(within(report).queryByText('Demo')).toBeNull();
  });

  it('says "No cause found" instead of inventing one', async () => {
    workspaceApi({
      tickets: [ticket1],
      ai: { 'OPS-1': makeInsight({ report: makeReport({ likelyCause: null, confidence: 0.2 }) }) },
    });
    const { brief } = await openBrief();
    expect(within(brief).getByText('No cause found')).toBeInTheDocument();
  });
});

describe('progress', () => {
  it('shows the step the worker is on, not a spinner alone', async () => {
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': makeProgressInsight(1, 4) } });
    const { brief } = await openBrief();
    const progress = within(brief).getByTestId('ai-progress');
    expect(within(progress).getByText('Investigating · Step 2 of 4')).toBeVisible();
    const bar = within(progress).getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '1');
    expect(bar).toHaveAttribute('aria-valuemax', '4');
  });
});

describe('asking the AI', () => {
  it('"Draft a reply" posts the request and says so; it is offered at stage 1 or 2 with no draft', async () => {
    const user = userEvent.setup();
    const insight = makeInsight({ state: 'classified', stage: 1 });
    delete insight.draft;
    const api = workspaceApi({
      tickets: [ticket1],
      ai: { 'OPS-1': insight },
      overrides: { 'POST /v1/tickets/:id/ai/requests': { status: 202, json: { accepted: true } } },
    });
    const { brief } = await openBrief();
    await user.click(within(brief).getByRole('button', { name: 'Draft a reply' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/ai/requests', 'POST')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/tickets/OPS-1/ai/requests', 'POST')[0]?.body).toEqual({
      kind: 'draft',
    });
    expect(await screen.findByText('Asked the AI. Its progress shows here.')).toBeVisible();
  });

  it('offers no draft request at stage 0 (the api would refuse it), only a new investigation', async () => {
    const user = userEvent.setup();
    const insight = makeInsight({ state: 'classified', stage: 0 });
    delete insight.draft;
    const api = workspaceApi({
      tickets: [ticket1],
      ai: { 'OPS-1': insight },
      overrides: { 'POST /v1/tickets/:id/ai/requests': { status: 202, json: { accepted: true } } },
    });
    const { brief } = await openBrief();
    expect(within(brief).queryByRole('button', { name: 'Draft a reply' })).toBeNull();
    await user.click(within(brief).getByRole('button', { name: 'Investigate again' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/ai/requests', 'POST')[0]?.body).toEqual({
        kind: 'investigate',
      });
    });
  });

  it('says the AI is busy or the intent does not allow a draft when the api answers 409', async () => {
    const user = userEvent.setup();
    const insight = makeInsight({ state: 'classified', stage: 2 });
    delete insight.draft;
    workspaceApi({
      tickets: [ticket1],
      ai: { 'OPS-1': insight },
      overrides: { 'POST /v1/tickets/:id/ai/requests': apiError(409, 'conflict') },
    });
    const { brief } = await openBrief();
    await user.click(within(brief).getByRole('button', { name: 'Draft a reply' }));
    expect(
      await screen.findByText(
        'The AI is already working on this ticket, or this intent does not allow a draft.',
      ),
    ).toBeVisible();
  });

  it('cannot ask while the AI is already working', async () => {
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': makeInvestigatingInsight() } });
    const { brief } = await openBrief();
    expect(within(brief).getByRole('button', { name: 'Investigate again' })).toBeDisabled();
  });
});

describe('the emergency switch', () => {
  it('shows "AI paused" in the brief and stops new requests while the kill switch is on', async () => {
    const autonomy = makeAutonomy();
    const insight = makeInsight({ state: 'classified', stage: 2 });
    delete insight.draft;
    workspaceApi({
      tickets: [ticket1],
      ai: { 'OPS-1': insight },
      overrides: {
        'GET /v1/autonomy': {
          json: {
            ...autonomy,
            switches: autonomy.switches.map((item) =>
              item.key === 'ai_kill_switch' ? { ...item, on: true } : item,
            ),
          },
        },
      },
    });
    const { brief } = await openBrief();
    expect(await within(brief).findByText('AI paused')).toBeVisible();
    expect(within(brief).getByRole('button', { name: 'Draft a reply' })).toBeDisabled();
    expect(within(brief).getByRole('button', { name: 'Investigate again' })).toBeDisabled();
  });

  it('shows no pause chip while the switch is off', async () => {
    workspaceApi({
      tickets: [ticket1],
      ai: { 'OPS-1': makeInsight() },
      overrides: { 'GET /v1/autonomy': { json: makeAutonomy() } },
    });
    const { brief } = await openBrief();
    expect(within(brief).queryByText('AI paused')).toBeNull();
  });
});

describe('what the disclosure policy did to the draft', () => {
  it('says the contact is not verified and how many sentences were left out', async () => {
    const base = makeInsight();
    if (!base.draft) throw new Error('fixture has a draft');
    workspaceApi({
      tickets: [ticket1],
      ai: {
        'OPS-1': makeInsight({
          draft: {
            ...base.draft,
            disclosure: { level: 'restricted', removedSentences: 2 },
            needsReview: true,
            language: 'th',
          },
        }),
      },
    });
    await openBrief();
    const draft = await screen.findByTestId('ai-draft');
    expect(within(draft).getByText('Contact not verified')).toBeVisible();
    expect(within(draft).getByText('Contact not verified').closest('[title]')).toHaveAttribute(
      'title',
      'Details that need a verified contact were left out (2 sentences).',
    );
    expect(within(draft).getByText('Read first')).toBeVisible();
    expect(within(draft).getByText('Language: TH')).toBeVisible();
  });

  it('lists the evidence the draft cites under its text, each opening its card', async () => {
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': makeInsight() } });
    await openBrief();
    const draft = await screen.findByTestId('ai-draft');
    const sources = within(draft).getByRole('list', { name: 'Sources' });
    expect(within(sources).getAllByRole('listitem')).toHaveLength(2);
    expect(
      within(sources).getByRole('button', { name: /Unlocking an account after failed/ }),
    ).toBeVisible();
  });
});
