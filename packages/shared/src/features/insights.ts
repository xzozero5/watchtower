/**
 * Embedded insights (T-414, ADR-029 section 9): the contract every screen element shares so that AI sits
 * inside the element and not only in a bubble that waits to be asked.
 *
 * What lives here, and nothing else (the facts builders are in `@watchtower/domain`, the narrator in
 * `@watchtower/ai`, the tick in the worker, `GET /v1/insights` in the api):
 *  - the element registry (`INSIGHT_ELEMENTS`): route, permission rule, scope, periods, mode, triggers;
 *  - `InsightFact`: the allow-list a narration is built from (numbers, enums, refs, names a staff member set,
 *    never free text);
 *  - the TH/EN templates that turn a deterministic claim `{templateId, params}` into a sentence at read time;
 *  - the six display states of section 9.3 / AC-J17 with their exact copy;
 *  - `numbersSubsetOfFacts`: a narration may only say numbers that its facts say (N5).
 *
 * Browser-safe (no Node imports). Reading an insight never calls a model: modes F and N both start from
 * facts computed on read; N adds a narration that the worker wrote earlier.
 */
import { z } from 'zod';

import { PERMISSIONS, type Permission } from '../rbac.js';
import { claimSchema, type Claim } from './claims.js';

export const INSIGHTS_AUDIT_ACTIONS = {
  insightGenerated: 'insight.generated',
  insightNarrationRejected: 'insight.narration_rejected',
} as const;

export const INSIGHTS_TICKET_EVENTS = {} as const;

export const INSIGHTS_QUEUES = {
  insights: 'insights',
} as const;

// --- registry ---------------------------------------------------------------------------------------------

/**
 * R = an AI already sits in the element (reuse it, N6) · F = deterministic facts and a template, no model ·
 * N = F plus a narration written ahead of time by the worker · X = no insight in stage 1.
 */
export const INSIGHT_MODES = ['F', 'N', 'R', 'X'] as const;
export const insightModeSchema = z.enum(INSIGHT_MODES);
export type InsightMode = z.infer<typeof insightModeSchema>;

export const INSIGHT_SCOPES = ['instance', 'org', 'intent', 'incident', 'service', 'user'] as const;
export const insightScopeSchema = z.enum(INSIGHT_SCOPES);
export type InsightScope = z.infer<typeof insightScopeSchema>;

/** `9a` is the pilot wave, `9b` follows it. */
export const INSIGHT_WAVES = ['9a', '9b'] as const;

/** `none`: no person in the facts · `others`: other staff members appear (section 9.9) · `self`: only the viewer. */
export const INSIGHT_PERSON_REFS = ['none', 'others', 'self'] as const;

/** Events the worker's processors report with `markInsightDirty` (a Redis mark, O(1)). */
export const INSIGHT_EVENT_KINDS = [
  'ticket',
  'alert',
  'incident',
  'shift',
  'handoff',
  'grade',
  'autonomy',
  'sla',
  'ai_run',
  'outbox',
  'queue',
  'integration',
  'usage',
  'status_page',
] as const;
export const insightEventKindSchema = z.enum(INSIGHT_EVENT_KINDS);
export type InsightEventKind = z.infer<typeof insightEventKindSchema>;

const permissionKeys = Object.keys(PERMISSIONS) as [Permission, ...Permission[]];
const permissionKeySchema = z.enum(permissionKeys);

/**
 * The element is shown to a person only when the GET route behind it lets that person in. The same
 * `all`/`anyOf` shape the route's decorator has; the parity test (T-416) compares the two.
 */
export const insightRuleSchema = z.union([
  z.object({ all: z.array(permissionKeySchema).min(1) }).strict(),
  z.object({ anyOf: z.array(permissionKeySchema).min(1) }).strict(),
]);
export type InsightRule = z.infer<typeof insightRuleSchema>;

/** The shapes of `period` an element accepts, so a client cannot ask for a period nobody built (C-11). */
export const insightPeriodSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('now') }),
  z.object({
    kind: z.literal('days'),
    min: z.number().int().min(1),
    max: z.number().int().min(1).max(366),
  }),
  z.object({ kind: z.literal('shift') }),
  z.object({ kind: z.literal('isoWeek'), maxWeeksBack: z.number().int().min(1).max(52) }),
]);
export type InsightPeriodSpec = z.infer<typeof insightPeriodSpecSchema>;

/** When a change is worth a new narration (section 9.4). Counts: both bounds; percentages: steps of `percentStepPp`. */
export const insightMaterialitySchema = z.object({
  minChangePercent: z.number().min(0).max(100),
  minChangeAbsolute: z.number().int().min(0),
  percentStepPp: z.number().int().min(1).max(50),
  topDrivers: z.number().int().min(0).max(3),
});
export type InsightMateriality = z.infer<typeof insightMaterialitySchema>;

