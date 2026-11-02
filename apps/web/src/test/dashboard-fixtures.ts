import type { DashboardOps } from '@watchtower/shared';

import { uuid } from './fixtures';

/** Ops dashboard fixtures: invented names and example.com only (N1). Shared by the unit tests and the e2e mock. */
export const GENERATED_AT = '2026-11-02T03:00:00.000Z';

const DAY_MS = 86_400_000;

/** `days` UTC days ending on the day of `GENERATED_AT`, oldest first, with a gentle weekly shape. */
export function byDay(
  days: number,
  valueOf = (index: number) => (index % 7 === 0 ? 0 : index % 7),
) {
  const end = Date.parse(GENERATED_AT);
  return Array.from({ length: days }, (_, index) => ({
    day: new Date(end - (days - 1 - index) * DAY_MS).toISOString().slice(0, 10),
    created: valueOf(index),
  }));
}

export const INCIDENT_OPEN = {
  id: uuid(8101),
  number: 14,
  title: 'Checkout API slow in region A',
  severity: 'SEV2',
  status: 'investigating',
  startedAt: '2026-11-02T01:30:00.000Z',
};

/** A role that sees everything, with one of each kind of figure. */
export function dashboardOps(overrides: Partial<DashboardOps> = {}, days = 7): DashboardOps {
  return {
    generatedAt: GENERATED_AT,
    window: {
      from: new Date(Date.parse(GENERATED_AT) - days * DAY_MS).toISOString(),
      to: GENERATED_AT,
      days,
    },
    queue: {
      open: 23,
      unassigned: 4,
      byStatus: { open: 15, new: 8 },
      byPriority: { P1: 1, P2: 6, P3: 16 },
      paused: 3,
      breachedNow: 2,
      atRiskNow: 5,
      atRiskMinutes: 60,
      aging: { lt_4h: 9, h4_24: 8, d1_3: 4, gt_3d: 2 },
    },
    volume: {
      created: 41,
      byChannel: { gmail: 22, line: 12, portal: 7 },
      byDay: byDay(days),
    },
    sla: {
      basis: 'wall_clock',
      firstResponse: { status: 'ok', data: { medianSeconds: 540, p90Seconds: 5400, samples: 38 } },
      resolution: {
        status: 'ok',
        data: { medianSeconds: 14_400, p90Seconds: 100_000, samples: 30 },
      },
      firstResponseBreach: { status: 'ok', data: { evaluated: 38, breached: 3, rate: 3 / 38 } },
      resolutionBreach: { status: 'ok', data: { evaluated: 30, breached: 0, rate: 0 } },
    },
    quality: {
      csat: {
        status: 'ok',
        data: { answered: 12, sent: 30, average: 4.25, responseRate: 0.4 },
      },
      reopen: { status: 'ok', data: { resolved: 30, reopened: 2, rate: 2 / 30 } },
      toDev: { status: 'ok', data: { tickets: 41, waitedOnDev: 6, rate: 6 / 41 } },
      escalation: { status: 'not_available', reason: 'not_implemented' },
    },
    reliability: {
      incidents: {
        started: 3,
        openNow: 1,
        bySeverity: { SEV1: 0, SEV2: 2, SEV3: 1, SEV4: 0 },
        affectedOrgs: 2,
        mttr: { status: 'ok', data: { medianSeconds: 3600, p90Seconds: 9000, samples: 2 } },
        open: [INCIDENT_OPEN],
      },
      alerts: {
        openNow: 6,
        openBySeverity: { critical: 1, warning: 5 },
        mtta: { status: 'not_available', reason: 'no_data' },
        noise: { status: 'ok', data: { settled: 40, noisy: 12, ratio: 0.3 } },
      },
      changeFailure: {
        status: 'ok',
        data: { deploys: 10, followedByIncident: 1, rate: 0.1, attributionHours: 2 },
      },
    },
    ai: {
      status: 'ok',
      data: {
        stages: [
          { intent: 'password_reset', name: 'Password reset', stage: 2, pinned: false },
          { intent: 'billing_question', name: 'Billing question', stage: 1, pinned: true },
        ],
        drafts: {
          status: 'ok',
          data: {
            decided: 20,
            approved: 12,
            edited: 5,
            rejected: 3,
            acceptanceRate: 0.85,
            averageEditDistance: 0.2,
          },
        },
        cost: {
          status: 'ok',
          data: { totalUsd: 1.68, tickets: 40, perTicketUsd: 0.042, unpricedRuns: 0 },
        },
        kb: { status: 'ok', data: { published: 30, stale: 4, staleAfterDays: 90 } },
        noTouchRate: { status: 'not_available', reason: 'needs_grader' },
        verifiedVsAssumed: { status: 'ok', data: { verified: 18, assumed: 6 } },
        kbCoverage: { status: 'not_available', reason: 'needs_grader' },
      },
    },
    team: {
      perAgent: {
        status: 'ok',
        data: [
          { userId: uuid(8201), name: 'Mana K.', open: 9, resolved: 14 },
          { userId: uuid(8202), name: 'Nok S.', open: 0, resolved: 11 },
        ],
      },
      coverage: { status: 'ok', data: { gaps: 0 } },
      carriedOver: { status: 'ok', data: { items: 2 } },
      lineQuota: {
        status: 'ok',
        data: { period: '2026-11', used: 412, limit: 1000, accounts: 1 },
      },
    },
    usage: {
      status: 'ok',
      data: {
        anomalies: 1,
        recent: [
          {
            id: uuid(8301),
            metricKey: 'exports_started',
            orgId: uuid(8302),
            observed: 3,
            baseline: 40,
            createdAt: '2026-11-02T00:10:00.000Z',
          },
        ],
      },
    },
    health: {
      status: 'ok',
      data: {
        scored: 5,
        insufficientData: 1,
        lowest: [{ orgId: uuid(8302), orgName: 'Acme Logistics', score: 41, day: '2026-11-01' }],
      },
    },
    services: {
      status: 'ok',
      data: [
        {
          slug: 'checkout-api',
          name: 'Checkout API',
          status: 'degraded_performance',
          public: true,
        },
        { slug: 'search', name: 'Search', status: 'operational', public: true },
      ],
    },
    ...overrides,
  };
}

/** What an agent gets: the queue, SLA, reliability and services, and `restricted` for the rest. */
export function agentDashboardOps(days = 7): DashboardOps {
  const full = dashboardOps({}, days);
  return {
    ...full,
    quality: {
      ...full.quality,
      csat: { status: 'restricted', requires: 'csat.read' },
    },
    ai: { status: 'restricted', requires: 'ai.run.read' },
    team: {
      ...full.team,
      perAgent: { status: 'restricted', requires: 'performance.read.all' },
    },
    usage: { status: 'restricted', requires: 'metric.read' },
    health: { status: 'restricted', requires: 'org.health.read' },
  };
}
