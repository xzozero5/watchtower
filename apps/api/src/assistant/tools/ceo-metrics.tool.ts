import { CEO_KPI_KEYS, ceoTileSchema, dashboardValue } from '@watchtower/shared';
import { z } from 'zod';

import { plain, toolFact, type ModuleToolContext, type ToolRegistrar } from './fact-kit.js';

/**
 * `ceo_metrics` (T-404, DoD C-21): the KPI tiles of the CEO view, as `GET /v1/reports/ceo` serves them
 * (`CeoViewService.read`). Instance-level aggregates only: a KPI is a number over the whole instance and the same
 * number for the period before. The savings formula (its settings and the hourly cost) and the per-ticket and
 * per-organization lists are not passed on, and no tile names a person, a customer or a ticket.
 */
const KPI_LABELS: Readonly<Record<(typeof CEO_KPI_KEYS)[number], string>> = {
  volume: 'Ticket volume',
  firstResponse: 'First response (median, seconds)',
  resolution: 'Resolution (median, seconds)',
  sla: 'SLA compliance',
  csat: 'CSAT',
  aiHandled: 'AI-assisted share',
  verifiedResolution: 'Verified-resolution rate',
  automationSavings: 'Automation savings',
};

export const ceoMetricsInput = z.strictObject({
  days: z.number().int().min(1).max(90).default(30),
});

const tile = dashboardValue(ceoTileSchema);

export const ceoMetricsOutput = z.strictObject({
  window: z.strictObject({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    days: z.number().int().min(0),
  }),
  kpis: z.strictObject({
    volume: tile,
    firstResponse: tile,
    resolution: tile,
    sla: tile,
    csat: tile,
    aiHandled: tile,
    verifiedResolution: tile,
    automationSavings: tile,
  }),
  /** Numbers fed from outside (API or CSV): the newest point and the one before. */
  externalTiles: z
    .array(
      z.strictObject({
        key: z.string().max(100),
        label: z.string().max(200),
        unit: z.string().max(40),
        value: z.number(),
        previous: z.number().nullable(),
      }),
    )
    .max(20),
});
export type CeoMetricsOutput = z.infer<typeof ceoMetricsOutput>;

const HREF = '/dashboard/ceo';
const number = (value: number): string => String(Math.round(value * 100) / 100);

export function ceoMetricsFacts(output: CeoMetricsOutput) {
  const days = String(output.window.days);
  const facts = CEO_KPI_KEYS.map((key) => {
    const value = output.kpis[key];
    const text =
      value.status === 'ok'
        ? `${KPI_LABELS[key]} over the last ${days} days: ${number(value.data.value)} (the period before: ${value.data.previous === null ? 'no figure' : number(value.data.previous)}; ${String(value.data.samples)} samples).`
        : value.status === 'restricted'
          ? `${KPI_LABELS[key]}: restricted for this role.`
          : `${KPI_LABELS[key]}: not available (${value.reason}).`;
    return toolFact({
      kind: 'metric',
      id: `ceo.${key}`,
      label: KPI_LABELS[key],
      text: plain(text),
      trust: 'system',
      href: HREF,
    });
  });
  for (const external of output.externalTiles) {
    facts.push(
      toolFact({
        kind: 'metric',
        id: `ceo.external.${external.key}`,
        label: external.label,
        text: plain(
          `${external.label}: ${number(external.value)} ${external.unit} (before: ${external.previous === null ? 'no figure' : number(external.previous)}). Fed from outside, not measured here.`,
        ),
        trust: 'system',
        href: HREF,
      }),
    );
  }
  return facts;
}

export function ceoMetricsTool(ctx: ModuleToolContext): ToolRegistrar {
  return (add) => {
    add(
      'ceo_metrics',
      {
        description:
          'The CEO view KPIs of the whole instance for the last N days next to the period before: volume, first response, resolution, SLA, CSAT, AI-assisted share, savings. Aggregates only.',
        input: ceoMetricsInput,
        output: ceoMetricsOutput,
        async execute(input) {
          const view = await ctx.services.ceo.read(input.days, ctx.principal);
          return {
            window: view.window,
            kpis: view.kpis,
            externalTiles: view.externalTiles.slice(0, 20).map((entry) => ({
              key: entry.key,
              label: entry.label,
              unit: entry.unit,
              value: entry.value,
              previous: entry.previous,
            })),
          };
        },
      },
      '{"days"?: 30}',
      (output) => ceoMetricsFacts(output),
    );
  };
}
