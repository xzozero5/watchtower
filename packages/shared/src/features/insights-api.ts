/**
 * `GET /v1/insights` (T-416, ADR-029 section 9.3): the request and the answer. Browser-safe, no Node imports.
 *
 * The answer never says why an element is missing (no right, no data, nothing built yet): it is just not in
 * `items`, so a client cannot tell the three apart.
 */
import { z } from 'zod';

import { claimSchema } from './claims.js';
import {
  insightFactSchema,
  insightLocaleSchema,
  insightModeSchema,
  insightStateSchema,
} from './insights.js';

/** At most this many elements in one call (section 9.3). */
export const INSIGHTS_MAX_ELEMENTS = 12;

/** Requests per person per minute `[ASSUMED]` (section 9.3). */
export const INSIGHTS_REQUESTS_PER_MINUTE = 60;

/** Distinct `(element, scope, period)` a person may mark as viewed per hour; more are read but not marked. */
export const INSIGHTS_VIEWED_MARKS_PER_HOUR = 30;

/** Facts computed live are shared for this long between callers of the same `(element, scope, period, view)`. */
export const INSIGHTS_FACTS_CACHE_SECONDS = 30;

/** Builders running at once inside one request. */
export const INSIGHTS_BUILDER_CONCURRENCY = 4;

export const insightsQuerySchema = z.object({
  elements: z
    .string()
    .max(1000)
    .transform((value) => [...new Set(value.split(',').map((part) => part.trim()))])
    .pipe(
      z
        .array(z.string().regex(/^[a-z][a-z0-9_.]{0,59}$/))
        .min(1)
        .max(INSIGHTS_MAX_ELEMENTS),
    )
    .describe(
      'Comma separated element keys, at most 12. A key the person may not read is left out.',
    ),
  scope: z
    .string()
    .max(80)
    .regex(/^(instance|user|(org|intent|incident|service):[0-9a-f-]{36})$/)
    .optional()
    .describe(
      '`instance`, `user`, or `org|intent|incident|service:<uuid>`. Left out: each element uses its own scope.',
    ),
  period: z
    .string()
    .max(60)
    .regex(/^(-|now|d\d{1,3}|shift:[0-9a-f-]{36}|w\d{4}-\d{2})$/)
    .optional()
    .describe(
      '`d{n}`, `now`, `shift:<uuid>`, `w{year}-{week}` or `-`. Left out: the default of each element.',
    ),
  locale: insightLocaleSchema.optional().describe('Language of the sentences; default `en`.'),
});
export type InsightsQuery = z.infer<typeof insightsQuerySchema>;

/** A fact as the person reads it: the sentence in their language, with person placeholders restored. */
export const insightFactViewSchema = z.object({
  id: insightFactSchema.shape.id,
  kind: insightFactSchema.shape.kind,
  value: insightFactSchema.shape.value,
  text: z.string().max(400),
});
export type InsightFactView = z.infer<typeof insightFactViewSchema>;

export const insightItemSchema = z.object({
  element: z.string(),
  /** `instance`, `user` or `org:<uuid>` and so on: the scope that was read. */
  scope: z.string(),
  period: z.string(),
  mode: insightModeSchema,
  state: insightStateSchema,
  /** The label of `state` in the requested language (`insights.state.<state>` has the same words in the web). */
  stateLabel: z.string(),
  /** Time of the data behind `facts`. */
  asOf: z.iso.datetime(),
  facts: z.array(insightFactViewSchema).max(60),
  /** The deterministic sentences made from `facts` by template, in the requested language. */
  claims: z.array(claimSchema).max(8),
  /** The stored AI narration the state allows, or null. */
  narration: z
    .object({
      id: z.uuid().optional(),
      claims: z.array(claimSchema).max(3),
      generatedAt: z.iso.datetime(),
      mock: z.boolean(),
    })
    .nullable(),
});
export type InsightItem = z.infer<typeof insightItemSchema>;

export const insightsResponseSchema = z.object({ items: z.array(insightItemSchema) });
export type InsightsResponse = z.infer<typeof insightsResponseSchema>;