/** `[ASSUMED]` section 9.4: a count must change by 10% and by 3; a percentage moves in steps of 5 points. */
export const DEFAULT_INSIGHT_MATERIALITY: InsightMateriality = {
  minChangePercent: 10,
  minChangeAbsolute: 3,
  percentStepPp: 5,
  topDrivers: 3,
};

export const INSIGHT_ELEMENT_KEYS = [
  'home.my_work',
  'home.volume',
  'home.team',
  'home.status',
  'dashboard.ops.now',
  'dashboard.ops.volume',
  'dashboard.ops.sla',
  'dashboard.ops.reliability',
  'dashboard.ops.services',
  'dashboard.ops.quality',
  'dashboard.ops.ai',
  'dashboard.ops.grades',
  'dashboard.ops.team',
  'dashboard.ops.usage',
  'reports.ai_cost',
  'reports.ceo.figures',
  'reports.ceo.brief',
  'shift.brief',
  'shift.handoff',
  'shift.overview',
  'shift.notes',
  'queue.list',
  'ticket.workspace',
  'conversation.pane',
  'incidents.open',
  'incident.detail',
  'alerts.noise',
  'alerts.services',
  'statuspage.admin',
  'org.health',
  'admin.intents',
  'admin.intent.gate',
  'admin.ai',
  'admin.integrations',
  'admin.outbox',
  'admin.queues',
  'roster.planner',
  'kb',
  'admin.users',
  'admin.audit',
  'admin.golden',
  'admin.sla',
  'admin.rbac',
] as const;
export const insightElementKeySchema = z.enum(INSIGHT_ELEMENT_KEYS);
export type InsightElementKey = z.infer<typeof insightElementKeySchema>;

export const insightElementSchema = z
  .object({
    /** `GET /v1/...` the element's figures already come from; null where the element has no route of its own. */
    route: z
      .string()
      .regex(/^GET \/v1\//)
      .nullable(),
    /** Null only for mode X (nothing is shown, so nothing is checked). */
    rule: insightRuleSchema.nullable(),
    scope: insightScopeSchema,
    periods: z.array(insightPeriodSpecSchema),
    mode: insightModeSchema,
    /** True exactly when the element is not X: it always has the "Ask AI about this" button (section 9.6). */
    askAi: z.boolean(),
    wave: z.enum(INSIGHT_WAVES).nullable(),
    personRefs: z.enum(INSIGHT_PERSON_REFS),
    /** `pii.read` kind written when the element is read (only elements that show people). */
    piiKind: z.string().min(1).optional(),
    triggers: z.array(insightEventKindSchema),
    /** Backup refresh for what changes with time alone (SLA ageing). Null: events only. */
    cadenceMinutes: z.number().int().min(5).nullable(),
    materiality: insightMaterialitySchema,
    /** This element reuses another element's facts and insight (`home.team` is `shift.overview`). */
    aliasOf: insightElementKeySchema.optional(),
    /** Only facts and a template, whatever the mode of its neighbours: admin pages must not nudge a stage (N3). */
    adminFactsOnly: z.boolean().optional(),
    /** `[UNVERIFIED]` points of the row the owning task has to settle; carried so the registry does not claim more. */
    unverified: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((element, ctx) => {
    if (element.askAi !== (element.mode !== 'X')) {
      ctx.addIssue({
        code: 'custom',
        path: ['askAi'],
        message: 'askAi must be true exactly when the mode is not X',
      });
    }
    if (element.mode !== 'X' && element.rule === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['rule'],
        message: 'an element that is shown needs a permission rule',
      });
    }
    if (element.mode === 'X' && element.wave !== null) {
      ctx.addIssue({ code: 'custom', path: ['wave'], message: 'an X element has no wave' });
    }
    if (element.personRefs === 'others' && element.piiKind === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['piiKind'],
        message: 'showing other people writes pii.read',
      });
    }
    if (element.adminFactsOnly === true && element.mode !== 'F') {
      ctx.addIssue({ code: 'custom', path: ['mode'], message: 'an admin element is F only (N3)' });
    }
  });
export type InsightElement = z.infer<typeof insightElementSchema>;

const DAYS_90: InsightPeriodSpec = { kind: 'days', min: 1, max: 90 };
const NOW: InsightPeriodSpec = { kind: 'now' };
const NO_PERIOD: InsightPeriodSpec = { kind: 'none' };

type ElementInit = Partial<InsightElement> & Pick<InsightElement, 'rule' | 'scope' | 'mode'>;

/** Fills the fields most rows share. `askAi` follows the mode, so a row cannot forget the button. */
function element(init: ElementInit): InsightElement {
  const mode = init.mode;
  return {
    route: null,
    periods: [NO_PERIOD],
    askAi: mode !== 'X',
    wave: null,
    personRefs: 'none',
    triggers: [],
    cadenceMinutes: null,
    materiality: DEFAULT_INSIGHT_MATERIALITY,
    ...init,
  };
}

const DASH_RULE: InsightRule = { all: ['dashboard.ops.read'] };
const dashboard = (init: Partial<InsightElement>): InsightElement =>
  element({
    route: 'GET /v1/dashboard/ops',
    rule: DASH_RULE,
    scope: 'instance',
    mode: 'N',
    periods: [DAYS_90],
    wave: '9b',
    ...init,
  });

