import { dashboardValue } from '@watchtower/shared';
import { z } from 'zod';

import { plain, toolFact, type ModuleToolContext, type ToolRegistrar } from './fact-kit.js';

/**
 * `ops_metrics` (T-404): the ops dashboard figures, as the dashboard route `GET /v1/dashboard/ops` serves them
 * (`DashboardService.ops`, the same cache and the same restriction by role). Instance-level aggregates only: counts,
 * rates and durations; no ticket, person or customer is named. A figure the role may not see arrives as
 * `restricted`, one with nothing behind it as `not_available`, never as a zero (N5).
 */
const count = z.number().int().min(0);
const rate = z.number().min(0).max(1);

export const opsMetricsInput = z.strictObject({
  days: z.number().int().min(1).max(90).default(7),
});

const duration = dashboardValue(
  z.strictObject({
    medianSeconds: z.number().min(0),
    p90Seconds: z.number().min(0),
    samples: count,
  }),
);
const breach = dashboardValue(z.strictObject({ evaluated: count, breached: count, rate }));

export const opsMetricsOutput = z.strictObject({
  window: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime(), days: count }),
  queue: z.strictObject({
    open: count,
    unassigned: count,
    paused: count,
    breachedNow: count,
    atRiskNow: count,
  }),
  volume: z.strictObject({ created: count, previous: z.strictObject({ created: count }) }),
  sla: z.strictObject({
    firstResponse: duration,
    resolution: duration,
    firstResponseBreach: breach,
    resolutionBreach: breach,
  }),
  reliability: z.strictObject({
    incidents: z.strictObject({ started: count, openNow: count }),
    alerts: z.strictObject({ openNow: count }),
  }),
});
export type OpsMetricsOutput = z.infer<typeof opsMetricsOutput>;

const HREF = '/dashboard';
const minutes = (seconds: number): string => `${String(Math.round(seconds / 60))} min`;

const figure = <T>(
  value:
    | { status: 'ok'; data: T }
    | { status: 'not_available'; reason: string }
    | { status: 'restricted'; requires: string },
  say: (data: T) => string,
): string =>
  value.status === 'ok'
    ? say(value.data)
    : value.status === 'restricted'
      ? 'restricted for this role'
      : `not available (${value.reason})`;

export function opsMetricsFacts(output: OpsMetricsOutput) {
  const days = `${String(output.window.days)}d`;
  const make = (id: string, label: string, text: string) =>
    toolFact({
      kind: 'metric',
      id: `ops.${id}`,
      label,
      text: plain(text),
      trust: 'system',
      href: HREF,
    });
  return [
    make(
      'queue',
      'Queue now',
      `Queue now: ${String(output.queue.open)} open, ${String(output.queue.unassigned)} unassigned, ${String(output.queue.paused)} paused (SLA clock stopped), ${String(output.queue.breachedNow)} past SLA, ${String(output.queue.atRiskNow)} at risk.`,
    ),
    make(
      'volume',
      `Volume ${days}`,
      `Tickets created in the last ${days}: ${String(output.volume.created)} (the ${days} before: ${String(output.volume.previous.created)}).`,
    ),
    make(
      'sla',
      `SLA ${days}`,
      `SLA over ${days} (wall clock): first response ${figure(output.sla.firstResponse, (d) => `median ${minutes(d.medianSeconds)}, p90 ${minutes(d.p90Seconds)} (${String(d.samples)} tickets)`)}; resolution ${figure(output.sla.resolution, (d) => `median ${minutes(d.medianSeconds)}, p90 ${minutes(d.p90Seconds)} (${String(d.samples)} tickets)`)}; first-response breaches ${figure(output.sla.firstResponseBreach, (d) => `${String(d.breached)} of ${String(d.evaluated)}`)}; resolution breaches ${figure(output.sla.resolutionBreach, (d) => `${String(d.breached)} of ${String(d.evaluated)}`)}.`,
    ),
    make(
      'reliability',
      `Reliability ${days}`,
      `Incidents started in ${days}: ${String(output.reliability.incidents.started)}, open now ${String(output.reliability.incidents.openNow)}. Alerts open now: ${String(output.reliability.alerts.openNow)}.`,
    ),
  ];
}

export function opsMetricsTool(ctx: ModuleToolContext): ToolRegistrar {
  return (add) => {
    add(
      'ops_metrics',
      {
        description:
          'The ops dashboard figures for the last N days: queue now, volume, SLA, incidents and alerts. Counts and rates of the whole instance, no names.',
        input: opsMetricsInput,
        output: opsMetricsOutput,
        async execute(input) {
          const ops = await ctx.services.dashboard.ops(input.days, ctx.principal);
          return {
            window: ops.window,
            queue: {
              open: ops.queue.open,
              unassigned: ops.queue.unassigned,
              paused: ops.queue.paused,
              breachedNow: ops.queue.breachedNow,
              atRiskNow: ops.queue.atRiskNow,
            },
            volume: {
              created: ops.volume.created,
              previous: { created: ops.volume.previous.created },
            },
            sla: {
              firstResponse: ops.sla.firstResponse,
              resolution: ops.sla.resolution,
              firstResponseBreach: ops.sla.firstResponseBreach,
              resolutionBreach: ops.sla.resolutionBreach,
            },
            reliability: {
              incidents: {
                started: ops.reliability.incidents.started,
                openNow: ops.reliability.incidents.openNow,
              },
              alerts: { openNow: ops.reliability.alerts.openNow },
            },
          };
        },
      },
      '{"days"?: 7}',
      (output) => opsMetricsFacts(output),
    );
  };
}
