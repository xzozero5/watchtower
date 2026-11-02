/**
 * Ops dashboard read model (T-206b, PRD section 9.1): this feature's own audit actions, ticket event types and
 * queue names (T-200) and the HTTP schema of `GET /v1/dashboard/ops`.
 *
 * Browser-safe (no Node imports). The dashboard only reads: there is no audit action, no event and no queue.
 *
 * Honesty rule (N5): a figure that cannot be computed is `{ status: 'not_available', reason }`, never a zero.
 * A section the caller's role may not see is `{ status: 'restricted', requires }`, which is not the same as
 * missing. A real zero (no ticket arrived this week) is a number.
 */
import { z } from 'zod';

/** Audit `action` strings written by this feature (none: the dashboard does not change anything). */
export const DASHBOARD_AUDIT_ACTIONS = {} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const DASHBOARD_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature. */
export const DASHBOARD_QUEUES = {} as const satisfies Record<string, string>;

// --- the rules (every number is an assumption of the owner's to confirm) ------------------------------

/** A ticket whose pending SLA deadline falls within this many minutes is "at risk now" `[ASSUMED]`. */
export const DASHBOARD_AT_RISK_MINUTES = 60;
/** A deploy is "followed by an incident" when an incident on the same service starts within this many hours `[ASSUMED]`. */
export const DASHBOARD_CFR_ATTRIBUTION_HOURS = 2;
/** A published KB article not verified for this many days is stale `[ASSUMED]`. */
export const DASHBOARD_KB_STALE_DAYS = 90;
/** The figures are computed at most this often per window; between runs a cached copy answers. */
export const DASHBOARD_CACHE_SECONDS = 30;
/** Rows in a "top" list. */
export const DASHBOARD_TOP_N = 5;
export const DASHBOARD_MAX_AGENTS = 25;
export const DASHBOARD_MAX_DAYS = 90;
export const DASHBOARD_DEFAULT_DAYS = 7;

export const DASHBOARD_SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4'] as const;
/** Age buckets of the open tickets, by time since creation. */
export const DASHBOARD_AGING_BUCKETS = ['lt_4h', 'h4_24', 'd1_3', 'gt_3d'] as const;

/** Why a figure is missing. `needs_grader` waits for the Phase 3 evaluator; the others are about data. */
export const DASHBOARD_NOT_AVAILABLE_REASONS = [
  'no_data',
  'needs_grader',
  'not_collected',
  'not_implemented',
] as const;
export type DashboardNotAvailableReason = (typeof DASHBOARD_NOT_AVAILABLE_REASONS)[number];

// --- schemas -----------------------------------------------------------------------------------------

/** Either the figure, why it is missing, or that this role does not see it. */
export const dashboardValue = <Data extends z.ZodType>(data: Data) =>
  z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('ok'), data }),
    z.strictObject({
      status: z.literal('not_available'),
      reason: z.enum(DASHBOARD_NOT_AVAILABLE_REASONS),
    }),
    z.strictObject({ status: z.literal('restricted'), requires: z.string() }),
  ]);

export const dashboardQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(DASHBOARD_MAX_DAYS)
    .default(DASHBOARD_DEFAULT_DAYS)
    .describe('Window of the figures in days, ending now'),
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

const count = z.number().int().min(0);
const rate = z.number().min(0).max(1);
/** Seconds, wall clock (not business hours) `[ASSUMED]`. */
const seconds = z.number().min(0);

const durationSchema = z.strictObject({
  medianSeconds: seconds,
  p90Seconds: seconds,
  samples: count,
});
export type DashboardDuration = z.infer<typeof durationSchema>;

const breachSchema = z.strictObject({ evaluated: count, breached: count, rate });