/**
 * An admin page reads a GET route that only asks for `ticket.read` and gates itself by role in the web. The element
 * asks the route's permission AND the page's `*.manage`, so it is never wider than the route and never opens for a
 * person who holds the page permission alone (T-416).
 */
const adminFacts = (
  route: string,
  rule: InsightRule,
  scope: InsightScope = 'instance',
): InsightElement =>
  element({
    route,
    rule,
    scope,
    mode: 'F',
    wave: '9b',
    adminFactsOnly: true,
    triggers: ['integration'],
  });

const X_ELEMENT: InsightElement = element({ rule: null, scope: 'instance', mode: 'X' });

/**
 * Every element of ADR-029 section 9.1. The `rule` is the rule of the GET route behind the element, not a new
 * one: an insight is shown to a person exactly when that route would show them the same scope. Rows whose
 * route or rule the ADR marks `[UNVERIFIED]` say so in `unverified`; the parity test of T-416 settles them.
 */
export const INSIGHT_ELEMENTS: Readonly<Record<InsightElementKey, InsightElement>> = {
  // T-416: the Home cards read `GET /v1/tickets/stats` (assignee=me), which asks for `ticket.read` alone and refuses
  // the masked developer. An insight shows no number the route would not, so the rule is the route's and a `dev`
  // gets no `home.my_work` (this narrows ADR-029 section 9.3, which would have given a dev a masked view).
  'home.my_work': element({
    route: 'GET /v1/tickets/stats',
    rule: { all: ['ticket.read'] },
    scope: 'user',
    // F on read in 9a, N through `ai_summary` kind `my_work` in 9b.
    mode: 'F',
    wave: '9a',
    personRefs: 'self',
    triggers: ['ticket', 'sla'],
    cadenceMinutes: 60,
  }),
  'home.volume': element({
    // T-416: the card reads `GET /v1/dashboard/ops`, so its rule is that route's `dashboard.ops.read`.
    route: 'GET /v1/dashboard/ops',
    rule: DASH_RULE,
    scope: 'instance',
    mode: 'N',
    periods: [DAYS_90],
    wave: '9b',
    triggers: ['ticket'],
    cadenceMinutes: 60,
    unverified: ['scope instance (60%)'],
  }),
  'home.team': element({
    route: 'GET /v1/shifts/overview',
    rule: { anyOf: ['roster.manage', 'performance.read.all'] },
    scope: 'instance',
    mode: 'N',
    wave: '9a',
    personRefs: 'others',
    piiKind: 'shift_overview',
    triggers: ['shift', 'ticket', 'sla'],
    cadenceMinutes: 60,
    aliasOf: 'shift.overview',
  }),
  // T-416: the AI status card of Home reads `GET /v1/autonomy` (`ticket.read`); readiness is the public health
  // probe and adds no data of its own. It was filed under the dashboard route by mistake.
  'home.status': element({
    route: 'GET /v1/autonomy',
    rule: { all: ['ticket.read'] },
    scope: 'instance',
    mode: 'F',
    wave: '9b',
    triggers: ['autonomy'],
  }),
  'dashboard.ops.now': dashboard({
    periods: [NOW],
    triggers: ['ticket', 'alert', 'incident'],
    cadenceMinutes: 30,
  }),
  'dashboard.ops.volume': dashboard({ wave: '9a', triggers: ['ticket'], cadenceMinutes: 60 }),
  'dashboard.ops.sla': dashboard({ wave: '9a', triggers: ['ticket', 'sla'], cadenceMinutes: 60 }),
  'dashboard.ops.reliability': dashboard({ triggers: ['incident', 'alert'], cadenceMinutes: 120 }),
  'dashboard.ops.services': dashboard({ triggers: ['alert', 'incident'], cadenceMinutes: 120 }),
  'dashboard.ops.quality': dashboard({
    rule: { all: ['dashboard.ops.read', 'csat.read'] },
    triggers: ['ticket'],
    cadenceMinutes: 240,
  }),
  'dashboard.ops.ai': dashboard({
    rule: { all: ['dashboard.ops.read', 'ai.run.read'] },
    mode: 'F',
    triggers: ['ai_run'],
  }),
  'dashboard.ops.grades': dashboard({
    rule: { all: ['dashboard.ops.read', 'ai.run.read'] },
    mode: 'F',
    triggers: ['grade'],
  }),
  'dashboard.ops.team': dashboard({
    rule: { all: ['dashboard.ops.read', 'performance.read.all'] },
    personRefs: 'others',
    piiKind: 'performance',
    triggers: ['ticket', 'shift'],
    cadenceMinutes: 120,
  }),
  'dashboard.ops.usage': dashboard({
    rule: { all: ['dashboard.ops.read', 'metric.read'] },
    triggers: ['usage'],
    cadenceMinutes: 240,
  }),
  'reports.ai_cost': element({
    route: 'GET /v1/reports/ai-cost',
    rule: { all: ['ai.run.read'] },
    scope: 'instance',
    mode: 'N',
    periods: [DAYS_90],
    wave: '9b',
    triggers: ['ai_run'],
    cadenceMinutes: 240,
    unverified: ['route path'],
  }),
  'reports.ceo.figures': element({
    route: 'GET /v1/reports/ceo',
    rule: { all: ['ceo.view'] },
    scope: 'instance',
    mode: 'F',
    periods: [{ kind: 'isoWeek', maxWeeksBack: 26 }],
    wave: '9b',
    triggers: ['ticket', 'incident'],
    unverified: ['route path'],
  }),
  'reports.ceo.brief': element({
    route: 'GET /v1/reports/ceo/brief',
    rule: { all: ['ceo.view'] },
    scope: 'instance',
    mode: 'R',
    periods: [{ kind: 'isoWeek', maxWeeksBack: 26 }],
  }),
  'shift.brief': element({
    route: 'GET /v1/shifts/brief',
    rule: { all: ['shift.clock'] },
    scope: 'user',
    mode: 'R',
    unverified: ['route path'],
  }),
  'shift.handoff': element({
    route: 'GET /v1/handoffs/current',
    rule: { all: ['handoff.write'] },
    scope: 'user',
    mode: 'R',
  }),
  'shift.overview': element({
    route: 'GET /v1/shifts/overview',
    rule: { anyOf: ['roster.manage', 'performance.read.all'] },
    scope: 'instance',
    mode: 'N',
    periods: [NOW],
    wave: '9a',
    personRefs: 'others',
    piiKind: 'shift_overview',
    triggers: ['shift', 'ticket', 'sla'],
    cadenceMinutes: 60,
  }),
  'shift.notes': { ...X_ELEMENT },
  'queue.list': element({
    route: 'GET /v1/tickets',
    rule: { anyOf: ['ticket.read', 'ticket.read.masked'] },
    scope: 'user',
    mode: 'F',
    wave: '9b',
  }),
  'ticket.workspace': element({
    route: 'GET /v1/tickets',
    rule: { anyOf: ['ticket.read', 'ticket.read.masked'] },
    scope: 'instance',
    mode: 'R',
  }),
  'conversation.pane': element({
    route: 'GET /v1/inbound/other-mail',
    rule: { all: ['inbound.read'] },
    scope: 'instance',
    mode: 'R',
  }),
  'incidents.open': element({
    route: 'GET /v1/incidents',
    rule: { all: ['ticket.read'] },
    scope: 'instance',
    mode: 'N',
    periods: [NOW],
    wave: '9a',
    triggers: ['incident', 'alert'],
    cadenceMinutes: 30,
  }),
  'incident.detail': element({
    route: 'GET /v1/incidents/:id',
    rule: { all: ['ticket.read'] },
    scope: 'incident',
    mode: 'N',
    periods: [NOW],
    wave: '9b',
    triggers: ['incident', 'alert'],
    unverified: ['comms panel already has AI'],
  }),
  'alerts.noise': element({
    route: 'GET /v1/alerts/noise',
    rule: { all: ['alert.read'] },
    scope: 'instance',
    mode: 'N',
    periods: [DAYS_90],
    wave: '9a',
    triggers: ['alert'],
    cadenceMinutes: 60,
  }),
  'alerts.services': element({
    route: 'GET /v1/services',
    rule: { all: ['alert.read'] },
    scope: 'instance',
    mode: 'F',
    wave: '9b',
    triggers: ['alert'],
  }),
  'statuspage.admin': element({
    route: 'GET /v1/status-page/components',
    rule: { all: ['ticket.read'] },
    scope: 'instance',
    mode: 'F',
    wave: '9b',
    adminFactsOnly: true,
    triggers: ['status_page', 'incident'],
    unverified: ['rule follows the GET of each status page admin screen'],
  }),
  'org.health': element({
    route: 'GET /v1/orgs/:id/health',
    rule: { all: ['org.health.read'] },
    scope: 'org',
    mode: 'N',
    periods: [DAYS_90],
    wave: '9b',
    triggers: ['ticket', 'incident'],
    unverified: ['route path'],
  }),
  'admin.intents': adminFacts(
    'GET /v1/intents',
    { all: ['ticket.read', 'intent.manage'] },
    'intent',
  ),
  'admin.intent.gate': adminFacts(
    'GET /v1/intents',
    { all: ['ticket.read', 'intent.manage'] },
    'intent',
  ),
  'admin.ai': adminFacts('GET /v1/ai/status', { all: ['ticket.read', 'ai.provider.manage'] }),
  'admin.integrations': adminFacts('GET /v1/admin/integrations', { all: ['integration.manage'] }),
  'admin.outbox': adminFacts('GET /v1/ops/outbox', { all: ['outbox.manage'] }),
  'admin.queues': adminFacts('GET /v1/queues', { all: ['ticket.read', 'queue.manage'] }),
  'roster.planner': element({
    route: 'GET /v1/roster/plans',
    rule: { all: ['roster.manage'] },
    scope: 'instance',
    mode: 'R',
  }),
  kb: { ...X_ELEMENT },
  'admin.users': { ...X_ELEMENT },
  'admin.audit': { ...X_ELEMENT },
  'admin.golden': { ...X_ELEMENT },
  'admin.sla': { ...X_ELEMENT },
  'admin.rbac': { ...X_ELEMENT },
};

