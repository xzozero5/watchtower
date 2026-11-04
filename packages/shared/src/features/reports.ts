/**
 * Reports (T-305a, T-305b, PRD sections 9.1 and 9.2): the AI cost dashboard, the CEO view with its pluggable
 * tiles, and their exports. Browser-safe (no Node imports).
 *
 * Honesty rule (N5): a KPI with nothing behind it is `{ status: 'not_available', reason }`, never a zero. A real
 * zero (no ticket arrived this week) is a number. The savings formula is an assumption of the owner's to confirm
 * and is returned with the figure, so the page can print it.
 */
import { z } from 'zod';

import { dashboardValue } from './dashboard.js';

/** Audit `action` strings written by this feature. Reads of the report itself write nothing. */
export const REPORTS_AUDIT_ACTIONS = {
  /** One data point of a pluggable CEO tile was recorded (API). */
  ceoPointRecord: 'ceo.point.record',
  /** Data points of pluggable CEO tiles were imported from CSV. */
  ceoPointImport: 'ceo.point.import',
  /** A pluggable CEO tile and all its points were removed. */
  ceoMetricDelete: 'ceo.metric.delete',
  /** The CEO view was exported (CSV or HTML). */
  ceoExport: 'ceo.export',
  /** A head edited the draft of the weekly brief (T-305c). */
  briefEdit: 'ceo.brief.edit',
  /** A head published the weekly brief and it was queued by email (T-305c). */
  briefPublish: 'ceo.brief.publish',
} as const satisfies Record<string, string>;

export const REPORTS_TICKET_EVENTS = {} as const satisfies Record<string, string>;
export const REPORTS_QUEUES = {} as const satisfies Record<string, string>;

export const REPORTS_DEFAULT_DAYS = 7;
export const REPORTS_MAX_DAYS = 90;
export const AI_COST_DEFAULT_TOP = 10;
export const AI_COST_MAX_TOP = 50;

/**
 * Automation savings, hours: AI-assisted resolved tickets x minutes a person would have spent on one / 60
 * `[ASSUMED]`. Both numbers are settings (`CEO_MINUTES_SAVED_PER_AI_TICKET`, `CEO_STAFF_COST_USD_PER_HOUR`).
 */
export const CEO_DEFAULT_MINUTES_SAVED_PER_AI_TICKET = 10;

export const CEO_EXPORT_FORMATS = ['csv', 'html'] as const;
export const CEO_METRIC_KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
export const CEO_MAX_IMPORT_ROWS = 500;
export const CEO_MAX_IMPORT_CHARS = 200_000;

const windowDays = z.coerce
  .number()
  .int()
  .min(1)
  .max(REPORTS_MAX_DAYS)
  .default(REPORTS_DEFAULT_DAYS)
  .describe('Window of the figures in whole UTC days, today included');

// --- AI cost (T-305a) ----------------------------------------------------------------------------------

export const aiCostQuerySchema = z.object({
  days: windowDays,
  top: z.coerce
    .number()
    .int()
    .min(1)
    .max(AI_COST_MAX_TOP)
    .default(AI_COST_DEFAULT_TOP)
    .describe('Rows in the per-intent and per-ticket lists'),
});
export type AiCostQuery = z.infer<typeof aiCostQuerySchema>;

const count = z.number().int().min(0);
const money = z.number().min(0);

/** What a group of model calls used. `costUsd` adds up only the priced calls; `unpricedRuns` are the others. */
export const aiCostLineSchema = z.strictObject({
  runs: count,
  inputTokens: count,
  outputTokens: count,
  costUsd: money,
  unpricedRuns: count,
});
export type AiCostLine = z.infer<typeof aiCostLineSchema>;

export const aiCostSchema = z.strictObject({
  generatedAt: z.iso.datetime(),
  window: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime(), days: count }),
  previous: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime() }),
  totals: aiCostLineSchema.extend({ tickets: count }),
  previousTotals: aiCostLineSchema.extend({ tickets: count }),
  byAgent: z.array(aiCostLineSchema.extend({ agent: z.string() })),
  /** `intent: null` is the calls that belong to no intent (a summary, the assistant, the grader). */
  byIntent: z.array(aiCostLineSchema.extend({ intent: z.string().nullable() })),
  byIntentOthers: aiCostLineSchema.nullable(),
  topTickets: z.array(
    aiCostLineSchema.extend({
      ticketId: z.uuid(),
      /** The number as people say it (`OPS-1234`). */
      key: z.string(),
      number: z.number().int(),
      orgId: z.uuid(),
    }),
  ),
  byDay: z.array(aiCostLineSchema.extend({ day: z.string() })),
});
export type AiCost = z.infer<typeof aiCostSchema>;