export const dashboardOpsSchema = z.strictObject({
  generatedAt: z.iso.datetime(),
  window: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime(), days: count }),
  /** Waiting tickets right now. */
  queue: z.strictObject({
    open: count,
    unassigned: count,
    byStatus: z.record(z.string(), count),
    byPriority: z.record(z.string(), count),
    /** SLA clock stopped (waiting on the customer). Not counted as at risk or breached. */
    paused: count,
    /** Pending deadline already passed. */
    breachedNow: count,
    /** Pending deadline within `atRiskMinutes`. */
    atRiskNow: count,
    atRiskMinutes: count,
    aging: z.strictObject({
      lt_4h: count,
      h4_24: count,
      d1_3: count,
      gt_3d: count,
    }),
  }),
  volume: z.strictObject({
    created: count,
    byChannel: z.record(z.string(), count),
    /** One entry per UTC day of the window, oldest first, zeros included (those are real). */
    byDay: z.array(z.strictObject({ day: z.string(), created: count })),
  }),
  sla: z.strictObject({
    basis: z.literal('wall_clock'),
    firstResponse: dashboardValue(durationSchema),
    resolution: dashboardValue(durationSchema),
    firstResponseBreach: dashboardValue(breachSchema),
    resolutionBreach: dashboardValue(breachSchema),
  }),
  quality: z.strictObject({
    csat: dashboardValue(
      z.strictObject({
        answered: count,
        sent: count,
        average: z.number().min(0),
        responseRate: rate.nullable(),
      }),
    ),
    reopen: dashboardValue(z.strictObject({ resolved: count, reopened: count, rate })),
    toDev: dashboardValue(z.strictObject({ tickets: count, waitedOnDev: count, rate })),
    escalation: dashboardValue(z.strictObject({ rate })),
  }),
  reliability: z.strictObject({
    incidents: z.strictObject({
      started: count,
      openNow: count,
      bySeverity: z.strictObject({ SEV1: count, SEV2: count, SEV3: count, SEV4: count }),
      /** Organizations linked to an incident that started in the window (linking is by hand or by ticket). */
      affectedOrgs: count,
      mttr: dashboardValue(durationSchema),
      open: z.array(
        z.strictObject({
          id: z.uuid(),
          number: count,
          title: z.string(),
          severity: z.string(),
          status: z.string(),
          startedAt: z.iso.datetime(),
        }),
      ),
    }),
    alerts: z.strictObject({
      openNow: count,
      openBySeverity: z.record(z.string(), count),
      mtta: dashboardValue(durationSchema),
      /** Settled alerts nobody acknowledged and no incident took up, over all settled alerts of the window. */
      noise: dashboardValue(z.strictObject({ settled: count, noisy: count, ratio: rate })),
    }),
    changeFailure: dashboardValue(
      z.strictObject({
        deploys: count,
        followedByIncident: count,
        rate,
        attributionHours: count,
      }),
    ),
  }),
  ai: dashboardValue(
    z.strictObject({
      stages: z.array(
        z.strictObject({
          intent: z.string(),
          name: z.string(),
          stage: z.number().int(),
          pinned: z.boolean(),
        }),
      ),
      drafts: dashboardValue(
        z.strictObject({
          decided: count,
          approved: count,
          edited: count,
          rejected: count,
          acceptanceRate: rate,
          averageEditDistance: z.number().min(0).nullable(),
        }),
      ),
      cost: dashboardValue(
        z.strictObject({
          totalUsd: z.number().min(0),
          tickets: count,
          perTicketUsd: z.number().min(0),
          unpricedRuns: count,
        }),
      ),
      kb: dashboardValue(z.strictObject({ published: count, stale: count, staleAfterDays: count })),
      noTouchRate: dashboardValue(z.strictObject({ rate })),
      verifiedVsAssumed: dashboardValue(z.strictObject({ verified: count, assumed: count })),
      kbCoverage: dashboardValue(z.strictObject({ rate })),
    }),
  ),
  team: z.strictObject({
    perAgent: dashboardValue(
      z.array(
        z.strictObject({
          userId: z.uuid(),
          name: z.string(),
          open: count,
          resolved: count,
        }),
      ),
    ),
    coverage: dashboardValue(z.strictObject({ gaps: count })),
    carriedOver: dashboardValue(z.strictObject({ items: count })),
    lineQuota: dashboardValue(
      z.strictObject({
        period: z.string(),
        used: count,
        limit: count.nullable(),
        accounts: count,
      }),
    ),
  }),
  usage: dashboardValue(
    z.strictObject({
      anomalies: count,
      recent: z.array(
        z.strictObject({
          id: z.uuid(),
          metricKey: z.string(),
          orgId: z.uuid().nullable(),
          observed: z.number(),
          baseline: z.number(),
          createdAt: z.iso.datetime(),
        }),
      ),
    }),
  ),
  health: dashboardValue(
    z.strictObject({
      scored: count,
      insufficientData: count,
      lowest: z.array(
        z.strictObject({
          orgId: z.uuid(),
          orgName: z.string(),
          score: z.number().int().min(0).max(100),
          day: z.string(),
        }),
      ),
    }),
  ),
  services: dashboardValue(
    z.array(
      z.strictObject({
        slug: z.string(),
        name: z.string(),
        status: z.string(),
        public: z.boolean(),
      }),
    ),
  ),
});
export type DashboardOps = z.infer<typeof dashboardOpsSchema>;