/** Elements the worker narrates (mode N): the ones the tick and the budget gate care about. */
export const NARRATED_INSIGHT_ELEMENTS: readonly InsightElementKey[] = INSIGHT_ELEMENT_KEYS.filter(
  (key) => INSIGHT_ELEMENTS[key].mode === 'N' && INSIGHT_ELEMENTS[key].aliasOf === undefined,
);

/** True when the registry has an element of this name (a client may send anything). */
export function isInsightElementKey(value: string): value is InsightElementKey {
  return (INSIGHT_ELEMENT_KEYS as readonly string[]).includes(value);
}

// --- period -----------------------------------------------------------------------------------------------

const ISO_WEEK = /^w(\d{4})-(\d{2})$/;

/** Monday of ISO week `week` of `year` as a UTC timestamp. */
function isoWeekStart(year: number, week: number): number {
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Day = (new Date(jan4).getUTCDay() + 6) % 7;
  return jan4 - jan4Day * 86_400_000 + (week - 1) * 7 * 86_400_000;
}

/**
 * Whether `period` has a shape the element accepts: `d{n}` inside the range, `now`, `shift:<uuid>`,
 * `w{year}-{week}` not in the future and not older than `maxWeeksBack`, or `-` where there is no period.
 * Whether a `shift:<uuid>` exists is checked by the reader that has the database.
 */