// --- CEO view (T-305b) -----------------------------------------------------------------------------------

export const ceoQuerySchema = z.object({ days: windowDays });
export type CeoQuery = z.infer<typeof ceoQuerySchema>;

export const ceoExportQuerySchema = ceoQuerySchema.extend({
  format: z.enum(CEO_EXPORT_FORMATS).default('csv'),
});
export type CeoExportQuery = z.infer<typeof ceoExportQuerySchema>;

/** A KPI over the window and over the same number of days right before it (the trend). */
export const ceoTileSchema = z.strictObject({
  value: z.number(),
  previous: z.number().nullable(),
  /** How many tickets (or surveys) the value rests on. */
  samples: count,
});
export type CeoTile = z.infer<typeof ceoTileSchema>;

export const CEO_KPI_KEYS = [
  'volume',
  'firstResponse',
  'resolution',
  'sla',
  'csat',
  'aiHandled',
  'verifiedResolution',
  'automationSavings',
] as const;
export type CeoKpiKey = (typeof CEO_KPI_KEYS)[number];

export const ceoFormulaSchema = z.strictObject({
  /** Always true: the numbers below are settings, not measurements. */
  assumed: z.literal(true),
  minutesPerTicket: z.number().min(0),
  staffCostUsdPerHour: z.number().min(0).nullable(),
  aiHandledTickets: count,
  noTouchTickets: count,
  hours: z.number().min(0),
  savedUsd: money.nullable(),
  aiCostUsd: money,
  /** Saved minus AI spend; null while the hourly cost is not set. */
  netUsd: z.number().nullable(),
  aiCostPerResolvedTicketUsd: money.nullable(),
  previousAiCostPerResolvedTicketUsd: money.nullable(),
});
export type CeoFormula = z.infer<typeof ceoFormulaSchema>;

export const ceoExternalTileSchema = z.strictObject({
  key: z.string(),
  label: z.string(),
  unit: z.string(),
  higherIsBetter: z.boolean(),
  value: z.number(),
  previous: z.number().nullable(),
  observedAt: z.iso.datetime(),
});
export type CeoExternalTile = z.infer<typeof ceoExternalTileSchema>;

export const ceoViewSchema = z.strictObject({
  generatedAt: z.iso.datetime(),
  window: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime(), days: count }),
  previous: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime() }),
  /** True when tickets of a seed batch are left out of every figure. */
  seedExcluded: z.boolean(),
  kpis: z.strictObject({
    volume: dashboardValue(ceoTileSchema),
    firstResponse: dashboardValue(ceoTileSchema),
    resolution: dashboardValue(ceoTileSchema),
    sla: dashboardValue(ceoTileSchema),
    csat: dashboardValue(ceoTileSchema),
    aiHandled: dashboardValue(ceoTileSchema),
    verifiedResolution: dashboardValue(ceoTileSchema),
    automationSavings: dashboardValue(ceoTileSchema),
  }),
  formula: ceoFormulaSchema,
  externalTiles: z.array(ceoExternalTileSchema),
});
export type CeoView = z.infer<typeof ceoViewSchema>;

// --- pluggable tiles ---------------------------------------------------------------------------------------

export const ceoPointSchema = z.strictObject({
  key: z.string().regex(CEO_METRIC_KEY_PATTERN),
  label: z.string().trim().min(1).max(80),
  unit: z.string().trim().max(16).default(''),
  higherIsBetter: z.boolean().default(true),
  value: z.number(),
  observedAt: z.iso.datetime(),
});
export type CeoPoint = z.infer<typeof ceoPointSchema>;

export const ceoPointsBodySchema = z.strictObject({
  points: z.array(ceoPointSchema).min(1).max(CEO_MAX_IMPORT_ROWS),
});
export type CeoPointsBody = z.infer<typeof ceoPointsBodySchema>;

export const ceoImportBodySchema = z.strictObject({
  csv: z.string().min(1).max(CEO_MAX_IMPORT_CHARS),
});
export type CeoImportBody = z.infer<typeof ceoImportBodySchema>;

export const ceoImportResultSchema = z.strictObject({ imported: count });
export type CeoImportResult = z.infer<typeof ceoImportResultSchema>;

export const ceoMetricKeyParamSchema = z.object({ key: z.string().regex(CEO_METRIC_KEY_PATTERN) });
export type CeoMetricKeyParam = z.infer<typeof ceoMetricKeyParamSchema>;

/** The CSV header an import expects (and an export of the tiles writes). */
export const CEO_IMPORT_HEADER = [
  'key',
  'label',
  'unit',
  'higher_is_better',
  'value',
  'observed_at',
] as const;
