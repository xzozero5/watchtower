import type { DashboardOps, Role } from '@watchtower/shared';
import type { Page } from '@playwright/test';

import { agentDashboardOps, dashboardOps } from '../src/test/dashboard-fixtures';

import { mockBackend } from './backend';

export interface DashboardBackendOptions {
  role?: Role;
  /** The answer for a window; defaults to the full figures, or the agent's trimmed ones. */
  answer?: (days: number) => DashboardOps;
  /** While this answers true the api fails with a 500 (to show the error state and the retry). */
  failing?: () => boolean;
}

/** The ops dashboard's api, answered per window. Invented names and example.com only (N1). */
export async function mockDashboard(page: Page, options: DashboardBackendOptions = {}) {
  const role = options.role ?? 'head';
  const answer =
    options.answer ??
    ((days: number) => (role === 'agent' ? agentDashboardOps(days) : dashboardOps({}, days)));
  const backend = await mockBackend(page, {
    role,
    routes: {
      'GET /v1/dashboard/ops': (request) =>
        options.failing?.()
          ? {
              status: 500,
              json: { statusCode: 500, error: 'Error', code: 'internal', message: 'down' },
            }
          : { json: answer(Number(new URLSearchParams(request.search).get('days') ?? '7')) },
    },
  });
  return backend;
}