export function isInsightPeriodAllowed(
  specs: readonly InsightPeriodSpec[],
  period: string,
  now: Date = new Date(),
): boolean {
  return specs.some((spec) => {
    switch (spec.kind) {
      case 'none':
        return period === '-';
      case 'now':
        return period === 'now';
      case 'days': {
        const match = /^d([1-9]\d{0,2})$/.exec(period);
        if (match?.[1] === undefined) return false;
        const days = Number(match[1]);
        return days >= spec.min && days <= spec.max;
      }
      case 'shift':
        return (
          z.uuid().safeParse(period.replace(/^shift:/, '')).success && period.startsWith('shift:')
        );
      case 'isoWeek': {
        const match = ISO_WEEK.exec(period);
        if (match?.[1] === undefined || match[2] === undefined) return false;
        const week = Number(match[2]);
        if (week < 1 || week > 53) return false;
        const start = isoWeekStart(Number(match[1]), week);
        const age = now.getTime() - start;
        return age >= 0 && age <= spec.maxWeeksBack * 7 * 86_400_000 + 7 * 86_400_000;
      }
    }
  });
}

// --- facts ------------------------------------------------------------------------------------------------

export const INSIGHT_REF_KINDS = [
  'user',
  'org',
  'contact',
  'intent',
  'service',
  'queue',
  'incident',
  'ticket',
  'alert',
  'shift',
] as const;
export const insightRefKindSchema = z.enum(INSIGHT_REF_KINDS);
export type InsightRefKind = z.infer<typeof insightRefKindSchema>;

export const insightRefSchema = z.object({
  kind: insightRefKindSchema,
  id: z.string().min(1).max(100),
});
export type InsightRef = z.infer<typeof insightRefSchema>;

/** Ref kinds a `masked` view (the `dev` role) must not carry: they name a customer. */
export const INSIGHT_MASKED_REF_KINDS: readonly InsightRefKind[] = ['org', 'contact'];

/**
 * One allow-listed fact. A number, an enum, a reference, or a name a staff member set (intent, service,
 * queue, organization). There is no field for free text (a subject, a body, a note, an alert message), so
 * none can reach a model through a fact (injection, N4). `display` is how the fact reads in each language.
 */
export const insightFactSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  kind: z.enum(['metric', 'delta', 'driver', 'state']),
  value: z.union([z.number(), z.string().min(1).max(40)]),
  display: z.object({ th: z.string().min(1).max(200), en: z.string().min(1).max(200) }),
  ref: insightRefSchema.optional(),
});
export type InsightFact = z.infer<typeof insightFactSchema>;

/** What a facts builder returns: the facts and the time of the data behind them. */
export const insightFactsResultSchema = z.object({
  facts: z.array(insightFactSchema).max(60),
  asOf: z.iso.datetime(),
});
export type InsightFactsResult = z.infer<typeof insightFactsResultSchema>;

// --- claims -----------------------------------------------------------------------------------------------

