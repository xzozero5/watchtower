import { screen, waitFor, within } from '@testing-library/react';
import type { IntentGradeMetrics, IntentGradeMetricsResponse } from '@watchtower/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { consoleApi } from '@/test/console-api';
import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { IntentGradesSection } from './grades-section';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const AT = '2026-11-02T03:00:00.000Z';

function row(over: Partial<IntentGradeMetrics> = {}): IntentGradeMetrics {
  return {
    intentKey: 'password_reset',
    graded: 10,
    verified: 5,
    contained: 3,
    assumed: 2,
    verifiedRate: 0.5,
    containedRate: 0.3,
    assumedRate: 0.2,
    avgDraftQuality: 0.8,
    draftsCompared: 6,
    policyViolations: 1,
    kbGaps: 2,
    reopened: 1,
    reopenRate: 0.1,
    csatAnswered: 4,
    csatAvg: 4.25,
    draftsApproved: 4,
    draftsEdited: 2,
    draftsRejected: 0,
    avgEditDistance: 0.1,
    mock: false,
    ...over,
  };
}

function open(intents: IntentGradeMetrics[] | 'error', days = 28): ReturnType<typeof consoleApi> {
  const body: IntentGradeMetricsResponse = { windowDays: days, from: AT, to: AT, intents: [] };
  const api = consoleApi({
    role: 'lead',
    overrides: {
      'GET /v1/ai/grades/metrics':
        intents === 'error' ? apiError(500, 'internal', 'boom') : { json: { ...body, intents } },
    },
  });
  renderConsole(<IntentGradesSection days={days} />);
  return api;
}

describe('IntentGradesSection', () => {
  it('draws one card per intent with the three classes as named bars and the counts', async () => {
    open([
      row(),
      row({
        intentKey: null,
        graded: 2,
        verified: 0,
        contained: 0,
        assumed: 2,
        verifiedRate: 0,
        containedRate: 0,
        assumedRate: 1,
        avgDraftQuality: null,
        csatAvg: null,
      }),
    ]);
    const card = await screen.findByRole('article', { name: 'Password reset' });
    // Each class: an icon + its name + the share in words, never a colour alone.
    expect(within(card).getByText('Verified 50%')).toBeVisible();
    expect(within(card).getByText('Contained 30%')).toBeVisible();
    expect(within(card).getByText('Assumed 20%')).toBeVisible();
    expect(within(card).getByText('10 graded')).toBeVisible();
    expect(within(card).getByText('Draft quality 80%')).toBeVisible();
    expect(within(card).getByText('1 policy problems')).toBeVisible();
    expect(within(card).getByText('2 knowledge gaps')).toBeVisible();
    expect(within(card).getByText('Rating 4.3 of 5')).toBeVisible();
    // The chart has a table twin with the same numbers.
    expect(within(card).getByRole('button', { name: 'Show as a table' })).toBeVisible();
    const none = screen.getByRole('article', { name: 'No intent' });
    expect(within(none).getByText('No drafts compared')).toBeVisible();
    expect(within(none).getByText('No ratings')).toBeVisible();
  });

  it('marks numbers the stand-in AI produced as demo data', async () => {
    open([row({ mock: true })]);
    expect(await screen.findByText('Demo data')).toBeVisible();
  });

  it('asks for the window it was given', async () => {
    const api = open([row()], 7);
    await screen.findByRole('article', { name: 'Password reset' });
    expect(api.callsTo('/v1/ai/grades/metrics')[0]?.search).toContain('days=7');
  });

  it('says nothing was graded, with the reason', async () => {
    open([]);
    expect(await screen.findByText('Nothing was graded in this period')).toBeVisible();
    expect(screen.getByText('Tickets are graded a little after they are resolved.')).toBeVisible();
  });

  it('says it could not load and offers a retry', async () => {
    open('error');
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Could not load the grader results.');
    });
  });
});
