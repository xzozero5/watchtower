import type { AiCost, CeoView, Role } from '@watchtower/shared';
import type { Page } from '@playwright/test';

import { uuid } from '../src/test/fixtures';

import { mockBackend } from './backend';

const line = (over: Partial<AiCost['totals']> = {}) => ({
  runs: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  unpricedRuns: 0,
  ...over,
});

/** AI cost for a window. Invented figures only (N1). */
export function aiCostFixture(days = 7): AiCost {
  return {
    generatedAt: '2026-11-04T10:00:00.000Z',
    window: { from: '2026-10-29T00:00:00.000Z', to: '2026-11-04T10:00:00.000Z', days },
    previous: { from: '2026-10-22T00:00:00.000Z', to: '2026-10-29T00:00:00.000Z' },
    totals: {
      ...line({
        runs: 40,
        inputTokens: 90_000,
        outputTokens: 30_000,
        costUsd: 1.5,
        unpricedRuns: 3,
      }),
      tickets: 12,
    },
    previousTotals: {
      ...line({ runs: 20, inputTokens: 40_000, outputTokens: 20_000, costUsd: 1 }),
      tickets: 6,
    },
    byAgent: [
      { agent: 'drafter', ...line({ runs: 20, costUsd: 1 }) },
      { agent: 'summarizer', ...line({ runs: 20, costUsd: 0.5 }) },
    ],
    byIntent: [
      { intent: 'billing', ...line({ runs: 10, costUsd: 0.8 }) },
      { intent: null, ...line({ runs: 10, costUsd: 0.4 }) },
    ],
    byIntentOthers: line({ runs: 5, costUsd: 0.3 }),
    topTickets: [
      {
        ticketId: uuid(1),
        key: 'OPS-12',
        number: 12,
        orgId: uuid(2),
        ...line({ runs: 4, inputTokens: 5_000, outputTokens: 1_000, costUsd: 0.4 }),
      },
    ],
    byDay: [1, 2, 3].map((n) => ({
      day: `2026-11-0${String(n)}`,
      ...line({ runs: n, costUsd: n / 10 }),
    })),
  };
}

const ok = (value: number, previous: number | null, samples = 10) => ({
  status: 'ok' as const,
  data: { value, previous, samples },
});

/** The CEO view for a window. */
export function ceoFixture(days = 7): CeoView {
  return {
    generatedAt: '2026-11-04T10:00:00.000Z',
    window: { from: '2026-10-29T00:00:00.000Z', to: '2026-11-04T10:00:00.000Z', days },
    previous: { from: '2026-10-22T00:00:00.000Z', to: '2026-10-29T00:00:00.000Z' },
    seedExcluded: true,
    kpis: {
      volume: ok(120, 100, 120),
      firstResponse: ok(1_800, 3_600),
      resolution: ok(7_200, null),
      sla: ok(0.9, 0.95),
      csat: ok(4.5, 4.4, 30),
      aiHandled: ok(0.4, null, 50),
      verifiedResolution: { status: 'not_available', reason: 'needs_grader' },
      automationSavings: ok(3.3, 2),
    },
    formula: {
      assumed: true,
      minutesPerTicket: 10,
      staffCostUsdPerHour: null,
      aiHandledTickets: 20,
      noTouchTickets: 8,
      hours: 3.3,
      savedUsd: null,
      aiCostUsd: 2.5,
      netUsd: null,
      aiCostPerResolvedTicketUsd: 0.05,
      previousAiCostPerResolvedTicketUsd: null,
    },
    externalTiles: [
      {
        key: 'uptime',
        label: 'Platform uptime',
        unit: '%',
        higherIsBetter: true,
        value: 99.9,
        previous: 99,
        observedAt: '2026-11-01T00:00:00.000Z',
      },
    ],
  };
}

export interface ReportsBackendOptions {
  role?: Role;
  /** While this answers true the report endpoints fail with a 500. */
  failing?: () => boolean;
}

/** `/v1/reports/ai-cost` and `/v1/reports/ceo`, answered per window. */
export async function mockReports(page: Page, options: ReportsBackendOptions = {}) {
  const days = (search: string) => Number(new URLSearchParams(search).get('days') ?? '7');
  const down = {
    status: 500,
    json: { statusCode: 500, error: 'Error', code: 'internal', message: 'down' },
  };
  return mockBackend(page, {
    role: options.role ?? 'head',
    routes: {
      'GET /v1/reports/ai-cost': (request) =>
        options.failing?.() ? down : { json: aiCostFixture(days(request.search)) },
      'GET /v1/reports/ceo': (request) =>
        options.failing?.() ? down : { json: ceoFixture(days(request.search)) },
    },
  });
}