/** Evidence as stored (not yet restored for a viewer): the fact it comes from and the thing it points at. */
export const insightStoredEvidenceSchema = z.union([
  z.object({
    kind: insightRefKindSchema,
    id: z.string().min(1).max(100),
    factId: insightFactSchema.shape.id,
  }),
  // A metric can have provenance without identifying an entity. Never invent an id or URL.
  z.object({ kind: z.literal('aggregate'), factId: insightFactSchema.shape.id }).strict(),
]);
export type InsightStoredEvidence = z.infer<typeof insightStoredEvidenceSchema>;

/**
 * A narrated claim as the worker stores it: redacted text with placeholders bound to refs, and evidence
 * that is a fact id. At read time the api turns it into a `Claim` (labels and links restored with the
 * viewer's own permissions). At least one piece of evidence: an uncited narration is dropped (section 9.5).
 */
export const insightStoredClaimSchema = z.object({
  text: z.string().min(1).max(600),
  evidence: z.array(insightStoredEvidenceSchema).min(1).max(8),
});
export type InsightStoredClaim = z.infer<typeof insightStoredClaimSchema>;

/** At most three claims a narration, section 9.2. */
export const insightStoredClaimsSchema = z.array(insightStoredClaimSchema).min(1).max(3);

/** A deterministic (mode F) claim: a template and its parameters, rendered at read time in the viewer's language. */
export const insightTemplateClaimSchema = z.object({
  templateId: z.string().min(1).max(60),
  params: z.record(z.string(), z.union([z.string().max(120), z.number()])),
  evidence: z.array(insightStoredEvidenceSchema).max(8),
});
export type InsightTemplateClaim = z.infer<typeof insightTemplateClaimSchema>;

// --- templates --------------------------------------------------------------------------------------------

export type InsightLocale = 'th' | 'en';
export const insightLocaleSchema = z.enum(['th', 'en']);

/** `{name}` is replaced by the parameter of that name. Never free text: only numbers and names a staff member set. */
export const INSIGHT_TEMPLATES = {
  /** `{label}` moved by `{percent}`% against the 7-day average. */
  delta_up: {
    th: '{label} เพิ่มขึ้น {percent}% จากค่าเฉลี่ย 7 วัน',
    en: '{label} is up {percent}% on the 7-day average',
  },
  delta_down: {
    th: '{label} ลดลง {percent}% จากค่าเฉลี่ย 7 วัน',
    en: '{label} is down {percent}% on the 7-day average',
  },
  delta_flat: {
    th: '{label} ใกล้เคียงค่าเฉลี่ย 7 วัน',
    en: '{label} is in line with the 7-day average',
  },
  top_driver: {
    th: 'ส่วนใหญ่มาจาก {name} ({count} รายการ)',
    en: 'Mostly from {name} ({count} items)',
  },
  count_in_view: {
    th: '{count} รายการในมุมมองนี้ใกล้ผิด SLA',
    en: '{count} items in this view are close to breaching SLA',
  },
  open_count: {
    th: 'เปิดอยู่ {count} รายการ',
    en: '{count} open',
  },
  sla_at_risk: {
    th: '{count} รายการใกล้ผิด SLA',
    en: '{count} items close to breaching SLA',
  },
  my_work_open: {
    th: 'คุณถืออยู่ {count} รายการ',
    en: 'You hold {count} items',
  },
  my_work_sla_risk: {
    th: 'ใน {total} รายการที่คุณถือ มี {count} รายการใกล้ผิด SLA',
    en: 'Of the {total} items you hold, {count} are close to breaching SLA',
  },
  noise_share: {
    th: '{percent}% ของ alert ใน {days} วันนี้ถูกจัดกลุ่มหรือปิดเอง',
    en: '{percent}% of alerts in the last {days} days were grouped or closed automatically',
  },
  incidents_open: {
    th: 'ตอนนี้มี incident เปิดอยู่ {count} รายการ',
    en: '{count} incidents are open right now',
  },
  no_change: {
    th: 'ไม่มีการเปลี่ยนแปลงที่ต้องรายงาน',
    en: 'Nothing has changed that needs reporting',
  },
  // --- Wave 9b Mode F templates (T-420) ---
  home_status: {
    th: '{active} intent ใช้งานอยู่ ({stage3} อยู่ stage 3), kill switch {killSwitch}',
    en: '{active} active intents ({stage3} at stage 3), kill switch is {killSwitch}',
  },
  queue_summary: {
    th: 'คุณถืออยู่ {myOpen} รายการ ({myRisk} เสี่ยงผิด SLA), ค้างที่ยังไม่มอบหมาย {unassigned} รายการ',
    en: 'You hold {myOpen} open tickets ({myRisk} at risk), {unassigned} unassigned tickets open',
  },
  ai_ops_summary: {
    th: 'AI ทำงาน {runs} ครั้ง ({cost} USD), พบข้อผิดพลาด {errors} ครั้ง',
    en: '{runs} AI runs (${cost} USD), {errors} errors',
  },
  ai_grades_summary: {
    th: 'ตรวจแล้ว {graded} รายการ, ยืนยันถูกต้อง {verifiedPct}%, พบ violation {violations} ครั้ง',
    en: '{graded} tickets graded, {verifiedPct}% verified, {violations} violations',
  },
  ceo_figures_summary: {
    th: 'Ticket ทั้งหมด {tickets} รายการ (ปิดแล้ว {resolved} รายการ), {incidents} incidents ในสัปดาห์ {week}',
    en: '{tickets} tickets ({resolved} resolved), {incidents} incidents in week {week}',
  },
  alerts_services_summary: {
    th: 'ตรวจสอบ {activeServices} บริการ, มี alert เปิดอยู่ {servicesWithAlerts} บริการ',
    en: '{activeServices} services monitored, {servicesWithAlerts} have open alerts',
  },
  statuspage_summary: {
    th: '{total} คอมโพเนนต์ ({degraded} มีปัญหา), ประกาศ incident ที่ยังไม่ปิด {activePosts} รายการ',
    en: '{total} components ({degraded} degraded), {activePosts} active incident posts',
  },
  admin_intents_summary: {
    th: 'Intent อยู่ stage {stage}, มี ticket {tickets28d} รายการ ใน 28 วันล่าสุด',
    en: 'Intent at stage {stage}, {tickets28d} tickets in last 28 days',
  },
  admin_gate_summary: {
    th: 'รายงาน Gate ล่าสุด: {status} (ผ่าน {passCount} ข้อ, ไม่ผ่าน {failCount} ข้อ)',
    en: 'Latest gate report: {status} ({passCount} passed, {failCount} failed)',
  },
  admin_ai_summary: {
    th: 'Kill switch {killSwitch}, การใช้งานวันนี้: {tokens} tokens (${cost} USD)',
    en: 'Kill switch is {killSwitch}, today: {tokens} tokens (${cost} USD)',
  },
  admin_integrations_summary: {
    th: 'Integration ใช้งานอยู่ {active} รายการ, ปกติ {healthy} รายการ, พบข้อผิดพลาด {errors} รายการ',
    en: '{active} active integrations, {healthy} healthy, {errors} with errors',
  },
  admin_outbox_summary: {
    th: 'Outbox รอดำเนินการ {pending} รายการ, ล้มเหลว {failed} รายการ',
    en: '{pending} pending outbox jobs, {failed} failed or dead-lettered',
  },
  admin_queues_summary: {
    th: 'Outbox รอดำเนินการ {outboxPending} รายการ, Outbound รอส่ง {outboundScheduled} รายการ',
    en: '{outboxPending} outbox pending, {outboundScheduled} outbound scheduled',
  },
} as const satisfies Record<string, Record<InsightLocale, string>>;
export type InsightTemplateId = keyof typeof INSIGHT_TEMPLATES;

export function isInsightTemplateId(value: string): value is InsightTemplateId {
  return Object.hasOwn(INSIGHT_TEMPLATES, value);
}

/** A number the way both languages print it: Arabic digits, `,` for thousands, at most one decimal. */
export function formatInsightNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
}

/**
 * Renders a template in one language. Throws when a parameter is missing, so a builder that forgets one is a
 * test failure and not a sentence with a hole in it. The result is one language only (no mixed sentences).
 */
export function renderInsightTemplate(
  templateId: InsightTemplateId,
  params: Readonly<Record<string, string | number>>,
  locale: InsightLocale,
): string {
  return INSIGHT_TEMPLATES[templateId][locale].replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`insight template "${templateId}" needs the parameter "${name}"`);
    }
    return typeof value === 'number' ? formatInsightNumber(value) : value;
  });
}

/** Parameter names a template uses, so a builder test can check that it supplies them. */
export function insightTemplateParams(templateId: InsightTemplateId): string[] {
  const names = new Set<string>();
  for (const locale of ['th', 'en'] as const) {
    for (const match of INSIGHT_TEMPLATES[templateId][locale].matchAll(/\{(\w+)\}/g)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return [...names];
}

/** Turns a template claim into the `Claim` the web shows. Evidence labels are filled in by the api (permissions). */
export function renderInsightTemplateClaim(
  claim: InsightTemplateClaim,
  locale: InsightLocale,
  evidence: Claim['evidence'] = [],
): Claim | null {
  if (!isInsightTemplateId(claim.templateId)) return null;
  const parsed = claimSchema.safeParse({
    text: renderInsightTemplate(claim.templateId, claim.params, locale),
    evidence,
    uncited: evidence.length === 0,
  });
  return parsed.success ? parsed.data : null;
}

// --- states -----------------------------------------------------------------------------------------------

/** AC-J17: six states that never merge and never mix TH and EN in one sentence. Order = order of checking. */
export const INSIGHT_STATES = ['system', 'paused', 'fresh', 'stale', 'budget', 'none'] as const;
export const insightStateSchema = z.enum(INSIGHT_STATES);
export type InsightState = z.infer<typeof insightStateSchema>;

/** The exact copy of section 9.3. `fresh` has `{n}` and a unit; use `insightStateLabel` for it. */
export const INSIGHT_STATE_COPY = {
  system: { th: 'จากระบบ', en: 'From system' },
  paused: {
    th: 'AI หยุดทำงาน — แสดงข้อมูลตรงจากระบบ',
    en: 'AI paused — showing system data',
  },
  fresh: { th: 'AI · {n} {unit}ที่แล้ว', en: 'AI · {n}{unit} ago' },
  stale: { th: 'สรุปก่อนข้อมูลล่าสุด', en: 'Summary predates latest data' },
  budget: {
    th: 'สรุป AI พักชั่วคราว (ครบงบวันนี้)',
    en: 'AI summaries paused (daily budget reached)',
  },
  none: {
    th: 'ยังไม่มีสรุป AI ล่าสุด — แสดงข้อมูลจากระบบ',
    en: 'No current AI summary — showing system data',
  },
} as const satisfies Record<InsightState, Record<InsightLocale, string>>;

/** i18n key of the web for a state: `insights.state.<state>`. */
export const insightStateKey = (state: InsightState): string => `insights.state.${state}`;

export interface InsightStateInput {
  mode: InsightMode;
  /** The viewer is `dev` and no stored claim survives the masked view (section 9.3). */
  maskedNoClaims?: boolean;
  /** Kill switch on, `insight_narrator` off in policy, or the provider offline. */
  paused: boolean;
  /** The stored narration for this viewer's language, if any. */
  narration: { expiresAt: Date; fingerprintMatches: boolean } | null;
  /** The insights budget gate is open (a new narration may be made). */
  budgetOpen: boolean;
  now: Date;
}

/** Picks the state in the order of section 9.3. */
export function selectInsightState(input: InsightStateInput): InsightState {
  if (input.mode !== 'N' || input.maskedNoClaims === true) return 'system';
  if (input.paused) return 'paused';
  const usable =
    input.narration !== null && input.narration.expiresAt.getTime() > input.now.getTime();
  if (usable && input.narration?.fingerprintMatches === true) return 'fresh';
  if (usable) return 'stale';
  return input.budgetOpen ? 'none' : 'budget';
}

/**
 * The label for a state in one language. `fresh` counts minutes under an hour and hours after that
 * (`AI · 5 นาทีที่แล้ว`, `AI · 2h ago`). A `fresh` state without a time reads as 1 minute.
 */
export function insightStateLabel(
  state: InsightState,
  locale: InsightLocale,
  generatedAt?: Date,
  now: Date = new Date(),
): string {
  if (state !== 'fresh') return INSIGHT_STATE_COPY[state][locale];
  const minutes =
    generatedAt === undefined
      ? 1
      : Math.max(1, Math.floor((now.getTime() - generatedAt.getTime()) / 60_000));
  const hours = minutes >= 60;
  const n = hours ? Math.floor(minutes / 60) : minutes;
  const unit = locale === 'th' ? (hours ? 'ชม.' : 'นาที') : hours ? 'h' : 'm';
  return INSIGHT_STATE_COPY.fresh[locale].replace('{n}', String(n)).replace('{unit}', unit);
}

// --- numbers (N5) -----------------------------------------------------------------------------------------

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
const NUMBER_PATTERN = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

function arabicDigits(text: string): string {
  return text.replace(/[๐-๙]/g, (digit) => String(THAI_DIGITS.indexOf(digit)));
}

/**
 * Every number in `text`, normalized: Thai digits become Arabic, `1,234.50` becomes `1234.5`, the `%` and the
 * time unit (`15 นาที`, `2h`, `3 ชม.`) are not part of the number, the sign is dropped (a fall of 18% and
 * "18%" are the same figure). `1,2` is two numbers; a comma followed by exactly three digits is a thousand.
 */
export function extractInsightNumbers(text: string): string[] {
  const out: string[] = [];
  for (const match of arabicDigits(text).matchAll(NUMBER_PATTERN)) {
    out.push(String(Number(match[0].replaceAll(',', ''))));
  }
  return out;
}

export interface NumbersCheck {
  ok: boolean;
  /** Numbers in the text that no fact has, normalized. */
  unmatched: string[];
}

/**
 * The numbers of a narrated sentence must come from the facts it cites (section 9.5): every number in `text`
 * must be the `value` or appear in a `display` (either language) of one of `facts`. Numbers are compared as
 * numbers, so `๑,๒๓๔` and `1234` match. No facts and a number in the text: not ok. No number in the text: ok.
 */
export function numbersSubsetOfFacts(text: string, facts: readonly InsightFact[]): NumbersCheck {
  const allowed = new Set<string>();
  for (const fact of facts) {
    if (typeof fact.value === 'number') allowed.add(String(Math.abs(fact.value)));
    else for (const n of extractInsightNumbers(fact.value)) allowed.add(n);
    for (const n of extractInsightNumbers(fact.display.th)) allowed.add(n);
    for (const n of extractInsightNumbers(fact.display.en)) allowed.add(n);
  }
  const unmatched = [...new Set(extractInsightNumbers(text))].filter((n) => !allowed.has(n));
  return { ok: unmatched.length === 0, unmatched };
}
